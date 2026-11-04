import type { Order } from "@skail-saga/contracts";

export interface SkailOptions {
  /** SKAIL_BASE_URL: base URL of the skail HTTP API for the environment, without /api/v1. */
  baseUrl: string;
  /** SKAIL_NAMESPACE (tenant/environment), sent in the Skail-namespace header. */
  namespace: string;
  /** SKAIL_KEY, sent in the skail-key and Authorization headers. Secret. */
  key: string;
  /** SKAIL_WORKLOAD as name:version, exactly as registered in the portal. */
  workload: string;
}

export function skailOptionsFromEnvironment(env: NodeJS.ProcessEnv = process.env): SkailOptions {
  return {
    baseUrl: env.SKAIL_BASE_URL ?? "",
    namespace: env.SKAIL_NAMESPACE ?? "",
    key: env.SKAIL_KEY ?? "",
    workload: env.SKAIL_WORKLOAD ?? "",
  };
}

export interface SkailGateway {
  trigger(taskId: string, order: Order): Promise<void>;
}

export class SkailGatewayError extends Error {
  override name = "SkailGatewayError";
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 10_000;
const FUNCTION_NAME = "CloseOrder";

/**
 * Starts runs through the skail HTTP API: POST {SKAIL_BASE_URL}/api/v1/trigger/{name}/{version}/{function}/{id}.
 * The call is outside skail's durability, so transient failures are retried here with the same id and body.
 */
export class SkailApiGateway implements SkailGateway {
  constructor(
    private readonly options: SkailOptions,
    private readonly fetchImpl: Fetch = (url, init) => fetch(url, init),
    private readonly retryDelayMs: (attempt: number) => number = (attempt) => Math.min(2000, 200 * 2 ** (attempt - 1)),
  ) {}

  async trigger(taskId: string, order: Order): Promise<void> {
    const [name, version] = splitWorkload(this.options.workload);
    const route = `api/v1/trigger/${escape(name)}/${escape(version)}/${FUNCTION_NAME}/${escape(taskId)}`;
    return this.#post(route, JSON.stringify([order]));
  }

  async #post(route: string, body: string): Promise<void> {
    if (!this.options.baseUrl.trim()) {
      throw new SkailGatewayError("SKAIL_BASE_URL is not set");
    }

    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/${route}`;
    let failure = "";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            accept: "application/json",
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
          throw new SkailGatewayError(`${failure}: check SKAIL_KEY and SKAIL_NAMESPACE for this environment`);
        }
        if (response.status !== 429 && response.status < 500) throw new SkailGatewayError(failure);
      } catch (error) {
        if (error instanceof SkailGatewayError) throw error;
        failure = error instanceof Error ? error.message : String(error);
      }

      if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs(attempt)));
    }

    throw new SkailGatewayError(`giving up after ${MAX_ATTEMPTS} attempts: ${failure}`);
  }
}

// SKAIL_WORKLOAD is name:version; both parts are path segments of the trigger route
function splitWorkload(workload: string): [string, string] {
  const parts = workload.split(":");
  if (parts.length !== 2 || parts.some((p) => !p.trim())) {
    throw new SkailGatewayError(`SKAIL_WORKLOAD must be name:version, got '${workload}'`);
  }
  return [parts[0]!, parts[1]!];
}

const escape = encodeURIComponent;
