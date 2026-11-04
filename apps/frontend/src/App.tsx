import { useState } from "react";
import type { NewOrder, StateView } from "@skail-saga/contracts";
import { placeOrder, resetDemo } from "./api";
import { OrderCard, StockTable } from "./components/Orders";
import { useStateStream } from "./hooks/useStateStream";

const SCENARIOS: { label: string; hint: string; order: NewOrder }[] = [
  {
    label: "Confirmed",
    hint: "the gateway times out once, then it goes through",
    order: { product: "Monitor", quantity: 1, amount: 1200, card: "4111111111111111" },
  },
  {
    label: "Card declined",
    hint: "the stock comes back",
    order: { product: "Monitor", quantity: 1, amount: 1200, card: "4000000000000002" },
  },
  {
    label: "Invoice rejected",
    hint: "the charge is refunded, then the stock comes back",
    order: { product: "Cabo HDMI", quantity: 2, amount: 60, card: "4111111111111111" },
  },
  {
    label: "Out of stock",
    hint: "nothing is charged",
    order: { product: "Monitor", quantity: 6, amount: 7200, card: "4111111111111111" },
  },
];

export function App() {
  const [state, setState] = useState<StateView>({ stock: [], orders: [] });
  const [sent, setSent] = useState("");
  const [error, setError] = useState<string | null>(null);

  useStateStream(setState);

  async function onScenario(order: NewOrder) {
    setError(null);
    setSent("placing the order…");
    try {
      const outcome = await placeOrder(order);
      setSent(
        `${outcome.orderId ?? "order"} → ${outcome.status}${outcome.taskId ? ` · execution ${outcome.taskId.slice(0, 8)}` : ""}`,
      );
      if (outcome.status >= 400) setError(outcome.error ?? `the order API answered ${outcome.status}`);
    } catch (e) {
      setSent("");
      setError(`could not reach the order API: ${(e as Error).message}`);
    }
  }

  async function onReset() {
    setError(null);
    await resetDemo();
    setSent("");
  }

  return (
    <main>
      <header>
        <h1>Order saga</h1>
        <p className="subtitle">
          A skail function closes an order: it reserves the stock, charges the card and issues the invoice. If a step
          does not work out, it undoes the previous ones in reverse order, with plain <code>if</code> and{" "}
          <code>try/catch</code>.
        </p>
      </header>

      <section aria-label="Place an order">
        <h2>Place an order</h2>
        <p className="hint">
          Four orders, four paths. Each button places an order and starts a <code>CloseOrder</code> execution in skail.
        </p>
        <div className="buttons">
          {SCENARIOS.map((s) => (
            <button key={s.label} type="button" onClick={() => void onScenario(s.order)}>
              {s.label}
              <small>{s.hint}</small>
            </button>
          ))}
        </div>
        <div className="buttons">
          <button type="button" className="secondary" onClick={() => void onReset()}>
            Reset demo
          </button>
          {sent && <span className="sent">{sent}</span>}
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      <section>
        <h2>Stock</h2>
        <StockTable stock={state.stock} />
        <p className="hint">A reservation that is undone puts the units back.</p>
      </section>

      <section>
        <h2>Orders</h2>
        {state.orders.length === 0 && <p className="hint">No orders yet.</p>}
        {[...state.orders].reverse().map((o) => (
          <OrderCard key={o.orderId} order={o} />
        ))}
        <p className="hint">
          Each order lists what happened outside, in order. ↩ marks a compensation: it undoes a step that came before.
          Execution is the task id in skail; search for it in the Monitor.
        </p>
      </section>
    </main>
  );
}
