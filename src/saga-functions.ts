import { SkailCommand, SkailFunction } from "@skail/runtime";
import { SagaResults, type Charge, type Order, type Reservation, type TaxInvoice } from "./model.js";

// Method names are PascalCase on purpose: the skail address is <workload>/<method>, and the trigger calls
// <workload>/CloseOrder.
export class OrderFunctions {
  /**
   * Reserves the stock, charges the card and issues the invoice. When a step does not work out, it undoes the previous
   * ones in reverse order. The name and the parameter are the trigger contract: [{"id", "product", "quantity",
   * "amount"}].
   */
  @SkailFunction()
  async CloseOrder(order: Order): Promise<string> {
    const reservation = await this.ReserveStock(order.id, order.product, order.quantity);
    if (!reservation.confirmed) return this.ReportResult(order.id, SagaResults.outOfStock);

    const charge = await this.ChargeCard(order.id, order.amount);
    if (!charge.approved) {
      await this.ReleaseStock(reservation.id!);
      return this.ReportResult(order.id, SagaResults.paymentDeclined);
    }

    const invoice = await this.IssueInvoice(order.id, order.product, order.amount);
    if (!invoice.authorized) {
      await this.RefundCharge(charge.id!); // reverse order: the refund first,
      await this.ReleaseStock(reservation.id!); // then the stock
      return this.ReportResult(order.id, SagaResults.cancelledWithRefund);
    }

    return this.ReportResult(order.id, SagaResults.confirmed);
  }

  // The commands are the I/O, one operation each. skail never runs a completed command again, but a retry runs the
  // whole command again, so every call is idempotent: the order id is the idempotency key.

  @SkailCommand()
  async ReserveStock(orderId: string, product: string, quantity: number): Promise<Reservation> {
    return callServices("stock/reserve", { orderId, product, quantity });
  }

  /**
   * A gateway timeout throws, and skail runs the command again (up to 3 times); the order id keeps the card from being
   * charged twice. A declined card comes back as a result, because another attempt would not change it.
   */
  @SkailCommand({ retryCount: 3 })
  async ChargeCard(orderId: string, amount: number): Promise<Charge> {
    return callServices("gateway/charge", { orderId, amount });
  }

  @SkailCommand()
  async IssueInvoice(orderId: string, product: string, amount: number): Promise<TaxInvoice> {
    return callServices("invoices/issue", { orderId, product, amount });
  }

  // Compensations

  @SkailCommand()
  async RefundCharge(chargeId: string): Promise<void> {
    await callServices("gateway/refund", { chargeId });
  }

  @SkailCommand()
  async ReleaseStock(reservationId: string): Promise<void> {
    await callServices("stock/release", { reservationId });
  }

  /** Reports how the order ended, to the console and the page, and returns that result to the function. */
  @SkailCommand()
  async ReportResult(orderId: string, result: string): Promise<string> {
    await callApp("timeline", { runId: orderId, text: `result: ${result}`, step: `end:${result}` });
    return result;
  }
}

/**
 * Calls the simulated services, which run in the main process of this app (src/simulated-services.ts): commands run in
 * an isolated VM, so they reach the services over HTTP, like they would reach the real ones.
 */
const callServices = <T>(route: string, body: unknown): Promise<T> => callApp<T>(`services/${route}`, body);

async function callApp<T>(route: string, body: unknown): Promise<T> {
  const response = await fetch(`${process.env.DEMO_INTERNAL_URL}/internal/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const content = await response.text();
  if (!response.ok) throw new Error(`${route} answered ${response.status}: ${content}`);
  return (content ? JSON.parse(content) : undefined) as T;
}
