import { randomUUID } from "node:crypto";
import { createSkailPlatform } from "@skail/runtime";
import { demoOrders, type DemoOrder } from "./demo-orders.js";
import { SimulatedServices, money } from "./simulated-services.js";
import { SkailApiClient, skailApiOptionsFromEnvironment } from "./skail-api.js";

// usage: npm start [-- confirmed | declined | invoice | stock | resume]
//   no argument: one order per path; a path: only that order; resume: no new orders, finishes the runs left waiting
const argument = process.argv
  .slice(2)
  .find((a) => !a.startsWith("-"))
  ?.toLowerCase();
const resume = argument === "resume";
const orders: readonly DemoOrder[] =
  argument === undefined ? demoOrders : resume ? [] : demoOrders.filter((o) => o.path === argument);
if (!resume && orders.length === 0) {
  console.error(`Unknown argument '${argument}'. Use ${demoOrders.map((o) => o.path).join(", ")} or resume.`);
  process.exit(1);
}

loadDotEnv();
const missing = ["SKAIL_WORKLOAD", "SKAIL_NAMESPACE", "SKAIL_KEY", "SKAIL_SIDECAR"].filter(
  (n) => !process.env[n]?.trim(),
);
if (missing.length > 0) {
  console.error(`Missing ${missing.join(", ")}. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}

// a new demo starts over with full stock; resume picks up the state the previous run of the app left
const stateFile = ".saga-demo.json";
const services = resume ? SimulatedServices.resume(stateFile) : SimulatedServices.fresh(stateFile);

// the commands run in an isolated VM and reach the simulated services over HTTP; the address goes in the environment
// before the worker starts, so the commands can read it
process.env.SAGA_SERVICES_URL = await services.listen();

// hosts the worker that executes OrderFunctions (the bundle from `npm run build`);
// reads SKAIL_WORKLOAD, SKAIL_NAMESPACE, SKAIL_KEY and SKAIL_SIDECAR from the environment
const platform = createSkailPlatform({
  bundle: new URL("../.skail/skail-functions.mjs", import.meta.url),
  manifest: new URL("../.skail/manifest.json", import.meta.url),
});

const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => shutdown.abort());
const worker = platform.run(shutdown.signal);

const skail = new SkailApiClient(skailApiOptionsFromEnvironment());
try {
  if (resume) console.log("Resuming: no new orders. skail hands this app the runs that were waiting.");
  for (const demo of orders) {
    const order = services.placeOrder(demo.product, demo.quantity, demo.amount, demo.card);
    await skail.trigger(randomUUID(), order);
    console.log(
      `[${order.id}] order placed: ${order.quantity} × ${order.product}, ${money(order.amount)}, ` +
        `card …${demo.card.slice(-4)} (expected: ${demo.expected})`,
    );
  }
  console.log("Press Ctrl+C to exit. A run left in the middle goes on when you start the app again with the argument resume.");
} catch (error) {
  console.error(`Could not start the runs: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
  shutdown.abort();
}

await worker;

/** Loads .env from the current directory, when present. Variables already set in the environment win. */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
