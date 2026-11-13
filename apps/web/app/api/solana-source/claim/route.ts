import { StrKey } from "@stellar/stellar-sdk";
import { SOLANA_CCTP_DOMAIN, SOLANA_SIGNATURE } from "../../../../lib/solana-source/config";
import { planClaim } from "../../../../lib/sui-stellar/stellar-side";

/**
 * The unsigned Stellar mint for an attested Solana burn into Stellar, with the caller as the source
 * account, so the owner can finish their own transfer and pay the small XLM fee. The path that needs
 * no relayer. Same checks, same shape as `/api/sui-stellar/claim`: the recipient is read from the
 * burn's own hook, and the caller's address only decides who pays the fee.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  let digest = "";
  let payer = "";
  try {
    const body = (await request.json()) as { digest?: unknown; payer?: unknown };
    digest = typeof body.digest === "string" ? body.digest.trim() : "";
    payer = typeof body.payer === "string" ? body.payer.trim() : "";
  } catch {
    // falls through to the validation below
  }
  if (!SOLANA_SIGNATURE.test(digest)) {
    return Response.json({ error: "That is not a Solana transaction signature." }, { status: 400 });
  }
  if (!StrKey.isValidEd25519PublicKey(payer)) {
    return Response.json({ error: "Connect a Stellar wallet first." }, { status: 400 });
  }
  try {
    const plan = await planClaim(digest, payer, SOLANA_CCTP_DOMAIN);
    if (!plan.ok) {
      return Response.json(
        { error: plan.reason, delivered: plan.delivered === true },
        { status: plan.delivered ? 409 : 422 },
      );
    }
    return Response.json({ xdr: plan.xdr, recipient: plan.recipient });
  } catch (err) {
    console.error("solana-source claim failed", err);
    return Response.json(
      { error: "Could not prepare the mint. Nothing was sent; try again." },
      { status: 502 },
    );
  }
}
