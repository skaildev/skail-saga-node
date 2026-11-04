// Shared by web, worker and front end. It also goes into the skail bundle, so it holds only types, constants and
// pure functions: `skail build` rejects Node I/O imports.

/**
 * The argument of the CloseOrder function. It has no card: the card stays in the web app, which plays the store,
 * so it never goes into the run history or the Monitor.
 */
export interface Order {
  id: string;
  product: string;
  quantity: number;
  amount: number;
}

/** Result of reserving stock. Not having the stock is a result, not an error. */
export interface Reservation {
  confirmed: boolean;
  id: string | null;
}

/** Result of charging the card. A declined card is a result, not an error: trying again would not change it. */
export interface Charge {
  approved: boolean;
  id: string | null;
  reason: string | null;
}

/** Result of issuing the tax invoice. */
export interface TaxInvoice {
  authorized: boolean;
  number: string | null;
  reason: string | null;
}

export const declined = (reason: string): Charge => ({ approved: false, id: null, reason });
export const rejected = (reason: string): TaxInvoice => ({ authorized: false, number: null, reason });

// ---- calls from the worker to the simulated services (they live in the web app) -----------------------------------

export interface ReserveRequest {
  orderId: string;
  product: string;
  quantity: number;
}

/** The gateway charges the card on file for the order. The order id is the idempotency key. */
export interface ChargeRequest {
  orderId: string;
  amount: number;
}

export interface InvoiceRequest {
  orderId: string;
  product: string;
  amount: number;
}

export interface NotifyCustomerRequest {
  message: string;
}

export interface RecordResultRequest {
  result: string;
}

/** What the page (or a curl) sends to place an order. The web app picks the order id and keeps the card. */
export interface NewOrder {
  product: string;
  quantity: number;
  amount: number;
  card: string;
}

/** The four ways CloseOrder can end: one per path of the saga. */
export const SagaResults = {
  confirmed: "confirmed",
  outOfStock: "out of stock",
  paymentDeclined: "payment declined",
  cancelledWithRefund: "cancelled with refund",
} as const;

export type OrderState = "Received" | "NotAccepted" | "Running" | "Confirmed" | "OutOfStock" | "Declined" | "Refunded";

export type StepKind =
  | "StockReserved"
  | "OutOfStock"
  | "ChargeTimeout"
  | "ChargeApproved"
  | "ChargeDeclined"
  | "InvoiceAuthorized"
  | "InvoiceRejected"
  | "ChargeRefunded"
  | "StockReleased"
  | "CustomerNotified";

/** One effect on the outside world, in the order it happened. A compensation undoes a step that came before it. */
export interface StepView {
  kind: StepKind;
  detail: string;
  compensation: boolean;
}

export interface StockView {
  product: string;
  available: number;
  reserved: number;
}

export interface OrderView {
  orderId: string;
  product: string;
  quantity: number;
  amount: number;
  /** Masked: only the last four digits. */
  card: string;
  taskId: string;
  state: OrderState;
  result: string | null;
  steps: StepView[];
}

/** What `GET /api/state` and the SSE stream return. */
export interface StateView {
  stock: StockView[];
  orders: OrderView[];
}

/** The state an order reaches when the worker reports its result. */
export function orderStateOfResult(result: string | null | undefined): OrderState {
  switch (result) {
    case SagaResults.confirmed:
      return "Confirmed";
    case SagaResults.outOfStock:
      return "OutOfStock";
    case SagaResults.paymentDeclined:
      return "Declined";
    case SagaResults.cancelledWithRefund:
      return "Refunded";
    default:
      return "Running";
  }
}

export function isTerminal(state: OrderState): boolean {
  return state === "Confirmed" || state === "OutOfStock" || state === "Declined" || state === "Refunded";
}

/** "R$ 99.90": the same text in the page and in the steps the web app writes. */
export function money(value: number): string {
  return `R$ ${value.toFixed(2)}`;
}
