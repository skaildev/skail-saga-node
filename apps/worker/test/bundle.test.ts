import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSkail } from "@skail/build";

describe("skail build", () => {
  it("accepts the worker (no forbidden imports) and lists the function and commands as <workload>/<method>", async () => {
    const dir = await mkdtemp(join(tmpdir(), "saga-bundle-"));
    try {
      const manifest = await buildSkail({
        entryPoint: "src/skail-functions.ts",
        workload: "saga:v0.0.1",
        outfile: join(dir, "skail-functions.mjs"),
        manifestFile: join(dir, "manifest.json"),
      });

      expect(manifest.methods.map((m) => [m.kind, m.uri]).sort()).toEqual([
        ["command", "saga:v0.0.1/ChargeCard"],
        ["command", "saga:v0.0.1/IssueInvoice"],
        ["command", "saga:v0.0.1/NotifyCustomer"],
        ["command", "saga:v0.0.1/RecordResult"],
        ["command", "saga:v0.0.1/RefundCharge"],
        ["command", "saga:v0.0.1/ReleaseStock"],
        ["command", "saga:v0.0.1/ReserveStock"],
        ["function", "saga:v0.0.1/CloseOrder"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
