import { beforeEach, describe, expect, it } from "vitest";
import type { NewOrder, StateView } from "@skail-saga/contracts";
import { SagaStore } from "../src/saga-store.js";

let store: SagaStore;
beforeEach(() => {
  store = new SagaStore();
});

const place = (patch: Partial<NewOrder> = {}) =>
  store.createOrder(
    { product: "Monitor", quantity: 1, amount: 1200, card: "4111111111111111", ...patch },
    crypto.randomUUID(),
  );
const view = (orderId: string) => store.snapshot().orders.find((o) => o.orderId === orderId)!;
const stock = (product: string) => store.snapshot().stock.find((s) => s.product === product)!;
const kinds = (orderId: string) => view(orderId).steps.map((s) => s.kind);

/** Two charge attempts: the first one always times out. */
function chargeThrough(orderId: string, amount = 1200) {
  store.chargeCard({ orderId, amount });
  return store.chargeCard({ orderId, amount });
}

describe("orders", () => {
  it("gets sequential ids starting at P-10", () => {
    expect(place().id).toBe("P-10");
    expect(place().id).toBe("P-11");
  });

  it("keeps the card on file: the order that goes to skail has none, and the view masks it", () => {
    const order = place({ card: "4111111111111111" });
    expect(order).toEqual({ id: "P-10", product: "Monitor", quantity: 1, amount: 1200 });
    expect(view(order.id).card).toBe("•••• 1111");
  });

  it("marks an order the skail server did not accept, until it is accepted", () => {
    const order = place();
    store.markNotAccepted(order.id);
    expect(view(order.id).state).toBe("NotAccepted");

    store.markAccepted(order.id);
    expect(view(order.id).state).toBe("Received");
  });
});

describe("stock", () => {
  it("takes the reserved units out of the available stock", () => {
    const order = place({ quantity: 2 });

    const reservation = store.reserve({ orderId: order.id, product: "Monitor", quantity: 2 });

    expect(reservation).toEqual({ confirmed: true, id: `RES-${order.id}` });
    expect(stock("Monitor")).toEqual({ product: "Monitor", available: 3, reserved: 2 });
    expect(kinds(order.id)).toEqual(["StockReserved"]);
  });

  it("does not take more units when the same order reserves again", () => {
    const order = place();
    store.reserve({ orderId: order.id, product: "Monitor", quantity: 1 });
    expect(store.reserve({ orderId: order.id, product: "Monitor", quantity: 1 }).confirmed).toBe(true);

    expect(stock("Monitor")).toEqual({ product: "Monitor", available: 4, reserved: 1 });
    expect(view(order.id).steps).toHaveLength(1);
  });

  it("answers with a result, and reserves nothing, when there is not enough", () => {
    const order = place({ quantity: 6 });

    expect(store.reserve({ orderId: order.id, product: "Monitor", quantity: 6 })).toEqual({
      confirmed: false,
      id: null,
    });
    expect(stock("Monitor")).toEqual({ product: "Monitor", available: 5, reserved: 0 });
    expect(kinds(order.id)).toEqual(["OutOfStock"]);
  });

  it("has no stock of an unknown product", () => {
    const order = place({ product: "Mouse" });
    expect(store.reserve({ orderId: order.id, product: "Mouse", quantity: 1 }).confirmed).toBe(false);
  });

  it("puts the units back once, as a compensation", () => {
    const order = place();
    const reservation = store.reserve({ orderId: order.id, product: "Monitor", quantity: 1 });

    expect(store.releaseStock(reservation.id!)).toBe(true);
    expect(store.releaseStock(reservation.id!)).toBe(true);

    expect(stock("Monitor")).toEqual({ product: "Monitor", available: 5, reserved: 0 });
    expect(view(order.id).steps[1]).toEqual({
      kind: "StockReleased",
      detail: "1 × Monitor back to stock",
      compensation: true,
    });
    expect(view(order.id).steps).toHaveLength(2);
  });

  it("reports the release of an unknown reservation", () => {
    expect(store.releaseStock("RES-nope")).toBe(false);
  });
});

describe("payment gateway", () => {
  it("times out on the first attempt of each order and goes through on the second", () => {
    const order = place();
    const request = { orderId: order.id, amount: 1200 };

    expect(store.chargeCard(request)).toEqual({ timedOut: true });
    expect(store.chargeCard(request)).toEqual({
      timedOut: false,
      charge: { approved: true, id: `COB-${order.id}`, reason: null },
    });
    expect(kinds(order.id)).toEqual(["ChargeTimeout", "ChargeApproved"]);
  });

  it("does not charge again an order that was already charged", () => {
    const order = place();
    chargeThrough(order.id);

    const third = store.chargeCard({ orderId: order.id, amount: 1200 });

    expect(third).toMatchObject({ timedOut: false, charge: { id: `COB-${order.id}` } });
    expect(view(order.id).steps).toHaveLength(2); // the timeout and the one charge
  });

  it("declines a card ending in 0002, as a result", () => {
    const order = place({ card: "4000000000000002" });

    const outcome = chargeThrough(order.id);

    expect(outcome).toEqual({ timedOut: false, charge: { approved: false, id: null, reason: "insufficient funds" } });
    expect(kinds(order.id).at(-1)).toBe("ChargeDeclined");
  });

  it("declines an order it does not know, because there is no card on file", () => {
    expect(chargeThrough("P-99")).toEqual({
      timedOut: false,
      charge: { approved: false, id: null, reason: "no card on file" },
    });
  });

  it("refunds once, as a compensation", () => {
    const order = place({ amount: 60 });
    const outcome = chargeThrough(order.id, 60);
    const id = outcome.timedOut ? "" : outcome.charge.id!;

    expect(store.refund(id)).toBe(true);
    expect(store.refund(id)).toBe(true);

    const refunds = view(order.id).steps.filter((s) => s.kind === "ChargeRefunded");
    expect(refunds).toEqual([{ kind: "ChargeRefunded", detail: "R$ 60.00 refunded", compensation: true }]);
  });

  it("reports the refund of an unknown charge", () => {
    expect(store.refund("COB-nope")).toBe(false);
  });
});

describe("invoice issuer", () => {
  it.each(["Monitor", "Teclado"])("authorizes the invoice of %s, which has a tax registration", (product) => {
    const order = place({ product });

    const invoice = store.issueInvoice({ orderId: order.id, product, amount: 100 });

    expect(invoice.authorized).toBe(true);
    expect(invoice.number).toMatch(/^NF-/);
    expect(kinds(order.id)).toEqual(["InvoiceAuthorized"]);
  });

  it("rejects the invoice of a product without a tax registration", () => {
    const order = place({ product: "Cabo HDMI" });

    expect(store.issueInvoice({ orderId: order.id, product: "Cabo HDMI", amount: 60 })).toEqual({
      authorized: false,
      number: null,
      reason: "Cabo HDMI has no NCM registered",
    });
    expect(kinds(order.id)).toEqual(["InvoiceRejected"]);
  });

  it("gives the same invoice when it is issued twice for the same order", () => {
    const order = place();
    const first = store.issueInvoice({ orderId: order.id, product: "Monitor", amount: 1200 });

    expect(store.issueInvoice({ orderId: order.id, product: "Monitor", amount: 1200 })).toEqual(first);
    expect(view(order.id).steps).toHaveLength(1);
  });
});

describe("customer and result", () => {
  it("sends the same message to the customer once", () => {
    const order = place();
    store.notifyCustomer(order.id, "Order confirmed!");
    store.notifyCustomer(order.id, "Order confirmed!");

    expect(view(order.id).steps).toEqual([
      { kind: "CustomerNotified", detail: "Order confirmed!", compensation: false },
    ]);
  });

  it("moves the order to Running with the first step", () => {
    const order = place();
    expect(view(order.id).state).toBe("Received");

    store.reserve({ orderId: order.id, product: "Monitor", quantity: 1 });

    expect(view(order.id).state).toBe("Running");
  });

  it.each([
    ["confirmed", "Confirmed"],
    ["out of stock", "OutOfStock"],
    ["payment declined", "Declined"],
    ["cancelled with refund", "Refunded"],
  ])("recording '%s' ends in %s", (result, state) => {
    const order = place();

    expect(store.recordResult(order.id, result)).toBe(true);

    expect(view(order.id)).toMatchObject({ state, result });
  });

  it("ignores a second result and an unknown order", () => {
    const order = place();
    store.recordResult(order.id, "confirmed");

    expect(store.recordResult(order.id, "payment declined")).toBe(false);
    expect(store.recordResult("P-99", "confirmed")).toBe(false);
    expect(view(order.id).state).toBe("Confirmed");
  });
});

describe("the saga on the store", () => {
  it("a rejected invoice undoes the charge first and then the stock", () => {
    const order = place({ product: "Cabo HDMI", quantity: 2, amount: 60 });
    const reservation = store.reserve({ orderId: order.id, product: "Cabo HDMI", quantity: 2 });
    const outcome = chargeThrough(order.id, 60);
    store.issueInvoice({ orderId: order.id, product: "Cabo HDMI", amount: 60 });

    store.refund(outcome.timedOut ? "" : outcome.charge.id!);
    store.releaseStock(reservation.id!);

    expect(kinds(order.id)).toEqual([
      "StockReserved",
      "ChargeTimeout",
      "ChargeApproved",
      "InvoiceRejected",
      "ChargeRefunded",
      "StockReleased",
    ]);
    expect(view(order.id).steps.map((s) => s.compensation)).toEqual([false, false, false, false, true, true]);
  });
});

describe("reset and subscribers", () => {
  it("goes back to the seed", () => {
    const order = place();
    store.reserve({ orderId: order.id, product: "Monitor", quantity: 1 });

    store.reset();

    expect(store.snapshot().orders).toEqual([]);
    expect(stock("Monitor")).toEqual({ product: "Monitor", available: 5, reserved: 0 });
    expect(place().id).toBe("P-10");
  });

  it("sends a snapshot to the subscribers on every change, until they unsubscribe", () => {
    const seen: StateView[] = [];
    const unsubscribe = store.subscribe((s) => seen.push(s));

    const order = place();
    store.reserve({ orderId: order.id, product: "Monitor", quantity: 1 });
    unsubscribe();
    store.notifyCustomer(order.id, "x");

    expect(seen).toHaveLength(2);
    expect(seen[1]!.stock.find((s) => s.product === "Monitor")!.reserved).toBe(1);
  });
});
