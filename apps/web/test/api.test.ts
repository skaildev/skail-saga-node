import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it } from "vitest";
import type { Order, StateView } from "@skail-saga/contracts";
import { createApp } from "../src/app.js";
import { SkailGatewayError, type SkailGateway } from "../src/gateway.js";
import { SagaStore } from "../src/saga-store.js";

class FakeGateway implements SkailGateway {
  triggers: { taskId: string; order: Order }[] = [];
  failTrigger = false;
  async trigger(taskId: string, order: Order) {
    if (this.failTrigger) throw new SkailGatewayError("skail answered 503");
    this.triggers.push({ taskId, order });
  }
}

let store: SagaStore;
let gateway: FakeGateway;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new SagaStore();
  gateway = new FakeGateway();
  app = createApp({ store, gateway });
});

const newOrder = (patch: object = {}) => ({
  product: "Monitor",
  quantity: 1,
  amount: 1200,
  card: "4111111111111111",
  ...patch,
});
const place = (payload: unknown = newOrder()) =>
  app.inject({ method: "POST", url: "/api/orders", payload: payload as object });
const post = (url: string, payload?: object) => app.inject({ method: "POST", url, payload });

describe("POST /api/orders", () => {
  it("starts CloseOrder with a new execution, without the card, and answers the ids", async () => {
    const res = await place();

    expect(res.statusCode).toBe(200);
    expect(gateway.triggers).toHaveLength(1);
    const { taskId, order } = gateway.triggers[0]!;
    expect(order).toEqual({ id: "P-10", product: "Monitor", quantity: 1, amount: 1200 });
    expect(res.json()).toEqual({ orderId: "P-10", taskId });
  });

  it("gives each order its own execution", async () => {
    await place();
    await place();

    expect(new Set(gateway.triggers.map((t) => t.taskId)).size).toBe(2);
    expect(gateway.triggers.map((t) => t.order.id)).toEqual(["P-10", "P-11"]);
  });

  it("shows the new order in the state with the card masked", async () => {
    await place();

    const [order] = (await app.inject({ url: "/api/state" })).json<StateView>().orders;
    expect(order).toMatchObject({ orderId: "P-10", state: "Received", card: "•••• 1111" });
  });

  it.each([
    [null],
    [{}],
    [newOrder({ product: " " })],
    [newOrder({ quantity: 0 })],
    [newOrder({ quantity: 1.5 })],
    [newOrder({ amount: 0 })],
    [newOrder({ amount: "10" })],
    [newOrder({ card: "" })],
  ])("refuses the invalid order %j and starts nothing", async (payload) => {
    const res = await place(payload);

    expect(res.statusCode).toBe(400);
    expect(gateway.triggers).toEqual([]);
    expect(store.snapshot().orders).toEqual([]);
  });

  it("answers 502 with the reason and marks the order when skail does not accept the trigger", async () => {
    gateway.failTrigger = true;

    const res = await place();

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("skail answered 503");
    expect(store.snapshot().orders[0]!.state).toBe("NotAccepted");
  });
});

describe("state and reset", () => {
  it("POST /api/reset goes back to the seed", async () => {
    await place();

    expect((await post("/api/reset")).statusCode).toBe(204);

    const state = store.snapshot();
    expect(state.orders).toEqual([]);
    expect(state.stock.find((s) => s.product === "Monitor")).toEqual({ product: "Monitor", available: 5, reserved: 0 });
  });

  it("answers /healthz", async () => {
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
  });
});

describe("the simulated services (called by the worker)", () => {
  it("reserves and takes the stock", async () => {
    await place();

    const res = await post("/internal/stock/reservations", { orderId: "P-10", product: "Monitor", quantity: 2 });

    expect(res.json()).toEqual({ confirmed: true, id: "RES-P-10" });
    expect(store.snapshot().stock.find((s) => s.product === "Monitor")).toEqual({
      product: "Monitor",
      available: 3,
      reserved: 2,
    });
  });

  it("releases with 204, or 404 for an unknown reservation", async () => {
    await place();
    await post("/internal/stock/reservations", { orderId: "P-10", product: "Monitor", quantity: 1 });

    expect((await post("/internal/stock/reservations/RES-P-10/release")).statusCode).toBe(204);
    expect((await post("/internal/stock/reservations/RES-nope/release")).statusCode).toBe(404);
  });

  it("answers 504 to the first charge attempt and goes through on the second", async () => {
    await place();
    const charge = { orderId: "P-10", amount: 1200 };

    expect((await post("/internal/payments/charges", charge)).statusCode).toBe(504);

    const second = await post("/internal/payments/charges", charge);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ approved: true, id: "COB-P-10", reason: null });
  });

  it("refunds with 204, or 404 for an unknown charge", async () => {
    await place();
    const charge = { orderId: "P-10", amount: 1200 };
    await post("/internal/payments/charges", charge);
    await post("/internal/payments/charges", charge);

    expect((await post("/internal/payments/charges/COB-P-10/refund")).statusCode).toBe(204);
    expect((await post("/internal/payments/charges/COB-nope/refund")).statusCode).toBe(404);
  });

  it("issues the invoice and answers the result", async () => {
    await place(newOrder({ product: "Cabo HDMI", quantity: 2, amount: 60 }));

    const res = await post("/internal/invoices", { orderId: "P-10", product: "Cabo HDMI", amount: 60 });

    expect(res.json()).toEqual({ authorized: false, number: null, reason: "Cabo HDMI has no NCM registered" });
  });

  it("shows the customer message and the result on the order", async () => {
    await place();

    expect((await post("/internal/orders/P-10/customer-messages", { message: "Order confirmed!" })).statusCode).toBe(
      204,
    );
    expect((await post("/internal/orders/P-10/result", { result: "confirmed" })).statusCode).toBe(204);

    const [order] = store.snapshot().orders;
    expect(order).toMatchObject({ state: "Confirmed", result: "confirmed" });
    expect(order!.steps).toEqual([{ kind: "CustomerNotified", detail: "Order confirmed!", compensation: false }]);
  });
});

describe("GET /api/stream (SSE)", () => {
  let base: string;

  beforeEach(async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    return () => app.close();
  });

  it("starts with the current snapshot and sends another one on every change", async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async () => {
      while (!buffer.includes("\n\n")) buffer += decoder.decode((await reader.read()).value, { stream: true });
      const [chunk, ...rest] = buffer.split("\n\n");
      buffer = rest.join("\n\n");
      return JSON.parse(chunk!.replace(/^data: /, "")) as StateView;
    };

    expect((await next()).orders).toEqual([]);

    await place();
    expect((await next()).orders[0]).toMatchObject({ orderId: "P-10", state: "Received" });

    controller.abort();
  });
});
