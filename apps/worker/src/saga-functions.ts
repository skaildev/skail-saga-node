import { SkailCommand, SkailFunction, SkailNonDeterministicError } from "@skail/runtime";
import {
  SagaResults,
  declined,
  rejected,
  type Charge,
  type Order,
  type Reservation,
  type TaxInvoice,
} from "@skail-saga/contracts";
import type { InvoiceIssuer, OrderDesk, PaymentGateway, StockService } from "./services.js";

// Method names are PascalCase because the skail URI is <workload>/<method>: the web app triggers <workload>/CloseOrder,
// and the Monitor lists each step by its method name.
export class SagaFunctions {
  constructor(
    private readonly stock: StockService,
    private readonly gateway: PaymentGateway,
    private readonly issuer: InvoiceIssuer,
    private readonly desk: OrderDesk,
  ) {}

  /**
   * Reserves the stock, charges the card and issues the invoice. When a step does not work out, it undoes the previous
   * ones in reverse order: an if for what the business refuses, a try/catch for a service that stayed down. The catch
   * rethrows SkailNonDeterministicError, because it means the code and the run history diverged.
   */
  @SkailFunction()
  async CloseOrder(order: Order): Promise<string> {
    const reservation = await this.ReserveStock(order.id, order.product, order.quantity);
    if (!reservation.confirmed) {
      await this.NotifyCustomer(order.id, "Out of stock. Nothing was charged.");
      return this.RecordResult(order.id, SagaResults.outOfStock);
    }

    let charge: Charge;
    try {
      charge = await this.ChargeCard(order.id, order.amount);
    } catch (error) {
      if (error instanceof SkailNonDeterministicError) throw error;
      charge = declined("payment gateway down"); // every attempt failed
    }

    if (!charge.approved) {
      await this.ReleaseStock(reservation.id!);
      await this.NotifyCustomer(order.id, `Payment not approved (${charge.reason}). The order was cancelled.`);
      return this.RecordResult(order.id, SagaResults.paymentDeclined);
    }

    let invoice: TaxInvoice;
    try {
      invoice = await this.IssueInvoice(order.id, order.product, order.amount);
    } catch (error) {
      if (error instanceof SkailNonDeterministicError) throw error;
      invoice = rejected("invoice issuer down");
    }

    if (!invoice.authorized) {
      await this.RefundCharge(charge.id!); // reverse order: the refund first,
      await this.ReleaseStock(reservation.id!); // then the stock
      await this.NotifyCustomer(
        order.id,
        `We could not issue the invoice (${invoice.reason}). The amount was refunded and the order cancelled.`,
      );
      return this.RecordResult(order.id, SagaResults.cancelledWithRefund);
    }

    await this.NotifyCustomer(order.id, `Order confirmed! Invoice ${invoice.number}.`);
    return this.RecordResult(order.id, SagaResults.confirmed);
  }

  @SkailCommand()
  async ReserveStock(orderId: string, product: string, quantity: number): Promise<Reservation> {
    return this.stock.reserve(orderId, product, quantity);
  }

  // A timeout or a network error throws, and skail runs the command again (up to 3 times here). The order id is the
  // idempotency key, so a new attempt does not charge twice. A declined card comes back as a result, because another
  // attempt would not change the bank's answer.
  @SkailCommand({ retryCount: 3 })
  async ChargeCard(orderId: string, amount: number): Promise<Charge> {
    return this.gateway.charge(orderId, amount);
  }

  @SkailCommand()
  async IssueInvoice(orderId: string, product: string, amount: number): Promise<TaxInvoice> {
    return this.issuer.issue(orderId, product, amount);
  }

  // Compensations

  @SkailCommand()
  async RefundCharge(chargeId: string): Promise<void> {
    await this.gateway.refund(chargeId);
  }

  @SkailCommand()
  async ReleaseStock(reservationId: string): Promise<void> {
    await this.stock.release(reservationId);
  }

  @SkailCommand()
  async NotifyCustomer(orderId: string, message: string): Promise<void> {
    await this.desk.notifyCustomer(orderId, message);
  }

  /** Records how the order ended, for the page, and returns that result to the function. */
  @SkailCommand()
  async RecordResult(orderId: string, result: string): Promise<string> {
    await this.desk.recordResult(orderId, result);
    return result;
  }
}
