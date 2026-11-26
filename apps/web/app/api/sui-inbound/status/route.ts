import { readSuiBoundMessage } from "@xebra/sdk/build";
import { formatUsdcAmount } from "@xebra/sdk/core";
import { suiInboundSources } from "../../../../lib/sui-inbound/relayer";
import { readAttestation } from "../../../../lib/sui-stellar/attestation";

/**
 * Where a burn into Sui from an EVM chain is, as far as Circle knows: `pending` until attested,
 * then `complete` with the recipient and amount, or `complete` with `refusal` when the message is
 * not a burn to Sui (an Arc to Base burn, say). Whether it has been minted on Sui is the relayer's
 * answer (`/api/sui-inbound/complete`), or the claim page's.
 *
 * `?tx=` the burn (0x + 64 hex), `?src=` its CCTP domain, one of the chains in
 * `NEXT_PUBLIC_EVM_TO_SUI`.
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
  if (!Number.isInteger(src) || !suiInboundSources().includes(src)) {
    return Response.json(
      { error: "src must be the CCTP domain of a chain that sends to Sui here." },
      { status: 400 },
    );
  }
  try {
    const att = await readAttestation(tx, src);
    if (att.state === "pending") return Response.json({ state: "pending" });
    if (att.state !== "complete") return Response.json({ state: "unknown", reason: att.reason });
    try {
      const m = readSuiBoundMessage(Buffer.from(att.message.replace(/^0x/, ""), "hex"));
      return Response.json({
        state: "complete",
        recipient: m.recipient,
        amount: formatUsdcAmount(m.received),
      });
    } catch (err) {
      return Response.json({
        state: "complete",
        refusal: err instanceof Error ? err.message : "not a transfer to Sui",
      });
    }
  } catch {
    return Response.json({ state: "unknown", reason: "Circle did not answer" }, { status: 502 });
  }
}
