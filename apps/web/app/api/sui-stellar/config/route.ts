import { formatUsdcAmount } from "@xebra/sdk/core";
import {
  maxUsdcBase,
  relayerSecret,
  suiEvmDestinations,
  suiSendsToSolana,
  suiStellarEnabled,
} from "../../../../lib/sui-stellar/config";

/**
 * What the bridge screen needs to know before it offers Sui as a source. Always answers 200, so a
 * deployment with the feature off is `{ enabled: false }` rather than a 404 in the console.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  const enabled = suiStellarEnabled();
  const cap = maxUsdcBase();
  return Response.json(
    enabled
      ? {
          enabled,
          relayer: relayerSecret() !== null,
          maxUsdc: cap === null ? null : formatUsdcAmount(cap),
          // EVM chains Sui also sends to, delivered by Circle's Forwarding Service.
          evm: suiEvmDestinations().map((c) => c.id),
          // And Solana, the same way, into the recipient's USDC account.
          solana: suiSendsToSolana(),
        }
      : { enabled },
    { headers: { "cache-control": "no-store" } },
  );
}
