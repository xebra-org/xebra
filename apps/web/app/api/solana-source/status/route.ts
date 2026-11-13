import { formatUsdcAmount, verifyMessage } from "@xebra/sdk/core";
import { env } from "../../../../lib/env";
import { SOLANA_CCTP_DOMAIN, SOLANA_SIGNATURE } from "../../../../lib/solana-source/config";
import { readAttestation } from "../../../../lib/sui-stellar/attestation";
import { mintState } from "../../../../lib/sui-stellar/stellar-side";

/**
 * Where a Solana burn into Stellar stands: unknown, pending, or complete (attested), and once
 * attested whether the mint on Stellar has happened. The same answer as `/api/sui-stellar/status`,
 * for burns made on Solana. A burn to an EVM chain is followed through `/api/delivery?src=5`.
 *
 * Not behind the route switch: it reads public data about a burn the caller already holds, and a
 * transfer started before the route was switched off still has to be followed to the end.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const tx = new URL(request.url).searchParams.get("tx")?.trim() ?? "";
  if (!SOLANA_SIGNATURE.test(tx)) {
    return Response.json({ error: "That is not a Solana transaction signature." }, { status: 400 });
  }
  try {
    const att = await readAttestation(tx, SOLANA_CCTP_DOMAIN);
    if (att.state === "pending") return Response.json({ state: "pending" });
    if (att.state !== "complete") return Response.json({ state: "unknown", reason: att.reason });
    try {
      const burn = verifyMessage(Buffer.from(att.message.replace(/^0x/, ""), "hex"), {
        tokenMessenger: env.cctpTokenMessengerId,
        sources: [SOLANA_CCTP_DOMAIN],
      });
      const mint = await mintState(att, burn.recipient);
      return Response.json({
        state: "complete",
        delivered: mint === "delivered",
        recipient: burn.recipient,
        amount: formatUsdcAmount(burn.amount),
      });
    } catch (err) {
      // Attested, but not a transfer into Stellar this deployment would complete.
      return Response.json({
        state: "complete",
        delivered: false,
        refusal: err instanceof Error ? err.message : "invalid message",
      });
    }
  } catch {
    return Response.json({ state: "unknown", reason: "Circle did not answer" }, { status: 502 });
  }
}
