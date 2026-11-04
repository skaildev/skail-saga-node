import { randomUUID } from "node:crypto";
import fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type {
  ChargeRequest,
  InvoiceRequest,
  NewOrder,
  NotifyCustomerRequest,
  RecordResultRequest,
  ReserveRequest,
  StateView,
} from "@skail-saga/contracts";
import { SkailGatewayError, type SkailGateway } from "./gateway.js";
import type { SagaStore } from "./saga-store.js";

export interface AppOptions {
  store: SagaStore;
  gateway: SkailGateway;
  /** Directory with the built front end (index.html + assets). Optional: tests do not need it. */
  staticDir?: string;
  /** Request log (the main entry point turns it on; tests keep it quiet). */
  logger?: boolean;
}

const blank = (value: unknown) => typeof value !== "string" || value.trim() === "";
const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;

export function createApp({ store, gateway, staticDir, logger = false }: AppOptions): FastifyInstance {
  const app = fastify({ bodyLimit: 1024 * 1024, logger });

  app.get("/healthz", async () => "ok");

  // Places an order: the page (or a curl) calls this, and the web app starts CloseOrder in skail. The card stays here.
  app.post<{ Body: Partial<NewOrder> | null }>("/api/orders", async (request, reply) => {
    const body = request.body;
    if (
      !body ||
      blank(body.product) ||
      !Number.isInteger(body.quantity) ||
      !(body.quantity! >= 1) ||
      !positive(body.amount) ||
      blank(body.card)
    ) {
      return reply.code(400).send({ error: "product, quantity (at least 1), amount (above 0) and card are required" });
    }

    const taskId = randomUUID(); // each order is its own execution
    const order = store.createOrder(body as NewOrder, taskId);
    try {
      await gateway.trigger(taskId, order);
    } catch (error) {
      if (!(error instanceof SkailGatewayError)) throw error;
      request.log.warn({ err: error, orderId: order.id }, "skail did not accept the trigger");
      store.markNotAccepted(order.id);
      return reply.code(502).send({ orderId: order.id, taskId, error: `skail unavailable (${error.message})` });
    }

    store.markAccepted(order.id);
    return { orderId: order.id, taskId };
  });

  app.get("/api/state", async () => store.snapshot());

  app.post("/api/reset", async (_request, reply) => {
    store.reset();
    return reply.code(204).send();
  });

  app.get("/api/stream", (_request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (state: StateView) => raw.write(`data: ${JSON.stringify(state)}\n\n`);

    // subscribe before sending the snapshot: no update is lost
    const unsubscribe = store.subscribe(send);
    raw.on("close", unsubscribe);
    send(store.snapshot());
  });

  // ---- called by the worker: the simulated stock, payment gateway, invoice issuer and customer messaging ---------

  app.post<{ Body: ReserveRequest }>("/internal/stock/reservations", async (request) => store.reserve(request.body));

  app.post<{ Params: { reservationId: string } }>(
    "/internal/stock/reservations/:reservationId/release",
    async (request, reply) =>
      store.releaseStock(request.params.reservationId) ? reply.code(204).send() : reply.code(404).send(),
  );

  // The first attempt of each order answers 504, like a gateway that did not respond in time.
  app.post<{ Body: ChargeRequest }>("/internal/payments/charges", async (request, reply) => {
    const outcome = store.chargeCard(request.body);
    return outcome.timedOut ? reply.code(504).send({ error: "the gateway did not answer in time" }) : outcome.charge;
  });

  app.post<{ Params: { chargeId: string } }>("/internal/payments/charges/:chargeId/refund", async (request, reply) =>
    store.refund(request.params.chargeId) ? reply.code(204).send() : reply.code(404).send(),
  );

  app.post<{ Body: InvoiceRequest }>("/internal/invoices", async (request) => store.issueInvoice(request.body));

  app.post<{ Params: { orderId: string }; Body: NotifyCustomerRequest }>(
    "/internal/orders/:orderId/customer-messages",
    async (request, reply) => {
      store.notifyCustomer(request.params.orderId, request.body.message);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { orderId: string }; Body: RecordResultRequest }>(
    "/internal/orders/:orderId/result",
    async (request, reply) => {
      store.recordResult(request.params.orderId, request.body.result);
      return reply.code(204).send();
    },
  );

  if (staticDir) app.register(fastifyStatic, { root: staticDir });

  return app;
}
