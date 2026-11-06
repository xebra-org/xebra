import { StrKey } from "@stellar/stellar-sdk";
import { SUI_DIGEST } from "../../../../lib/sui-stellar/attestation";
import { notFound, suiStellarEnabled } from "../../../../lib/sui-stellar/config";
import { planClaim } from "../../../../lib/sui-stellar/stellar-side";

/**
 * The unsigned mint for an attested Sui burn, with the caller as the source account, so the caller
 * can finish their own transfer from their own Stellar wallet and pay the small XLM fee themselves.
 * This is the path that needs no relayer.
 *
 * Nothing here moves funds or trusts the caller: the recipient is read from the burn's own hook and
 * the same checks as the relayer run first. The caller's address only decides who pays the fee.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  if (!suiStellarEnabled()) return notFound();

  let digest = "";
  let payer = "";
  try {
    const body = (await request.json()) as { digest?: unknown; payer?: unknown };
    digest = typeof body.digest === "string" ? body.digest.trim() : "";
    payer = typeof body.payer === "string" ? body.payer.trim() : "";
  } catch {
    // falls through to the validation below
  }
  if (!SUI_DIGEST.test(digest)) {
    return Response.json({ error: "That is not a Sui transaction digest." }, { status: 400 });
  }
  if (!StrKey.isValidEd25519PublicKey(payer)) {
    return Response.json({ error: "Connect a Stellar wallet first." }, { status: 400 });
  }

  try {
    const plan = await planClaim(digest, payer);
    if (!plan.ok) {
      return Response.json(
        { error: plan.reason, delivered: plan.delivered === true },
        { status: plan.delivered ? 409 : 422 },
      );
    }
    return Response.json({ xdr: plan.xdr, recipient: plan.recipient });
  } catch (err) {
    console.error("sui-stellar claim failed", err);
    return Response.json(
      { error: "Could not prepare the mint. Nothing was sent; try again." },
      { status: 502 },
    );
  }
}
