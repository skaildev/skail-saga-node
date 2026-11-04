import { beforeEach, describe, expect, it } from "vitest";
import { EventType, type Provider } from "@skail/runtime";
import { createSkailWorker, type SkailWorker } from "@skail/runtime/testing";
import { InMemorySkailPlatform } from "@skail/testing";
import type { Charge, Order, TaxInvoice } from "@skail-saga/contracts";
import { SagaFunctions } from "../src/saga-functions.js";

const WORKLOAD = "saga:v0.0.1";
const URI = `${WORKLOAD}/CloseOrder`;

/** The outside world, scripted: every call is logged in order, so the tests can read the saga back. */
class World {
  readonly calls: string[] = [];
  readonly messages: string[] = [];
  stockConfirmed = true;
  charge: Charge = { approved: true, id: "COB-P-10", reason: null };
  chargeFailures = 0; // timeouts before the gateway answers
  chargeAlwaysFails = false;
  invoice: TaxInvoice = { authorized: true, number: "NF-10001", reason: null };
  invoiceAlwaysFails = false;
  readonly platform = new InMemorySkailPlatform();
  readonly worker: SkailWorker;
  readonly order: Order = { id: "P-10", product: "Monitor", quantity: 1, amount: 1200 };

  constructor() {
    const saga = new SagaFunctions(
      {
        reserve: async (orderId) => {
          this.calls.push("reserve");
          return this.stockConfirmed ? { confirmed: true, id: `RES-${orderId}` } : { confirmed: false, id: null };
        },
        release: async (id) => void this.calls.push(`release:${id}`),
      },
      {
        charge: async (orderId) => {
          this.calls.push(`charge:${orderId}`);
          if (this.chargeAlwaysFails) throw new Error("gateway down");
          if (this.chargeFailures > 0) {
            this.chargeFailures--;
            throw new Error("Web app answered 504 to the charge");
          }
          return this.charge;
        },
        refund: async (id) => void this.calls.push(`refund:${id}`),
      },
      {
        issue: async () => {
          this.calls.push("issue");
          if (this.invoiceAlwaysFails) throw new Error("issuer down");
          return this.invoice;
        },
      },
      {
        notifyCustomer: async (_id, message) => {
          this.calls.push("notify");
          this.messages.push(message);
        },
        recordResult: async (_id, result) => void this.calls.push(`result:${result}`),
      },
    );
    const providers: Provider[] = [{ token: SagaFunctions, useFactory: () => saga }];
    this.worker = createSkailWorker({ workload: WORKLOAD, types: [SagaFunctions], providers, sidecar: this.platform });
  }

  start() {
    this.platform.start(URI, [this.order], this.order.id);
  }

  async run() {
    return this.worker.runActivation((await this.platform.consume())!);
  }

  /** Runs until the function ends, re-delivering after each command that failed and is retried. */
  async runToEnd(max = 14) {
    let outcome = await this.run();
    for (let i = 0; i < max && outcome.status === "hibernated"; i++) {
      this.platform.enqueue(this.order.id);
      outcome = await this.run();
    }
    return outcome;
  }
}

let w: World;
beforeEach(() => {
  w = new World();
});

describe("CloseOrder", () => {
  it("confirms the order: reserve, charge, invoice, notify, and nothing is undone", async () => {
    w.start();

    expect(await w.runToEnd()).toEqual({ status: "completed", result: "confirmed" });
    expect(w.calls).toEqual(["reserve", "charge:P-10", "issue", "notify", "result:confirmed"]);
    expect(w.messages).toEqual(["Order confirmed! Invoice NF-10001."]);
  });

  it("declined card: releases the stock, tells the customer and never issues the invoice", async () => {
    w.charge = { approved: false, id: null, reason: "insufficient funds" };
    w.start();

    expect(await w.runToEnd()).toEqual({ status: "completed", result: "payment declined" });
    expect(w.calls).toEqual(["reserve", "charge:P-10", "release:RES-P-10", "notify", "result:payment declined"]);
    expect(w.messages[0]).toContain("insufficient funds");
  });

  it("rejected invoice: undoes in reverse order, the refund first and then the stock", async () => {
    w.invoice = { authorized: false, number: null, reason: "Cabo HDMI has no NCM registered" };
    w.start();

    expect(await w.runToEnd()).toEqual({ status: "completed", result: "cancelled with refund" });
    expect(w.calls).toEqual([
      "reserve",
      "charge:P-10",
      "issue",
      "refund:COB-P-10",
      "release:RES-P-10",
      "notify",
      "result:cancelled with refund",
    ]);
    expect(w.messages[0]).toContain("Cabo HDMI has no NCM registered");
  });

  it("out of stock: nothing is charged and nothing needs undoing", async () => {
    w.stockConfirmed = false;
    w.start();

    expect(await w.runToEnd()).toEqual({ status: "completed", result: "out of stock" });
    expect(w.calls).toEqual(["reserve", "notify", "result:out of stock"]);
  });

  it("retries the charge after a gateway timeout, with the same order id, and then confirms", async () => {
    w.chargeFailures = 1;
    w.start();

    expect((await w.run()).status).toBe("hibernated"); // the command failed, skail re-delivers
    w.platform.enqueue(w.order.id);
    expect(await w.run()).toEqual({ status: "completed", result: "confirmed" });

    expect(w.calls.filter((c) => c.startsWith("charge"))).toEqual(["charge:P-10", "charge:P-10"]); // the idempotency key repeats
    expect(w.calls.filter((c) => c === "reserve")).toHaveLength(1); // the finished steps do not run again
  });

  it("a gateway that fails on every attempt becomes a declined payment, and the stock is released", async () => {
    w.chargeAlwaysFails = true;
    w.start();

    expect(await w.runToEnd()).toEqual({ status: "completed", result: "payment declined" });
    expect(w.calls.slice(-3)).toEqual(["release:RES-P-10", "notify", "result:payment declined"]);
    expect(w.messages[0]).toContain("payment gateway down");
    expect(w.calls).not.toContain("issue");
  });

  it("an invoice issuer that is down becomes a rejected invoice: refund, then stock", async () => {
    w.invoiceAlwaysFails = true;
    w.start();

    expect(await w.runToEnd()).toEqual({ status: "completed", result: "cancelled with refund" });
    expect(w.calls.slice(-4)).toEqual([
      "refund:COB-P-10",
      "release:RES-P-10",
      "notify",
      "result:cancelled with refund",
    ]);
    expect(w.messages[0]).toContain("invoice issuer down");
  });

  it("every effect goes through a command; the function itself does no I/O", async () => {
    w.start();
    await w.runToEnd();

    const commands = w.platform
      .history(w.order.id)
      .filter((f) => f.eventType === EventType.Durable)
      .map((f) => (f.targetUri ?? "").split("/").pop());
    expect(commands).toEqual(["ReserveStock", "ChargeCard", "IssueInvoice", "NotifyCustomer", "RecordResult"]);
  });
});
