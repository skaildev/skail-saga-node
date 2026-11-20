import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Charge, Order, Reservation, TaxInvoice } from "./model.js";

/** Products with a tax registration: any other product gets its invoice rejected. */
const withTaxRegistration = new Set(["Monitor", "Teclado"]);

interface State {
  stock: Record<string, number>;
  cards: Record<string, string>;
  reservations: Record<string, Reservation>;
  holds: Record<string, { orderId: string; product: string; quantity: number; released: boolean }>;
  attempts: Record<string, number>;
  charges: Record<string, { orderId: string; charge: Charge; amount: number; refunded: boolean }>;
  invoices: Record<string, TaxInvoice>;
  nextOrder: number;
  nextInvoice: number;
}

const newState = (): State => ({
  stock: { Monitor: 5, Teclado: 20, "Cabo HDMI": 100 },
  cards: {},
  reservations: {},
  holds: {},
  attempts: {},
  charges: {},
  invoices: {},
  nextOrder: 10,
  nextInvoice: 10001,
});

/** The gateway did not answer in time: the HTTP server turns it into a 504, and the command throws. */
class GatewayTimeout extends Error {}

/**
 * The outside world of the saga, simulated: the stock, the payment gateway and the invoice issuer. In your system these
 * would be other services; here they print each effect to the console. Every call is idempotent by order id (or by
 * reservation and charge id), because a retried command runs again.
 * The state is saved to .saga-demo.json, so it survives an app restart in the middle of a run.
 */
export class SimulatedServices {
  private constructor(
    private readonly path: string,
    private readonly state: State,
  ) {}

  /** Starts over: full stock, no orders. */
  static fresh(path: string): SimulatedServices {
    const services = new SimulatedServices(path, newState());
    services.save();
    return services;
  }

  /** Picks up the state saved by a previous run of the app. */
  static resume(path: string): SimulatedServices {
    return new SimulatedServices(path, existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : newState());
  }

  /** Creates an order and keeps its card on file. The order that goes to skail has no card. */
  placeOrder(product: string, quantity: number, amount: number, card: string): Order {
    const order = { id: `P-${this.state.nextOrder++}`, product, quantity, amount };
    this.state.cards[order.id] = card;
    this.save();
    return order;
  }

  // --- stock --------------------------------------------------------------------------------------------------------

  reserve(orderId: string, product: string, quantity: number): Reservation {
    const known = this.state.reservations[orderId];
    if (known) return known;

    const available = this.state.stock[product] ?? 0;
    let reservation: Reservation;
    if (available >= quantity) {
      this.state.stock[product] = available - quantity;
      reservation = { confirmed: true, id: `RES-${orderId}` };
      this.state.holds[reservation.id!] = { orderId, product, quantity, released: false };
      print(orderId, `stock: ${quantity} × ${product} reserved`);
    } else {
      reservation = { confirmed: false, id: null };
      print(orderId, `stock: ${quantity} × ${product} requested, ${available} available`);
    }

    this.state.reservations[orderId] = reservation;
    this.save();
    return reservation;
  }

  /** Compensation. */
  release(reservationId: string): void {
    const hold = this.state.holds[reservationId];
    if (!hold || hold.released) return;

    hold.released = true;
    this.state.stock[hold.product] = (this.state.stock[hold.product] ?? 0) + hold.quantity;
    print(hold.orderId, `↩ stock: ${hold.quantity} × ${hold.product} back to stock`);
    this.save();
  }

  // --- payment gateway ----------------------------------------------------------------------------------------------

  /**
   * Charges the card on file for the order. The first attempt of every order times out, so the skail retry shows up;
   * a card ending in 0002 is declined; any other card is approved.
   */
  charge(orderId: string, amount: number): Charge {
    const known = this.state.charges[orderId];
    if (known) return known.charge;

    const attempt = (this.state.attempts[orderId] = (this.state.attempts[orderId] ?? 0) + 1);
    if (attempt === 1) {
      print(orderId, "gateway: no answer in time (attempt 1), skail will try again");
      this.save();
      throw new GatewayTimeout("The payment gateway did not answer in time");
    }

    const card = this.state.cards[orderId] ?? "";
    let charge: Charge;
    if (card.endsWith("0002")) {
      charge = { approved: false, id: null, reason: "insufficient funds" };
      print(orderId, `gateway: card …${card.slice(-4)} declined, ${charge.reason}`);
    } else {
      charge = { approved: true, id: `CH-${orderId}`, reason: null };
      print(orderId, `gateway: ${money(amount)} charged to card …${card.slice(-4)} (attempt ${attempt})`);
    }

    this.state.charges[orderId] = { orderId, charge, amount, refunded: false };
    this.save();
    return charge;
  }

  /** Compensation. */
  refund(chargeId: string): void {
    const row = Object.values(this.state.charges).find((c) => c.charge.id === chargeId);
    if (!row || row.refunded) return;

    row.refunded = true;
    print(row.orderId, `↩ gateway: ${money(row.amount)} refunded`);
    this.save();
  }

  // --- invoice issuer -----------------------------------------------------------------------------------------------

  issueInvoice(orderId: string, product: string, amount: number): TaxInvoice {
    const known = this.state.invoices[orderId];
    if (known) return known;

    let invoice: TaxInvoice;
    if (withTaxRegistration.has(product)) {
      invoice = { authorized: true, number: `NF-${this.state.nextInvoice++}`, reason: null };
      print(orderId, `invoice: ${invoice.number} issued, ${money(amount)}`);
    } else {
      invoice = { authorized: false, number: null, reason: `${product} has no tax registration` };
      print(orderId, `invoice: rejected, ${invoice.reason}`);
    }

    this.state.invoices[orderId] = invoice;
    this.save();
    return invoice;
  }

  /** Serves the services over HTTP on a free local port, for the commands, and returns its address. */
  listen(): Promise<string> {
    const routes: Record<string, (body: any) => unknown> = {
      "/stock/reserve": (b) => this.reserve(b.orderId, b.product, b.quantity),
      "/stock/release": (b) => this.release(b.reservationId),
      "/gateway/charge": (b) => this.charge(b.orderId, b.amount),
      "/gateway/refund": (b) => this.refund(b.chargeId),
      "/invoices/issue": (b) => this.issueInvoice(b.orderId, b.product, b.amount),
    };

    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const route = routes[request.url ?? ""];
      if (!route) return void response.writeHead(404).end();
      try {
        const result = route(JSON.parse(body || "{}"));
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result ?? null));
      } catch (error) {
        response.writeHead(error instanceof GatewayTimeout ? 504 : 500).end((error as Error).message);
      }
    });

    return new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        server.unref();
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      }),
    );
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify(this.state));
  }
}

export function money(value: number): string {
  return `R$ ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function print(orderId: string, message: string): void {
  console.log(`[${orderId}] ${message}`);
}
