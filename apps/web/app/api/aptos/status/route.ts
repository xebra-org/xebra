import { formatUsdcAmount, verifyMessage } from "@xebra/sdk/core";
import { APTOS_CCTP_DOMAIN, aptosDestinations, notFound } from "../../../../lib/aptos/config";
import { env } from "../../../../lib/env";
import { normaliseTxHash } from "../../../../lib/server/routes";
import { readAttestation } from "../../../../lib/sui-stellar/attestation";
import { mintState } from "../../../../lib/sui-stellar/stellar-side";

/**
 * Where an Aptos burn to Stellar stands: unknown, pending, or complete (attested), and once attested
 * whether the mint on Stellar has happened, so the page shows "delivered" for a transfer finished
 * by the relayer, by hand, or from another browser. Burns to other chains are followed through
 * `/api/delivery?src=9`, since Circle delivers those itself. All of it is public data.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!aptosDestinations().includes("stellar")) return notFound();
  const tx = normaliseTxHash("aptos", new URL(request.url).searchParams.get("tx"));
  if (!tx) {
    return Response.json(
      { error: "tx must be an Aptos transaction hash: 0x followed by 64 hex characters." },
      { status: 400 },
    );
  }
  try {
    const att = await readAttestation(tx, APTOS_CCTP_DOMAIN);
    if (att.state === "pending") return Response.json({ state: "pending" });
    if (att.state !== "complete") return Response.json({ state: "unknown", reason: att.reason });

    try {
      const burn = verifyMessage(Buffer.from(att.message.replace(/^0x/, ""), "hex"), {
        tokenMessenger: env.cctpTokenMessengerId,
        sources: [APTOS_CCTP_DOMAIN],
      });
      const mint = await mintState(att, burn.recipient);
      return Response.json({
        state: "complete",
        delivered: mint === "delivered",
        recipient: burn.recipient,
        amount: formatUsdcAmount(burn.amount),
      });
    } catch (err) {
      // Attested, but not a transfer the Stellar side would complete (another destination).
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
