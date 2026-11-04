import { describe, expect, it } from "vitest";
import type { Order } from "@skail-saga/contracts";
import { SkailApiGateway, SkailGatewayError, skailOptionsFromEnvironment, type SkailOptions } from "../src/gateway.js";

const order: Order = { id: "P-10", product: "Monitor", quantity: 1, amount: 1200 };

const options: SkailOptions = {
  baseUrl: "https://skail.example.test/",
  namespace: "tenant-1/env-1",
  key: "env-key",
  workload: "saga:v0.0.1",
};

interface Call {
  url: string;
  headers: Headers;
  body: string;
  signal: AbortSignal | null | undefined;
}

function gateway(answers: Array<number | Error>, opts: SkailOptions = options) {
  const calls: Call[] = [];
  const g = new SkailApiGateway(
    opts,
    async (url, init) => {
      calls.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: String(init?.body),
        signal: init?.signal,
      });
      const next = answers[Math.min(calls.length - 1, answers.length - 1)]!;
      if (next instanceof Error) throw next;
      return new Response("{}", { status: next });
    },
    () => 0,
  );
  return { g, calls };
}

describe("SkailApiGateway", () => {
  it("triggers CloseOrder on the workload route with [order] and the skail headers", async () => {
    const { g, calls } = gateway([200]);
    await g.trigger("task-1", order);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://skail.example.test/api/v1/trigger/saga/v0.0.1/CloseOrder/task-1");
    expect(calls[0]!.headers.get("skail-key")).toBe("env-key");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer env-key");
    expect(calls[0]!.headers.get("skail-namespace")).toBe("tenant-1/env-1");
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    expect(calls[0]!.headers.get("accept")).toBe("application/json");
    expect(JSON.parse(calls[0]!.body)).toEqual([order]);
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal); // a hung call times out and is retried
  });

  it("escapes the execution id in the route", async () => {
    const { g, calls } = gateway([200]);
    await g.trigger("a b/c", order);
    expect(calls[0]!.url).toMatch(/\/CloseOrder\/a%20b%2Fc$/);
  });

  it.each([429, 502, 503])("retries %i with the same url and body, then succeeds", async (status) => {
    const { g, calls } = gateway([status, status, 200]);
    await g.trigger("task-1", order);

    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.url)).size).toBe(1);
    expect(new Set(calls.map((c) => c.body)).size).toBe(1);
  });

  it("retries network errors", async () => {
    const { g, calls } = gateway([new Error("ECONNRESET"), 200]);
    await g.trigger("task-1", order);
    expect(calls).toHaveLength(2);
  });

  it("gives up after 5 attempts", async () => {
    const { g, calls } = gateway([503]);
    await expect(g.trigger("task-1", order)).rejects.toThrow(/giving up after 5 attempts/);
    expect(calls).toHaveLength(5);
  });

  it.each([401, 403])("does not retry %i and tells what to check", async (status) => {
    const { g, calls } = gateway([status]);
    const error = await g.trigger("task-1", order).catch((e) => e);

    expect(error).toBeInstanceOf(SkailGatewayError);
    expect(error.message).toContain(String(status));
    expect(error.message).toContain("SKAIL_KEY");
    expect(calls).toHaveLength(1);
  });

  it("does not retry another 4xx", async () => {
    const { g, calls } = gateway([404]);
    await expect(g.trigger("task-1", order)).rejects.toThrow(/404/);
    expect(calls).toHaveLength(1);
  });

  it.each(["", "saga", ":v1", "saga:"])("rejects the invalid workload '%s' before any call", async (workload) => {
    const { g, calls } = gateway([200], { ...options, workload });
    await expect(g.trigger("task-1", order)).rejects.toThrow(/SKAIL_WORKLOAD/);
    expect(calls).toHaveLength(0);
  });

  it("fails before any call when SKAIL_BASE_URL is missing", async () => {
    const { g, calls } = gateway([200], { ...options, baseUrl: "" });
    await expect(g.trigger("task-1", order)).rejects.toThrow(/SKAIL_BASE_URL/);
    expect(calls).toHaveLength(0);
  });

  it("reads the options from the environment, the API address from SKAIL_BASE_URL", () => {
    expect(
      skailOptionsFromEnvironment({
        SKAIL_BASE_URL: "https://env.example.test",
        SKAIL_NAMESPACE: "t/e",
        SKAIL_KEY: "k",
        SKAIL_WORKLOAD: "w:v1",
        SKAIL_SIDECAR: "https://ignored.example.test",
      }),
    ).toEqual({ baseUrl: "https://env.example.test", namespace: "t/e", key: "k", workload: "w:v1" });
  });
});
