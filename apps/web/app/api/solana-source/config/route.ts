import { formatUsdcAmount } from "@xebra/sdk/core";
import {
  SOLANA_STELLAR_MIN_UNITS,
  solanaMaxUsdcBase,
  solanaSends,
} from "../../../../lib/solana-source/config";
import { relayerSecret } from "../../../../lib/sui-stellar/config";

/**
 * What the bridge screen needs before it offers Solana as a source. Always 200, so a deployment
 * with the switch off answers `{ enabled: false }` rather than a 404 in the console.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  const sends = solanaSends();
  const enabled = sends.stellar || sends.evm.length > 0;
  const cap = solanaMaxUsdcBase();
  return Response.json(
    enabled
      ? {
          enabled,
          // EVM chains, delivered by Circle's Forwarding Service.
          evm: sends.evm.map((c) => c.id),
          stellar: sends.stellar,
          // Whether our relayer finishes a transfer into Stellar, or its owner has to.
          relayer: relayerSecret() !== null,
          maxUsdc: cap === null ? null : formatUsdcAmount(cap),
          stellarMinUsdc: formatUsdcAmount(SOLANA_STELLAR_MIN_UNITS),
        }
      : { enabled },
    { headers: { "cache-control": "no-store" } },
  );
}
