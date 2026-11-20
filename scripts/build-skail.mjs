// Builds the skail bundle (functions + manifest) into .skail/. The workload is fixed in the bundle, so it is read
// here, from the environment or .env: rebuild after changing SKAIL_WORKLOAD.
import { buildSkail } from "@skail/build";

try {
  process.loadEnvFile();
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const workload = process.env.SKAIL_WORKLOAD;
if (!workload) {
  console.error("SKAIL_WORKLOAD is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const manifest = await buildSkail({
  entryPoint: "src/skail-functions.ts",
  workload,
  outfile: ".skail/skail-functions.mjs",
  manifestFile: ".skail/manifest.json",
});
console.log(`Built ${manifest.methods.length} skail methods for ${workload}`);
