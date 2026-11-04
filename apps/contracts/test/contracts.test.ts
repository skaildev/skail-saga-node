import { describe, expect, it } from "vitest";
import { SagaResults, declined, isTerminal, money, orderStateOfResult, rejected } from "../src/index.js";

describe("contracts", () => {
  it.each([
    [SagaResults.confirmed, "Confirmed"],
    [SagaResults.outOfStock, "OutOfStock"],
    [SagaResults.paymentDeclined, "Declined"],
    [SagaResults.cancelledWithRefund, "Refunded"],
  ] as const)("each result of the saga is its own terminal state: %s", (result, state) => {
    expect(orderStateOfResult(result)).toBe(state);
    expect(isTerminal(state)).toBe(true);
  });

  it("an unknown result is not terminal", () => {
    expect(isTerminal(orderStateOfResult("something else"))).toBe(false);
    expect(isTerminal(orderStateOfResult(undefined))).toBe(false);
  });

  it("knows the states that are not terminal", () => {
    expect(["Received", "NotAccepted", "Running"].some((s) => isTerminal(s as never))).toBe(false);
  });

  it("builds the declined charge and the rejected invoice as results", () => {
    expect(declined("insufficient funds")).toEqual({ approved: false, id: null, reason: "insufficient funds" });
    expect(rejected("no NCM")).toEqual({ authorized: false, number: null, reason: "no NCM" });
  });

  it("writes money with two decimals", () => {
    expect(money(1200)).toBe("R$ 1200.00");
    expect(money(59.9)).toBe("R$ 59.90");
  });
});
