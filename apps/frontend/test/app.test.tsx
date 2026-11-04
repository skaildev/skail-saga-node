import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderView, StateView } from "@skail-saga/contracts";
import { App } from "../src/App";

const order = (patch: Partial<OrderView> = {}): OrderView => ({
  orderId: "P-10",
  product: "Monitor",
  quantity: 1,
  amount: 1200,
  card: "•••• 1111",
  taskId: "aaaaaaaa-1111-2222-3333-444444444444",
  state: "Running",
  result: null,
  steps: [],
  ...patch,
});

const state = (patch: Partial<StateView> = {}): StateView => ({
  stock: [
    { product: "Monitor", available: 5, reserved: 0 },
    { product: "Teclado", available: 20, reserved: 0 },
  ],
  orders: [],
  ...patch,
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(data: StateView) {
    act(() => this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent));
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let calls: Array<{ url: string; method: string; body?: string }>;
let answers: Record<string, () => Response>;

beforeEach(() => {
  calls = [];
  answers = {};
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body as string | undefined });
    const answer = answers[`${method} ${url}`];
    if (!answer) throw new Error(`unexpected ${method} ${url}`);
    return answer();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const stream = () => FakeEventSource.instances[0]!;

describe("App", () => {
  it("opens the SSE stream and shows the stock", () => {
    render(<App />);
    expect(stream().url).toBe("/api/stream");

    stream().emit(state({ stock: [{ product: "Monitor", available: 4, reserved: 1 }] }));

    const row = screen.getByText("Monitor", { selector: "td" }).closest("tr")!;
    expect(within(row).getByText("4")).toBeInTheDocument();
    expect(within(row).getByText("1")).toBeInTheDocument();
  });

  it("closes the stream when it unmounts", () => {
    const { unmount } = render(<App />);
    unmount();
    expect(stream().closed).toBe(true);
  });

  it("starts with one button per path and nothing ordered", () => {
    render(<App />);

    for (const name of [/^Confirmed/, /^Card declined/, /^Invoice rejected/, /^Out of stock/, "Reset demo"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByText("No orders yet.")).toBeInTheDocument();
  });

  it.each([
    [/^Confirmed/, { product: "Monitor", quantity: 1, amount: 1200, card: "4111111111111111" }],
    [/^Card declined/, { product: "Monitor", quantity: 1, amount: 1200, card: "4000000000000002" }],
    [/^Invoice rejected/, { product: "Cabo HDMI", quantity: 2, amount: 60, card: "4111111111111111" }],
    [/^Out of stock/, { product: "Monitor", quantity: 6, amount: 7200, card: "4111111111111111" }],
  ])("the %s button places its order through the API", async (name, expected) => {
    answers["POST /api/orders"] = () => json({ orderId: "P-10", taskId: "12345678-aaaa-bbbb-cccc-dddddddddddd" });
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name }));

    expect(JSON.parse(calls[0]!.body!)).toEqual(expected);
    expect(await screen.findByText(/P-10 → 200 · execution 12345678/)).toBeInTheDocument();
  });

  it("shows the error when the API answers 502", async () => {
    answers["POST /api/orders"] = () => json({ orderId: "P-10", error: "skail unavailable (skail answered 503)" }, 502);
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: /^Confirmed/ }));

    expect(await screen.findByText("skail unavailable (skail answered 503)")).toBeInTheDocument();
  });

  it("lists the steps of an order in order, and marks the compensations", () => {
    render(<App />);
    stream().emit(
      state({
        orders: [
          order({
            state: "Refunded",
            result: "cancelled with refund",
            steps: [
              { kind: "StockReserved", detail: "2 × Cabo HDMI reserved", compensation: false },
              { kind: "ChargeApproved", detail: "R$ 60.00 charged (attempt 2)", compensation: false },
              {
                kind: "InvoiceRejected",
                detail: "invoice rejected: Cabo HDMI has no NCM registered",
                compensation: false,
              },
              { kind: "ChargeRefunded", detail: "R$ 60.00 refunded", compensation: true },
              { kind: "StockReleased", detail: "2 × Cabo HDMI back to stock", compensation: true },
            ],
          }),
        ],
      }),
    );

    const steps = screen.getAllByRole("listitem");
    expect(steps.map((s) => s.querySelector(".kind")!.textContent)).toEqual([
      "Stock reserved",
      "Card charged",
      "Invoice rejected",
      "Charge refunded",
      "Stock released",
    ]);
    expect(steps.map((s) => s.classList.contains("compensation"))).toEqual([false, false, false, true, true]);
    expect(screen.getByText("Cancelled with refund")).toBeInTheDocument();
    expect(screen.getByText("Result: cancelled with refund")).toBeInTheDocument();
  });

  it("shows the newest order first, with its execution id", () => {
    render(<App />);
    stream().emit(state({ orders: [order({ orderId: "P-10" }), order({ orderId: "P-11", taskId: "bbbbbbbb-1111" })] }));

    const ids = screen.getAllByText(/^P-1\d$/).map((n) => n.textContent);
    expect(ids).toEqual(["P-11", "P-10"]);
    expect(screen.getByText("bbbbbbbb")).toBeInTheDocument();
  });

  it("renders the order data as text, never as HTML", () => {
    render(<App />);
    stream().emit(state({ orders: [order({ product: "<img src=x onerror=alert(1)>" })] }));

    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("'Reset demo' calls the reset endpoint", async () => {
    answers["POST /api/reset"] = () => new Response(null, { status: 204 });
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Reset demo" }));

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/reset"]);
  });
});
