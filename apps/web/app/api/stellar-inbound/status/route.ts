import { formatUsdcAmount, verifyMessage } from "@xebra/sdk/core";
import { env } from "../../../../lib/env";
import { readAttestation } from "../../../../lib/sui-stellar/attestation";
import { mintState, stellarInboundSources } from "../../../../lib/sui-stellar/stellar-side";

/**
 * Where a burn into Stellar is, from any source the relayer completes (`stellarInboundSources`):
 * Circle's attestation, then Stellar's own record of the mint. The same answer `/api/aptos/status`
 * gives for Aptos, for every source. `?tx=` the burn, `?src=` its CCTP domain.
 *
 * An EVM transaction hash only here (0x + 64 hex): Sui, Solana and Aptos keep their own routes.
 */
export const dynamic = "force-dynamic";

const EVM_HASH = /^0x[0-9a-f]{64}$/;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const tx = url.searchParams.get("tx")?.trim().toLowerCase() ?? "";
  const src = Number(url.searchParams.get("src"));
  if (!EVM_HASH.test(tx)) {
    return Response.json(
      { error: "tx must be a transaction hash: 0x followed by 64 hex characters." },
      { status: 400 },
    );
  }
  if (!Number.isInteger(src) || !stellarInboundSources().includes(src)) {
    return Response.json(
      {
        error:
          "src must be the CCTP domain of a chain whose burns into Stellar are completed here.",
      },
      { status: 400 },
    );
  }
  try {
    const att = await readAttestation(tx, src);
    if (att.state === "pending") return Response.json({ state: "pending" });
    if (att.state !== "complete") return Response.json({ state: "unknown", reason: att.reason });
    try {
      const burn = verifyMessage(Buffer.from(att.message.replace(/^0x/, ""), "hex"), {
        tokenMessenger: env.cctpTokenMessengerId,
        sources: [src],
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
