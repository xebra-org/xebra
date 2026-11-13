import { checkCircle } from "@xebra/cctp-client";
import { GET as recipientRoute } from "../../app/api/recipient/route";
import { env } from "../env";
import { irisBaseUrl, irisBudget, irisFetch } from "../server/iris";
import { recipientStatus } from "../sui-stellar/stellar-side";
import type { AptosBuildDeps } from "./build";
import { APTOS_CCTP_DOMAIN, aptosDestinations, aptosMaxUsdcBase } from "./config";
import { aptosEnvelope, aptosSequenceNumber, aptosUsdcBalance, simulateAptosBurn } from "./node";

/**
 * What building an Aptos burn reads, wired to the real world: Circle's Iris (through the shared
 * budget), our own Solana recipient lookup, the Stellar RPC and an Aptos fullnode. Shared by
 * `POST /api/aptos/build` and the public API (`/v1/transfers`), so both build the same burn.
 */
export function liveAptosBuildDeps(): AptosBuildDeps {
  return {
    destinations: aptosDestinations,
    maxUnits: aptosMaxUsdcBase,
    circle: (dst, newAccount, maxFeeUnits) =>
      checkCircle({
        baseUrl: irisBaseUrl(),
        sourceDomain: APTOS_CCTP_DOMAIN,
        destDomain: dst,
        includeRecipientSetup: newAccount,
        fetch: irisFetch,
        store: irisBudget(),
        maxFeeUnits,
      }),
    async solanaAccount(owner) {
      const res = await recipientRoute(
        new Request(`http://internal/api/recipient?owner=${encodeURIComponent(owner)}`),
      );
      const b = (await res.json().catch(() => null)) as {
        tokenAccount?: unknown;
        status?: unknown;
      } | null;
      return {
        tokenAccount: typeof b?.tokenAccount === "string" ? b.tokenAccount : "",
        status: typeof b?.status === "string" ? b.status : "unknown",
      };
    },
    stellarAccount: recipientStatus,
    sequenceNumber: aptosSequenceNumber,
    usdcBalance: aptosUsdcBalance,
    envelope: (sender, seq) => aptosEnvelope(sender, seq),
    simulate: simulateAptosBurn,
    stellarTokenMessenger: env.cctpTokenMessengerId,
  };
}
