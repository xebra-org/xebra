import { type EndpointService, endpoints } from "./endpoints";
import { createService } from "./service";

/**
 * The live service, built the first time a handler needs it and not when this file loads.
 *
 * `./wiring` reads `lib/env.ts`, which throws while it loads if a required variable is missing.
 * When the wiring was imported at the top of this file, that throw happened as Next loaded the
 * route, before any handler ran, and every `/v1` call answered Next's HTML 500 page. Loaded from
 * inside a service call, it happens inside `handle()`, which logs the error (it names the
 * variable) and answers an `internal_error` problem (which does not).
 *
 * A failure is kept and never retried. `NEXT_PUBLIC_*` values are fixed when the bundle is built,
 * so a variable that is missing stays missing until the next deployment. Asking the bundler again
 * for a module that threw is also not sure to throw the same error twice.
 */
let live: Promise<EndpointService> | undefined;

function service(): Promise<EndpointService> {
  live ??= import("./wiring").then(({ liveDeps }) => createService(liveDeps));
  return live;
}

/** The live `/v1` handlers. */
export const v1 = endpoints({
  routes: async () => (await service()).routes(),
  solanaOpensAccount: async (recipient) => (await service()).solanaOpensAccount(recipient),
  quote: async (q) => (await service()).quote(q),
  buildTransfer: async (r) => (await service()).buildTransfer(r),
  transferStatus: async (r) => (await service()).transferStatus(r),
  buildClaim: async (r) => (await service()).buildClaim(r),
});
