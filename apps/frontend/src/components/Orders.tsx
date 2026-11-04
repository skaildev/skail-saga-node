import { money, type OrderView, type StockView } from "@skail-saga/contracts";

const STATES: Record<OrderView["state"], string> = {
  Received: "Received",
  NotAccepted: "Not accepted",
  Running: "Running",
  Confirmed: "Confirmed",
  OutOfStock: "Out of stock",
  Declined: "Payment declined",
  Refunded: "Cancelled with refund",
};

const KINDS: Record<OrderView["steps"][number]["kind"], string> = {
  StockReserved: "Stock reserved",
  OutOfStock: "Out of stock",
  ChargeTimeout: "Gateway timeout",
  ChargeApproved: "Card charged",
  ChargeDeclined: "Card declined",
  InvoiceAuthorized: "Invoice issued",
  InvoiceRejected: "Invoice rejected",
  ChargeRefunded: "Charge refunded",
  StockReleased: "Stock released",
  CustomerNotified: "Customer notified",
};

export function StockTable({ stock }: { stock: StockView[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Product</th>
          <th>Available</th>
          <th>Reserved</th>
        </tr>
      </thead>
      <tbody>
        {stock.map((s) => (
          <tr key={s.product}>
            <td>{s.product}</td>
            <td>{s.available}</td>
            <td>{s.reserved}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** What happened outside, in order. A compensation (↩) undoes a step that came before it. */
export function OrderCard({ order }: { order: OrderView }) {
  return (
    <article className="order">
      <div className="order-head">
        <span className="id">{order.orderId}</span>
        <span className="meta">{`${order.quantity} × ${order.product} · ${money(order.amount)} · ${order.card}`}</span>
        <span className="meta mono" title={order.taskId}>
          {order.taskId.slice(0, 8)}
        </span>
        <span className={`badge ${order.state}`}>{STATES[order.state]}</span>
      </div>
      {order.steps.length > 0 && (
        <ol className="steps">
          {order.steps.map((step, i) => (
            <li
              key={i}
              className={[step.compensation ? "compensation" : "", step.kind === "ChargeTimeout" ? "timeout" : ""]
                .join(" ")
                .trim()}
            >
              <span className="kind">{KINDS[step.kind]}</span>
              <span className="detail">{step.detail}</span>
            </li>
          ))}
        </ol>
      )}
      {order.result && <p className="result">{`Result: ${order.result}`}</p>}
    </article>
  );
}
