// Prints SKAIL_WORKLOAD (environment or .env): the workload is fixed in the bundle at build time.
import { loadEnv } from "./env.mjs";

const workload = loadEnv().SKAIL_WORKLOAD;
if (!workload) {
  console.error("SKAIL_WORKLOAD is not set (environment or .env)");
  process.exit(1);
}
console.log(workload);
