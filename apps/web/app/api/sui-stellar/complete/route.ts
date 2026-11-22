import { SUI_DIGEST } from "../../../../lib/sui-stellar/attestation";
import {
  completeErrorResponse,
  completeResultResponse,
} from "../../../../lib/sui-stellar/complete-response";
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
  // No relayer is a switch that is off, like the one above, and not an outage: a 503 here told
  // callers to keep retrying a deployment that will never complete anything.
  const secret = relayerSecret();
  if (!secret) return notFound();

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
    return completeResultResponse(result);
  } catch (err) {
    console.error("sui-stellar complete failed", err);
    return completeErrorResponse(err);
  }
}
