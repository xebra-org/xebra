import { StrKey } from "@stellar/stellar-sdk";
import { planClaim, stellarInboundSources } from "../../../../lib/sui-stellar/stellar-side";

/**
 * The Stellar mint of a burn into Stellar from an EVM chain, for the owner to sign and pay from a
 * Stellar wallet when the relayer has not finished it. `?src=` the burn's CCTP domain; the body is
 * `{ tx, payer }`, as `/api/aptos/claim` takes it. Sui, Solana and Aptos keep their own routes.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const EVM_HASH = /^0x[0-9a-f]{64}$/;

export async function POST(request: Request): Promise<Response> {
  const src = Number(new URL(request.url).searchParams.get("src"));
  if (!Number.isInteger(src) || !stellarInboundSources().includes(src)) {
    return Response.json(
      {
        error:
          "src must be the CCTP domain of a chain whose burns into Stellar are completed here.",
      },
      { status: 400 },
    );
  }
  let tx = "";
  let payer = "";
  try {
    const body = (await request.json()) as { tx?: unknown; payer?: unknown };
    tx = typeof body.tx === "string" ? body.tx.trim().toLowerCase() : "";
    payer = typeof body.payer === "string" ? body.payer.trim() : "";
  } catch {
    // falls through to the validation below
  }
  if (!EVM_HASH.test(tx)) {
    return Response.json({ error: "That is not a transaction hash." }, { status: 400 });
  }
  if (!StrKey.isValidEd25519PublicKey(payer)) {
    return Response.json({ error: "Connect a Stellar wallet first." }, { status: 400 });
  }
  try {
    const plan = await planClaim(tx, payer, src);
    if (!plan.ok) {
      return Response.json(
        { error: plan.reason, delivered: plan.delivered === true },
        { status: plan.delivered ? 409 : 422 },
      );
    }
    return Response.json({ xdr: plan.xdr, recipient: plan.recipient });
  } catch (err) {
    console.error("stellar inbound claim failed", err);
    return Response.json(
      { error: "Could not prepare the mint. Nothing was sent; try again." },
      { status: 502 },
    );
  }
}
