// Types of the saga. This file ends up inside the skail bundle: pure code only, no Node imports.

/**
 * The argument of CloseOrder. It has no card: the store keeps the card on file and the gateway charges it by order id,
 * so the card number never goes into the run history or the Monitor.
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

/** Result of issuing the tax invoice. A rejection is a result, not an error. */
export interface TaxInvoice {
  authorized: boolean;
  number: string | null;
  reason: string | null;
}

/** The four ways CloseOrder can end. */
export const SagaResults = {
  confirmed: "confirmed",
  outOfStock: "out of stock",
  paymentDeclined: "payment declined",
  cancelledWithRefund: "cancelled with refund",
} as const;
