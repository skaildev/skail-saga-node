import type { Provider } from "@skail/runtime";
import { buildConfig } from "./build-config.generated.js";
import { SagaFunctions } from "./saga-functions.js";
import { HttpServices } from "./services.js";

// The skail bundle cannot read environment variables: these settings are fixed at build time (gen-config.mjs).
export const providers: Provider[] = [
  {
    token: SagaFunctions,
    useFactory: () => {
      // the simulated stock, gateway, issuer and customer messaging live in the web app
      const services = new HttpServices(buildConfig.webBaseUrl);
      return new SagaFunctions(services, services, services, services);
    },
  },
];
