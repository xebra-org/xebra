import { normaliseTxHash } from "../../../../lib/server/routes";
import { relayStellarToSui, suiRelayerKey } from "../../../../lib/stellar-sui/relayer";
import {
  completeErrorResponse,
  completeResultResponse,
} from "../../../../lib/sui-stellar/complete-response";
import { notFound } from "../../../../lib/sui-stellar/config";

/**
 * Finishes a Stellar to Sui transfer on Sui, paying the gas from Xebra's Sui relayer key.
 *
 * `POST {"tx": <Stellar transaction hash>}`. Answers like the Stellar relayer
 * (`/api/sui-stellar/complete`): 202 `pending` until Circle has signed, 200 `submitted` with the Sui
 * digest or `delivered` once the USDC is there, 422 `refused` with a reason, 502 `failed`.
 *
 * Anyone may call it for any burn: the USDC always goes to the address Circle signed for, and only
 * burns made through Xebra's wrapper are paid for (see `lib/stellar-sui/relayer.ts`). With no
 * `SUI_RELAYER_SECRET` it is switched off (404) and the transfer is claimed at `/claim` instead.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const key = suiRelayerKey();
  if (!key) return notFound();

  let tx: string | null = null;
  try {
    const body = (await request.json()) as { tx?: unknown };
    tx = normaliseTxHash("stellar", typeof body.tx === "string" ? body.tx : null);
  } catch {
    // falls through to the validation below
  }
  if (!tx) {
    return Response.json({ error: "tx must be a Stellar transaction hash." }, { status: 400 });
  }

  try {
    return completeResultResponse(await relayStellarToSui(tx, { key }));
  } catch (err) {
    console.error("stellar-sui complete failed", err);
    return completeErrorResponse(err);
  }
}
