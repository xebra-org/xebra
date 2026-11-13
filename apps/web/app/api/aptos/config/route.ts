import { formatUsdcAmount } from "@xebra/sdk/core";
import { aptosDestinations, aptosEnabled, aptosMaxUsdcBase } from "../../../../lib/aptos/config";
import { relayerSecret } from "../../../../lib/sui-stellar/config";

/**
 * What the bridge screen needs before it offers Aptos as a source. Always 200, so a deployment
 * with Aptos off answers `{ enabled: false }` rather than a 404 in the console. Aptos is offered
 * only when it can send somewhere.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  const destinations = aptosDestinations();
  const enabled = aptosEnabled() && destinations.length > 0;
  const cap = aptosMaxUsdcBase();
  return Response.json(
    enabled
      ? {
          enabled,
          destinations,
          maxUsdc: cap === null ? null : formatUsdcAmount(cap),
          // Whether anything finishes a transfer into Stellar for the sender.
          relayer: relayerSecret() !== null,
        }
      : { enabled: false },
    { headers: { "cache-control": "no-store" } },
  );
}
