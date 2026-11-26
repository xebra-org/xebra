import { type FeeRule, withRebalancePartners } from "@xebra/sdk/core";

/**
 * The fee table the server prices from: `FEE_TABLE` plus the market-maker rebalance price for the
 * API keys named in `XEBRA_REBALANCE_KEY_IDS` (comma-separated key ids, as the key store records
 * them). Only those keys get it; any other key, and every caller without one, pays the default.
 * Server-only, so the ids never reach a page or the published SDK.
 */
export function rebalanceKeyIds(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
}

export function feeTableFrom(raw: string | undefined): readonly FeeRule[] {
  return withRebalancePartners(rebalanceKeyIds(raw));
}

export const liveFeeTable: readonly FeeRule[] = feeTableFrom(process.env.XEBRA_REBALANCE_KEY_IDS);
