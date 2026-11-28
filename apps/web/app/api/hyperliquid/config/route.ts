import { HYPERLIQUID_DESTINATIONS, formatUsdcAmount } from "@xebra/sdk/core";
import { parseHyperliquidConfig } from "../../../../lib/hyperliquid/reads";

/**
 * What the bridge screen needs before it offers Hyperliquid as a source. Always 200, so a
 * deployment with it off answers `{ enabled: false }` rather than a 404 in the console. Switched on
 * but without Xebra's fee address there, it is listed as unavailable with the reason: never free.
 * Quotes, builds and status go through `/v1`.
 */
export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "no-store" };

export function GET(): Response {
  let config: ReturnType<typeof parseHyperliquidConfig>;
  try {
    config = parseHyperliquidConfig(process.env);
  } catch (err) {
    console.error("Hyperliquid settings are malformed", err);
    return Response.json(
      {
        enabled: true,
        available: false,
        reason: "Withdrawals from Hyperliquid are not set up correctly here yet.",
      },
      { headers: HEADERS },
    );
  }
  if (!config.enabled) return Response.json({ enabled: false }, { headers: HEADERS });
  if (!config.feeAddress) {
    return Response.json(
      {
        enabled: true,
        available: false,
        reason:
          "Withdrawals from Hyperliquid are off for now: Xebra's fee address there is not set up.",
      },
      { headers: HEADERS },
    );
  }
  return Response.json(
    {
      enabled: true,
      available: true,
      destinations: [...HYPERLIQUID_DESTINATIONS],
      maxUsdc: config.maxUnits === null ? null : formatUsdcAmount(config.maxUnits),
    },
    { headers: HEADERS },
  );
}
