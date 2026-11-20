import type { Order } from "./model.js";

export interface SkailApiOptions {
  /** Base URL of the skail HTTP API, without /api/v1: SKAIL_BASE_URL or, when it is not set, SKAIL_SIDECAR. */
  baseUrl: string;
  /** SKAIL_NAMESPACE (tenant/environment), sent in the Skail-namespace header. */
  namespace: string;
  /** SKAIL_KEY, sent in the skail-key and Authorization headers. Secret. */
  key: string;
  /** SKAIL_WORKLOAD as name:version, exactly as registered in the portal. */
  workload: string;
}

export function skailApiOptionsFromEnvironment(env: NodeJS.ProcessEnv = process.env): SkailApiOptions {
  return {
    baseUrl: env.SKAIL_BASE_URL?.trim() || env.SKAIL_SIDECAR?.trim() || "",
    namespace: env.SKAIL_NAMESPACE ?? "",
    key: env.SKAIL_KEY ?? "",
    workload: env.SKAIL_WORKLOAD ?? "",
  };
}

export class SkailApiError extends Error {
  override name = "SkailApiError";
}

const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 10_000;
const FUNCTION_NAME = "CloseOrder";

/**
 * Starts runs through the skail HTTP API: POST {SKAIL_BASE_URL}/api/v1/trigger/{name}/{version}/CloseOrder/{runId}.
 * The call is outside skail's durability, so transient failures are retried here with the same id and body.
 */
export class SkailApiClient {
  constructor(private readonly options: SkailApiOptions) {}

  async trigger(runId: string, order: Order): Promise<void> {
    const [name, version] = splitWorkload(this.options.workload);
    const route = `api/v1/trigger/${escape(name)}/${escape(version)}/${FUNCTION_NAME}/${escape(runId)}`;
    // the arguments of CloseOrder(order), in order
    return this.#post(route, JSON.stringify([order]));
  }

  async #post(route: string, body: string): Promise<void> {
    if (!this.options.baseUrl) throw new SkailApiError("SKAIL_BASE_URL is not set");

    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/${route}`;
    let failure = "";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "skail-key": this.options.key,
            authorization: `Bearer ${this.options.key}`,
            "skail-namespace": this.options.namespace,
          },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (response.ok) return;

        failure = `skail answered ${response.status}`;
        if (response.status === 401 || response.status === 403) {
          throw new SkailApiError(`${failure}: check SKAIL_KEY and SKAIL_NAMESPACE`);
        }
        if (response.status !== 429 && response.status < 500) throw new SkailApiError(failure);
      } catch (error) {
        if (error instanceof SkailApiError) throw error;
        failure = error instanceof Error ? error.message : String(error); // network error or timeout
      }

      if (attempt < MAX_ATTEMPTS)
        await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 200 * 2 ** (attempt - 1))));
    }

    throw new SkailApiError(`giving up after ${MAX_ATTEMPTS} attempts: ${failure}`);
  }
}

// SKAIL_WORKLOAD is name:version; both parts are path segments of the trigger route
function splitWorkload(workload: string): [string, string] {
  const parts = workload.split(":");
  if (parts.length !== 2 || parts.some((p) => !p.trim())) {
    throw new SkailApiError(`SKAIL_WORKLOAD must be name:version, got '${workload}'`);
  }
  return [parts[0]!, parts[1]!];
}

const escape = encodeURIComponent;
