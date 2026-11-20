import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Charge, Order, Reservation, TaxInvoice } from "./model.js";
import type { Timeline } from "./timeline.js";

/** Products with a tax registration: any other product gets its invoice rejected. */
const withTaxRegistration = new Set(["Monitor", "Teclado"]);

/** An order as the page shows it: the card only by its last 4 digits. */
export interface PlacedOrder extends Order {
  cardLast4: string;
  expected: string;
}

interface State {
  stock: Record<string, number>;
  orders: PlacedOrder[];
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
  orders: [],
  cards: {},
  reservations: {},
  holds: {},
  attempts: {},
  charges: {},
  invoices: {},
  nextOrder: 10,
  nextInvoice: 10001,
});

/** The gateway did not answer in time: the app answers 504 to the command, and the command throws. */
export class GatewayTimeout extends Error {}

/**
 * The outside world of the saga, simulated: the stock, the payment gateway and the invoice issuer. In your system these
 * would be other services; here they report each effect to the timeline (console and page). Every call is idempotent by
 * order id (or by reservation and charge id), because a retried command runs again.
 * The state is saved to .saga-demo.json, so it survives an app restart in the middle of a run.
 */
export class SimulatedServices {
  private constructor(
    private readonly path: string,
    private state: State,
    private readonly timeline: Timeline,
  ) {}

  /** Starts over: full stock, no orders. */
  static fresh(path: string, timeline: Timeline): SimulatedServices {
    const services = new SimulatedServices(path, newState(), timeline);
    services.save();
    return services;
  }

  /** Picks up the state saved by a previous run of the app. */
  static resume(path: string, timeline: Timeline): SimulatedServices {
    const state = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as State) : newState();
    return new SimulatedServices(path, state, timeline);
  }

  /** Puts the stock back and forgets the orders (the Reset button). */
  reset(): void {
    this.state = newState();
    this.save();
  }

  /** The stock available now, by product, and the orders placed, for the page. */
  snapshot(): { stock: Record<string, number>; orders: PlacedOrder[] } {
    return { stock: { ...this.state.stock }, orders: [...this.state.orders] };
  }

  /** Creates an order and keeps its card on file. The order that goes to skail has no card. */
  placeOrder(product: string, quantity: number, amount: number, card: string, expected: string): Order {
    const order = { id: `P-${this.state.nextOrder++}`, product, quantity, amount };
    this.state.cards[order.id] = card;
    this.state.orders.push({ ...order, cardLast4: card.slice(-4), expected });
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
      this.timeline.add(orderId, `stock: ${quantity} × ${product} reserved`);
    } else {
      reservation = { confirmed: false, id: null };
      this.timeline.add(orderId, `stock: ${quantity} × ${product} requested, ${available} available`);
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
    this.timeline.add(hold.orderId, `↩ stock: ${hold.quantity} × ${hold.product} back to stock`);
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
      this.timeline.add(orderId, "gateway: no answer in time (attempt 1), skail will try again");
      this.save();
      throw new GatewayTimeout("The payment gateway did not answer in time");
    }

    const card = this.state.cards[orderId] ?? "";
    let charge: Charge;
    if (card.endsWith("0002")) {
      charge = { approved: false, id: null, reason: "insufficient funds" };
      this.timeline.add(orderId, `gateway: card …${card.slice(-4)} declined, ${charge.reason}`);
    } else {
      charge = { approved: true, id: `CH-${orderId}`, reason: null };
      this.timeline.add(orderId, `gateway: ${money(amount)} charged to card …${card.slice(-4)} (attempt ${attempt})`);
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
    this.timeline.add(row.orderId, `↩ gateway: ${money(row.amount)} refunded`);
    this.save();
  }

  // --- invoice issuer -----------------------------------------------------------------------------------------------

  issueInvoice(orderId: string, product: string, amount: number): TaxInvoice {
    const known = this.state.invoices[orderId];
    if (known) return known;

    let invoice: TaxInvoice;
    if (withTaxRegistration.has(product)) {
      invoice = { authorized: true, number: `NF-${this.state.nextInvoice++}`, reason: null };
      this.timeline.add(orderId, `invoice: ${invoice.number} issued, ${money(amount)}`);
    } else {
      invoice = { authorized: false, number: null, reason: `${product} has no tax registration` };
      this.timeline.add(orderId, `invoice: rejected, ${invoice.reason}`);
    }

    this.state.invoices[orderId] = invoice;
    this.save();
    return invoice;
  }

  /** The services the commands call over HTTP, by route (the app serves them under /internal/). */
  call(route: string, body: any): unknown {
    switch (route) {
      case "stock/reserve":
        return this.reserve(body.orderId, body.product, body.quantity);
      case "stock/release":
        return this.release(body.reservationId);
      case "gateway/charge":
        return this.charge(body.orderId, body.amount);
      case "gateway/refund":
        return this.refund(body.chargeId);
      case "invoices/issue":
        return this.issueInvoice(body.orderId, body.product, body.amount);
      default:
        throw new Error(`Unknown service ${route}`);
    }
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify(this.state));
  }
}

export function money(value: number): string {
  return `R$ ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

