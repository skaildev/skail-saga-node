import {
  isTerminal,
  money,
  orderStateOfResult,
  rejected,
  declined,
  type Charge,
  type ChargeRequest,
  type InvoiceRequest,
  type NewOrder,
  type Order,
  type OrderState,
  type OrderView,
  type Reservation,
  type ReserveRequest,
  type StateView,
  type StepKind,
  type StepView,
  type TaxInvoice,
} from "@skail-saga/contracts";

/** Result of a charge attempt at the simulated gateway: it either did not answer in time, or answered. */
export type ChargeOutcome = { timedOut: true } | { timedOut: false; charge: Charge };

interface OrderRow {
  order: Order;
  /** The card on file: the gateway charges it by order id, so it never goes into the run. */
  card: string;
  taskId: string;
  accepted: boolean;
  state: OrderState;
  result: string | null;
  steps: StepView[];
}

interface Hold {
  orderId: string;
  product: string;
  quantity: number;
  released: boolean;
}

interface ChargeRow {
  orderId: string;
  charge: Charge;
  amount: number;
  refunded: boolean;
}

const FIRST_ORDER_NUMBER = 10;
const FIRST_INVOICE_NUMBER = 10001;

/** Products with a tax registration: any other product gets its invoice rejected. */
const WITH_TAX_REGISTRATION = new Set(["Monitor", "Teclado"]);

const seedStock = (): Map<string, number> =>
  new Map([
    ["Monitor", 5],
    ["Teclado", 20],
    ["Cabo HDMI", 100],
  ]);

/**
 * The simulated outside world of the saga (stock, payment gateway, invoice issuer, customer messaging) and the view of
 * the orders, in memory. Every effect is recorded as a step of its order, in the order it happened, so the page shows
 * the compensations running backwards. Every write that comes from the worker is idempotent, because a command that is
 * retried runs again.
 */
export class SagaStore {
  #stock = seedStock();
  #reservations = new Map<string, Reservation>(); // by order id
  #holds = new Map<string, Hold>(); // by reservation id
  #attempts = new Map<string, number>(); // charge attempts by order id
  #charges = new Map<string, ChargeRow>(); // by order id, the idempotency key
  #invoices = new Map<string, TaxInvoice>(); // by order id
  #messages = new Set<string>();
  #orders: OrderRow[] = [];
  #nextOrder = FIRST_ORDER_NUMBER;
  #nextInvoice = FIRST_INVOICE_NUMBER;
  readonly #subscribers = new Set<(state: StateView) => void>();

  // --- placing orders (the page, or a curl) -------------------------------------------------------------------

  /**
   * Creates the order the saga will close and keeps its card on file. The returned order, which goes to skail, has no
   * card. The order id doubles as the payment idempotency key.
   */
  createOrder(request: NewOrder, taskId: string): Order {
    const order: Order = {
      id: `P-${this.#nextOrder++}`,
      product: request.product.trim(),
      quantity: request.quantity,
      amount: request.amount,
    };
    this.#orders.push({
      order,
      card: request.card.trim(),
      taskId,
      accepted: false,
      state: "Received",
      result: null,
      steps: [],
    });
    this.#publish();
    return order;
  }

  /** skail accepted the trigger. */
  markAccepted(orderId: string): void {
    const row = this.#find(orderId);
    if (!row) return;
    row.accepted = true;
    if (row.state === "NotAccepted") row.state = "Received";
    this.#publish();
  }

  /** skail did not accept the trigger: nothing runs for this order. */
  markNotAccepted(orderId: string): void {
    const row = this.#find(orderId);
    if (!row || row.accepted || row.state !== "Received") return;
    row.state = "NotAccepted";
    this.#publish();
  }

  // --- stock --------------------------------------------------------------------------------------------------

  /** Reserves the stock. Idempotent by order id: a retried command gets the same answer and no second reservation. */
  reserve(request: ReserveRequest): Reservation {
    const known = this.#reservations.get(request.orderId);
    if (known) return known;

    const total = this.#stock.get(request.product);
    const available = total === undefined ? 0 : total - this.#reservedOf(request.product);
    let reservation: Reservation;
    if (request.quantity > 0 && available >= request.quantity) {
      reservation = { confirmed: true, id: `RES-${request.orderId}` };
      this.#holds.set(reservation.id!, {
        orderId: request.orderId,
        product: request.product,
        quantity: request.quantity,
        released: false,
      });
      this.#step(request.orderId, "StockReserved", `${request.quantity} × ${request.product} reserved`, false);
    } else {
      reservation = { confirmed: false, id: null };
      this.#step(
        request.orderId,
        "OutOfStock",
        `${request.quantity} × ${request.product} requested, ${available} available`,
        false,
      );
    }

    this.#reservations.set(request.orderId, reservation);
    this.#publish();
    return reservation;
  }

  /** Compensation. Idempotent by reservation id. @returns false when there is no such reservation. */
  releaseStock(reservationId: string): boolean {
    const hold = this.#holds.get(reservationId);
    if (!hold) return false;
    if (!hold.released) {
      hold.released = true;
      this.#step(hold.orderId, "StockReleased", `${hold.quantity} × ${hold.product} back to stock`, true);
      this.#publish();
    }
    return true;
  }

  // --- payment gateway ----------------------------------------------------------------------------------------

  /**
   * The simulated gateway charges the card on file for the order. The first attempt of each order times out (the
   * skail retry shows up), a card ending in 0002 is declined, anything else is approved. Idempotent by order id: an
   * order that was already charged is not charged again, it gets the same answer.
   */
  chargeCard(request: ChargeRequest): ChargeOutcome {
    const { orderId, amount } = request;
    const known = this.#charges.get(orderId);
    if (known) return { timedOut: false, charge: known.charge };

    const attempt = (this.#attempts.get(orderId) ?? 0) + 1;
    this.#attempts.set(orderId, attempt);
    if (attempt === 1) {
      this.#step(orderId, "ChargeTimeout", "the gateway did not answer in time (attempt 1), skail tries again", false);
      this.#publish();
      return { timedOut: true };
    }

    const card = this.#find(orderId)?.card;
    let charge: Charge;
    if (card === undefined) {
      charge = declined("no card on file");
    } else if (card.endsWith("0002")) {
      charge = declined("insufficient funds");
      this.#step(orderId, "ChargeDeclined", `card declined: ${charge.reason}`, false);
    } else {
      charge = { approved: true, id: `COB-${orderId}`, reason: null };
      this.#step(orderId, "ChargeApproved", `${money(amount)} charged (attempt ${attempt})`, false);
    }

    this.#charges.set(orderId, { orderId, charge, amount, refunded: false });
    this.#publish();
    return { timedOut: false, charge };
  }

  /** Compensation. Idempotent by charge id. @returns false when there is no such charge. */
  refund(chargeId: string): boolean {
    const row = [...this.#charges.values()].find((c) => c.charge.id === chargeId);
    if (!row) return false;
    if (!row.refunded) {
      row.refunded = true;
      this.#step(row.orderId, "ChargeRefunded", `${money(row.amount)} refunded`, true);
      this.#publish();
    }
    return true;
  }

  // --- invoice issuer -----------------------------------------------------------------------------------------

  /** The simulated issuer: only products with a tax registration get an authorized invoice. Idempotent by order id. */
  issueInvoice(request: InvoiceRequest): TaxInvoice {
    const known = this.#invoices.get(request.orderId);
    if (known) return known;

    let invoice: TaxInvoice;
    if (WITH_TAX_REGISTRATION.has(request.product)) {
      invoice = { authorized: true, number: `NF-${this.#nextInvoice++}`, reason: null };
      this.#step(request.orderId, "InvoiceAuthorized", `invoice ${invoice.number} issued`, false);
    } else {
      invoice = rejected(`${request.product} has no NCM registered`);
      this.#step(request.orderId, "InvoiceRejected", `invoice rejected: ${invoice.reason}`, false);
    }

    this.#invoices.set(request.orderId, invoice);
    this.#publish();
    return invoice;
  }

  // --- customer messaging and the result ----------------------------------------------------------------------

  /** The e-mail to the customer. Idempotent by order id and message. */
  notifyCustomer(orderId: string, message: string): void {
    const key = `${orderId}|${message}`;
    if (this.#messages.has(key)) return;
    this.#messages.add(key);
    this.#step(orderId, "CustomerNotified", message, false);
    this.#publish();
  }

  /** The saga ended. @returns false when the order is unknown or already has a result. */
  recordResult(orderId: string, result: string): boolean {
    const row = this.#find(orderId);
    if (!row || isTerminal(row.state)) return false;
    row.state = orderStateOfResult(result);
    row.result = result;
    this.#publish();
    return true;
  }

  // --- the page -----------------------------------------------------------------------------------------------

  snapshot(): StateView {
    return {
      stock: [...this.#stock].map(([product, total]) => {
        const reserved = this.#reservedOf(product);
        return { product, available: total - reserved, reserved };
      }),
      orders: this.#orders.map((o): OrderView => ({
        orderId: o.order.id,
        product: o.order.product,
        quantity: o.order.quantity,
        amount: o.order.amount,
        card: maskCard(o.card),
        taskId: o.taskId,
        state: o.state,
        result: o.result,
        steps: [...o.steps],
      })),
    };
  }

  /** Back to the seed: stock as at the start, no orders. For running the demo again. */
  reset(): void {
    this.#stock = seedStock();
    this.#reservations = new Map();
    this.#holds = new Map();
    this.#attempts = new Map();
    this.#charges = new Map();
    this.#invoices = new Map();
    this.#messages = new Set();
    this.#orders = [];
    this.#nextOrder = FIRST_ORDER_NUMBER;
    this.#nextInvoice = FIRST_INVOICE_NUMBER;
    this.#publish();
  }

  /** @returns the unsubscribe function. The listener gets a full snapshot on every change. */
  subscribe(listener: (state: StateView) => void): () => void {
    this.#subscribers.add(listener);
    return () => void this.#subscribers.delete(listener);
  }

  #find(orderId: string): OrderRow | undefined {
    return this.#orders.find((o) => o.order.id === orderId);
  }

  #reservedOf(product: string): number {
    let reserved = 0;
    for (const hold of this.#holds.values()) if (hold.product === product && !hold.released) reserved += hold.quantity;
    return reserved;
  }

  #step(orderId: string, kind: StepKind, detail: string, compensation: boolean): void {
    const row = this.#find(orderId);
    if (!row) return;
    row.steps.push({ kind, detail, compensation });
    if (row.state === "Received") row.state = "Running";
  }

  #publish(): void {
    if (this.#subscribers.size === 0) return;
    const state = this.snapshot();
    for (const listener of [...this.#subscribers]) listener(state);
  }
}

function maskCard(card: string): string {
  return card.length > 4 ? `•••• ${card.slice(-4)}` : card;
}
