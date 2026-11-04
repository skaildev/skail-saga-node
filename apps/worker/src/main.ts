import { createSkailPlatform } from "@skail/runtime";

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort());
}

// SKAIL_WORKLOAD, SKAIL_NAMESPACE, SKAIL_KEY and SKAIL_SIDECAR come from the environment (.env)
const platform = createSkailPlatform({
  bundle: new URL("../.skail/skail-functions.mjs", import.meta.url),
  manifest: new URL("../.skail/manifest.json", import.meta.url),
});

console.log(`Saga worker started for ${platform.options.workload} (skail ${platform.options.sidecar.baseUrl})`);
await platform.run(controller.signal);
