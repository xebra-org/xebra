import { StrKey } from "@stellar/stellar-sdk";
import { APTOS_CCTP_DOMAIN, aptosDestinations, notFound } from "../../../../lib/aptos/config";
import { normaliseTxHash } from "../../../../lib/server/routes";
import { planClaim } from "../../../../lib/sui-stellar/stellar-side";

/**
 * The unsigned Stellar mint for an attested Aptos burn to Stellar, with the caller as the source
 * account, so the sender can finish their own transfer from their own Stellar wallet and pay the
 * small XLM fee. The path that needs no relayer.
 *
 * Nothing here moves funds or trusts the caller: the recipient is read from the burn's own hook
 * and the relayer's checks run first. The caller's address only decides who pays the fee.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  if (!aptosDestinations().includes("stellar")) return notFound();

  let tx: string | null = null;
  let payer = "";
  try {
    const body = (await request.json()) as { tx?: unknown; payer?: unknown };
    tx = normaliseTxHash("aptos", typeof body.tx === "string" ? body.tx : null);
    payer = typeof body.payer === "string" ? body.payer.trim() : "";
  } catch {
    // falls through to the validation below
  }
  if (!tx) {
    return Response.json({ error: "That is not an Aptos transaction hash." }, { status: 400 });
  }
  if (!StrKey.isValidEd25519PublicKey(payer)) {
    return Response.json({ error: "Connect a Stellar wallet first." }, { status: 400 });
  }

  try {
    const plan = await planClaim(tx, payer, APTOS_CCTP_DOMAIN);
    if (!plan.ok) {
      return Response.json(
        { error: plan.reason, delivered: plan.delivered === true },
        { status: plan.delivered ? 409 : 422 },
      );
    }
    return Response.json({ xdr: plan.xdr, recipient: plan.recipient });
  } catch (err) {
    console.error("aptos claim on stellar failed", err);
    return Response.json(
      { error: "Could not prepare the mint. Nothing was sent; try again." },
      { status: 502 },
    );
  }
}
