import { describe, expect, it } from "vitest";
import { HttpServices } from "../src/services.js";

function recorder(status: number, json?: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(json === undefined ? null : JSON.stringify(json), { status });
  };
  return { calls, services: new HttpServices("http://web:8080", fetchImpl) };
}

const body = (call: { init: RequestInit | undefined }) => JSON.parse(String(call.init?.body));

describe("HttpServices", () => {
  it("reserves the stock and reads the reservation", async () => {
    const { calls, services } = recorder(200, { confirmed: true, id: "RES-P-10" });

    expect(await services.reserve("P-10", "Monitor", 1)).toEqual({ confirmed: true, id: "RES-P-10" });
    expect(calls[0]!.url).toBe("http://web:8080/internal/stock/reservations");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(body(calls[0]!)).toEqual({ orderId: "P-10", product: "Monitor", quantity: 1 });
    expect(new Headers(calls[0]!.init?.headers).get("content-type")).toBe("application/json");
  });

  it("releases through the reservation route", async () => {
    const { calls, services } = recorder(204);
    await services.release("RES-P-10");
    expect(calls[0]!.url).toBe("http://web:8080/internal/stock/reservations/RES-P-10/release");
  });

  it("sends the release and the refund with no body and no content-type, which the web app would refuse", async () => {
    const { calls, services } = recorder(204);
    await services.release("RES-P-10");
    await services.refund("COB-P-10");

    for (const call of calls) {
      expect(call.init?.body).toBeUndefined();
      expect(new Headers(call.init?.headers).has("content-type")).toBe(false);
    }
  });

  it("charges the card on file with the order id as the idempotency key", async () => {
    const { calls, services } = recorder(200, { approved: true, id: "COB-P-10", reason: null });

    expect(await services.charge("P-10", 1200)).toEqual({ approved: true, id: "COB-P-10", reason: null });
    expect(calls[0]!.url).toBe("http://web:8080/internal/payments/charges");
    expect(body(calls[0]!)).toEqual({ orderId: "P-10", amount: 1200 });
  });

  it("a declined card comes back as a result", async () => {
    const { services } = recorder(200, { approved: false, id: null, reason: "insufficient funds" });
    expect(await services.charge("P-10", 1200)).toMatchObject({ approved: false, reason: "insufficient funds" });
  });

  it.each([504, 500])("a %i from the charge throws, so skail retries the command", async (status) => {
    const { services } = recorder(status);
    await expect(services.charge("P-10", 1200)).rejects.toThrow(new RegExp(String(status)));
  });

  it("refunds through the charge route", async () => {
    const { calls, services } = recorder(204);
    await services.refund("COB-P-10");
    expect(calls[0]!.url).toBe("http://web:8080/internal/payments/charges/COB-P-10/refund");
  });

  it("issues the invoice and reads the result", async () => {
    const { calls, services } = recorder(200, { authorized: false, number: null, reason: "no NCM" });

    expect(await services.issue("P-10", "Cabo HDMI", 1200)).toMatchObject({ authorized: false });
    expect(calls[0]!.url).toBe("http://web:8080/internal/invoices");
    expect(body(calls[0]!)).toEqual({ orderId: "P-10", product: "Cabo HDMI", amount: 1200 });
  });

  it("notifies the customer and records the result", async () => {
    const { calls, services } = recorder(204);
    await services.notifyCustomer("P-10", "Order confirmed!");
    await services.recordResult("P-10", "confirmed");

    expect(calls.map((c) => c.url)).toEqual([
      "http://web:8080/internal/orders/P-10/customer-messages",
      "http://web:8080/internal/orders/P-10/result",
    ]);
    expect(body(calls[0]!)).toEqual({ message: "Order confirmed!" });
    expect(body(calls[1]!)).toEqual({ result: "confirmed" });
  });

  it("throws on any error from the web app", async () => {
    const { services } = recorder(500);
    await expect(services.reserve("P-10", "Monitor", 1)).rejects.toThrow(/500/);
    await expect(services.release("RES-P-10")).rejects.toThrow(/500/);
    await expect(services.refund("COB-P-10")).rejects.toThrow(/500/);
    await expect(services.issue("P-10", "Monitor", 1200)).rejects.toThrow(/500/);
    await expect(services.notifyCustomer("P-10", "x")).rejects.toThrow(/500/);
    await expect(services.recordResult("P-10", "x")).rejects.toThrow(/500/);
  });

  it("gives every call a timeout, so a web app that hangs fails the command and skail retries it", async () => {
    const { calls, services } = recorder(204);
    await services.release("RES-P-10");
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("accepts a base url with or without the trailing slash", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => (calls.push(url), new Response(null, { status: 204 }));
    await new HttpServices("http://web:8080/", fetchImpl).release("RES-P-10");
    expect(calls[0]).toBe("http://web:8080/internal/stock/reservations/RES-P-10/release");
  });
});
