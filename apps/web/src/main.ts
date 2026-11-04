import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { SkailApiGateway, skailOptionsFromEnvironment } from "./gateway.js";
import { SagaStore } from "./saga-store.js";

const staticDir = process.env.STATIC_DIR ?? fileURLToPath(new URL("../../frontend/dist", import.meta.url));
const app = createApp({
  store: new SagaStore(),
  gateway: new SkailApiGateway(skailOptionsFromEnvironment()),
  staticDir,
  logger: true,
});

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}

await app.listen({ port, host });
console.log(`Saga web listening on http://${host}:${port} (static: ${staticDir})`);
