import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createSkailPlatform } from "@skail/runtime";
import { OrderDesk } from "./order-desk.js";
import { GatewayTimeout, SimulatedServices } from "./simulated-services.js";
import { SkailApiClient, skailApiOptionsFromEnvironment } from "./skail-api.js";
import { Timeline } from "./timeline.js";

// usage: npm start [-- resume]
//   then open http://localhost:8080; resume keeps the state the previous run of the app left, to finish its orders
const argument = process.argv
  .slice(2)
  .find((a) => !a.startsWith("-"))
  ?.toLowerCase();
if (argument !== undefined && argument !== "resume") {
  console.error(`Unknown argument '${argument}'. Use resume, or nothing.`);
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
const timeline = new Timeline();
const services =
  argument === "resume" ? SimulatedServices.resume(stateFile, timeline) : SimulatedServices.fresh(stateFile, timeline);
const desk = new OrderDesk(services, new SkailApiClient(skailApiOptionsFromEnvironment()), timeline);

const page = readFileSync(new URL("../page/index.html", import.meta.url));
const port = Number(process.env.DEMO_PORT ?? 8080);
// the page: localhost only, unless DEMO_HOST says otherwise (the container listens on all interfaces)
const host = process.env.DEMO_HOST ?? "127.0.0.1";

// the page, its API, and under /internal/ the simulated services and the timeline, which the commands call
const server = createServer(async (request, response) => {
  const send = (status: number, body?: unknown) =>
    response
      .writeHead(status, { "content-type": "application/json" })
      .end(body === undefined ? "" : JSON.stringify(body));
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/")
      return void response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    if (request.method === "GET" && url.pathname === "/api/state") return send(200, desk.view());
    if (request.method === "POST" && url.pathname === "/api/reset") {
      desk.reset();
      return send(200);
    }

    const place = /^\/api\/orders\/(\w+)$/.exec(url.pathname);
    if (request.method === "POST" && place) return send((await desk.place(place[1]!)) ? 200 : 404);

    if (request.method === "POST" && url.pathname.startsWith("/internal/")) {
      let body = "";
      for await (const chunk of request) body += chunk;
      const data = JSON.parse(body || "{}");
      const route = url.pathname.slice("/internal/".length);
      if (route === "timeline") {
        timeline.add(data.runId, data.text, data.step);
        return send(200);
      }
      return send(200, services.call(route.replace(/^services\//, ""), data) ?? null);
    }
    send(404);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof GatewayTimeout)) console.error(message);
    response.writeHead(error instanceof GatewayTimeout ? 504 : 500).end(message);
  }
});
await new Promise<void>((resolve) => server.listen(port, host, resolve));

// the commands run in an isolated VM and call the app over HTTP; the address goes in the environment before the worker
// starts
process.env.DEMO_INTERNAL_URL = `http://127.0.0.1:${port}`;

// hosts the worker that executes OrderFunctions (the bundle from `npm run build`);
// reads SKAIL_WORKLOAD, SKAIL_NAMESPACE, SKAIL_KEY and SKAIL_SIDECAR from the environment
const platform = createSkailPlatform({
  bundle: new URL("../.skail/skail-functions.mjs", import.meta.url),
  manifest: new URL("../.skail/manifest.json", import.meta.url),
});

const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    shutdown.abort();
  });
}
const worker = platform.run(shutdown.signal);
console.log(
  argument === "resume"
    ? `Resuming: skail hands this app the orders left in the middle. Open http://localhost:${port}. Ctrl+C exits.`
    : `Open http://localhost:${port} to place orders. Ctrl+C exits; npm start -- resume finishes the orders left in the middle.`,
);
await worker;

/** Loads .env from the current directory, when present. Variables already set in the environment win. */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
