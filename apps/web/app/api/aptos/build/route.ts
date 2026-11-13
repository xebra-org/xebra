import { checkCircle } from "@xebra/cctp-client";
import { buildAptosTransfer } from "../../../../lib/aptos/build";
import {
  APTOS_CCTP_DOMAIN,
  aptosDestinations,
  aptosEnabled,
  aptosMaxUsdcBase,
  notFound,
} from "../../../../lib/aptos/config";
import {
  aptosEnvelope,
  aptosSequenceNumber,
  aptosUsdcBalance,
  simulateAptosBurn,
} from "../../../../lib/aptos/node";
import { env } from "../../../../lib/env";
import { irisBaseUrl, irisBudget, irisFetch } from "../../../../lib/server/iris";
import { recipientStatus } from "../../../../lib/sui-stellar/stellar-side";
import { GET as recipientRoute } from "../../recipient/route";

/**
 * Builds a burn on Aptos for the connected wallet to sign: `POST {sender, amount, to, recipient,
 * maxFee}`. Nothing is signed or sent here; see `lib/aptos/build.ts` for every check it makes.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  if (!aptosEnabled()) return notFound();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: "Send JSON with sender, amount, to, recipient and maxFee." },
      { status: 400 },
    );
  }

  try {
    const answer = await buildAptosTransfer(body, {
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
    });
    return Response.json(answer.body, { status: answer.status });
  } catch (err) {
    console.error("aptos build failed", err);
    return Response.json(
      { error: "Could not prepare the transfer. Nothing was burned; try again in a moment." },
      { status: 502 },
    );
  }
}
