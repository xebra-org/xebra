import { env } from "../../../../lib/env";
import { SUI_DIGEST, readAttestation } from "../../../../lib/sui-stellar/attestation";
import { formatUsdc, verifyMessage } from "../../../../lib/sui-stellar/cctp";
import { notFound, suiStellarEnabled } from "../../../../lib/sui-stellar/config";
import { mintState } from "../../../../lib/sui-stellar/stellar-side";

/**
 * Where a Sui burn stands: unknown, pending, or complete (attested). Once attested it also says
 * whether the mint on Stellar has already happened, so the page can show "delivered" for a transfer
 * somebody finished by hand, or finished in another browser. All of it is public data.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!suiStellarEnabled()) return notFound();
  const digest = new URL(request.url).searchParams.get("digest")?.trim() ?? "";
  if (!SUI_DIGEST.test(digest)) {
    return Response.json({ error: "That is not a Sui transaction digest." }, { status: 400 });
  }
  try {
    const att = await readAttestation(digest);
    if (att.state === "pending") return Response.json({ state: "pending" });
    if (att.state !== "complete") return Response.json({ state: "unknown", reason: att.reason });

    try {
      const burn = verifyMessage(Buffer.from(att.message.replace(/^0x/, ""), "hex"), {
        tokenMessenger: env.cctpTokenMessengerId,
      });
      const mint = await mintState(att, burn.recipient);
      return Response.json({
        state: "complete",
        delivered: mint === "delivered",
        recipient: burn.recipient,
        amount: formatUsdc(burn.amount),
      });
    } catch (err) {
      // Attested, but not a transfer this deployment would complete (wrong route, bad hook).
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
