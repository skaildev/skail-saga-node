import type {
  Charge,
  ChargeRequest,
  InvoiceRequest,
  NotifyCustomerRequest,
  RecordResultRequest,
  Reservation,
  ReserveRequest,
  TaxInvoice,
} from "@skail-saga/contracts";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;

// The systems the saga talks to. In this demo all four are simulated by the web app; in your system they would be the
// stock service, the payment gateway, the invoice issuer and the customer messaging.

export interface StockService {
  /** Idempotent by order id. */
  reserve(orderId: string, product: string, quantity: number): Promise<Reservation>;
  /** Compensation. Idempotent by reservation id. */
  release(reservationId: string): Promise<void>;
}

export interface PaymentGateway {
  /**
   * Charges the card on file for the order. The order id is the idempotency key: a retry does not charge twice. A
   * timeout or a network error throws, and skail retries; a declined card comes back as a result.
   */
  charge(orderId: string, amount: number): Promise<Charge>;
  /** Compensation. Idempotent by charge id. */
  refund(chargeId: string): Promise<void>;
}

export interface InvoiceIssuer {
  /** Idempotent by order id. A rejection comes back as a result. */
  issue(orderId: string, product: string, amount: number): Promise<TaxInvoice>;
}

export interface OrderDesk {
  /** The e-mail to the customer. Idempotent by order id and message. */
  notifyCustomer(orderId: string, message: string): Promise<void>;
  /** Tells the page how the order ended. Idempotent. */
  recordResult(orderId: string, result: string): Promise<void>;
}

/** The four services over HTTP, on the internal routes of the web app. */
export class HttpServices implements StockService, PaymentGateway, InvoiceIssuer, OrderDesk {
  readonly #base: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: Fetch = (url, init) => fetch(url, init),
  ) {
    this.#base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  }

  reserve(orderId: string, product: string, quantity: number): Promise<Reservation> {
    const body: ReserveRequest = { orderId, product, quantity };
    return this.#json("internal/stock/reservations", body, "stock reservation");
  }

  release(reservationId: string): Promise<void> {
    return this.#send(
      `internal/stock/reservations/${encodeURIComponent(reservationId)}/release`,
      undefined,
      "stock release",
    );
  }

  // A 504 (the simulated gateway did not answer in time) throws here, like a real timeout, and skail retries the command.
  charge(orderId: string, amount: number): Promise<Charge> {
    const body: ChargeRequest = { orderId, amount };
    return this.#json("internal/payments/charges", body, "charge");
  }

  refund(chargeId: string): Promise<void> {
    return this.#send(`internal/payments/charges/${encodeURIComponent(chargeId)}/refund`, undefined, "refund");
  }

  issue(orderId: string, product: string, amount: number): Promise<TaxInvoice> {
    const body: InvoiceRequest = { orderId, product, amount };
    return this.#json("internal/invoices", body, "invoice");
  }

  notifyCustomer(orderId: string, message: string): Promise<void> {
    const body: NotifyCustomerRequest = { message };
    return this.#send(`internal/orders/${encodeURIComponent(orderId)}/customer-messages`, body, "customer message");
  }

  recordResult(orderId: string, result: string): Promise<void> {
    const body: RecordResultRequest = { result };
    return this.#send(`internal/orders/${encodeURIComponent(orderId)}/result`, body, "result");
  }

  async #send(route: string, body: unknown, what: string): Promise<void> {
    const response = await this.#post(route, body);
    if (!response.ok) throw new Error(`Web app answered ${response.status} to the ${what}`);
  }

  async #json<T>(route: string, body: unknown, what: string): Promise<T> {
    const response = await this.#post(route, body);
    if (!response.ok) throw new Error(`Web app answered ${response.status} to the ${what}`);
    return (await response.json()) as T;
  }

  // The release and the refund have no body, so they go without content-type: the web app refuses an empty JSON body.
  #post(route: string, body: unknown): Promise<Response> {
    const json = body !== undefined;
    return this.fetchImpl(`${this.#base}${route}`, {
      method: "POST",
      headers: json ? { "content-type": "application/json" } : undefined,
      body: json ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
}
