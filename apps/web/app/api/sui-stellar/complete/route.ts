import { SUI_DIGEST } from "../../../../lib/sui-stellar/attestation";
import { notFound, relayerSecret, suiStellarEnabled } from "../../../../lib/sui-stellar/config";
import { completeBurn } from "../../../../lib/sui-stellar/stellar-side";

/**
 * Completes an attested Sui burn on Stellar, paying the XLM fee from the relayer account.
 *
 * Anyone may call this for any digest, and that is safe by construction: the recipient is read from
 * the burn's own hook, never from the request; the message must be a Sui to Stellar USDC burn minting
 * to Circle's forwarder; and the recipient must hold a trustline. A caller can only make us finish
 * a transfer someone already paid for on Sui.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  if (!suiStellarEnabled()) return notFound();
  const secret = relayerSecret();
  if (!secret) {
    return Response.json(
      { status: "unavailable", reason: "Completion is not switched on for this deployment." },
      { status: 503 },
    );
  }

  let digest = "";
  try {
    const body = (await request.json()) as { digest?: unknown };
    digest = typeof body.digest === "string" ? body.digest.trim() : "";
  } catch {
    // falls through to the validation below
  }
  if (!SUI_DIGEST.test(digest)) {
    return Response.json({ error: "That is not a Sui transaction digest." }, { status: 400 });
  }

  try {
    const result = await completeBurn(digest, secret);
    const code = result.status === "refused" ? 422 : result.status === "failed" ? 502 : 200;
    return Response.json(result, { status: code });
  } catch (err) {
    console.error("sui-stellar complete failed", err);
    return Response.json(
      { status: "failed", reason: "Could not complete the transfer. It is safe to try again." },
      { status: 502 },
    );
  }
}
