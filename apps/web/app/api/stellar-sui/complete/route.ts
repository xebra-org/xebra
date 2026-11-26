import { normaliseTxHash } from "../../../../lib/server/routes";
import {
  evmSuiSources,
  relayEvmToSui,
  relayStellarToSui,
  suiRelayerKey,
} from "../../../../lib/stellar-sui/relayer";
import {
  completeErrorResponse,
  completeResultResponse,
} from "../../../../lib/sui-stellar/complete-response";
import { notFound } from "../../../../lib/sui-stellar/config";

/**
 * Finishes a transfer into Sui on Sui, paying the gas from Xebra's Sui relayer key.
 *
 *  - `POST {"tx": <Stellar transaction hash>}`: a Stellar to Sui transfer, as it always was. Only
 *    burns made through Xebra's wrapper are paid for.
 *  - `POST {"src": <CCTP domain of an EVM chain>, "tx": <0x burn hash>}`: an EVM to Sui transfer
 *    (Arc first), from a chain named in `NEXT_PUBLIC_EVM_TO_SUI`, of at least 1 USDC. `src` 27 is
 *    Stellar and means the first form.
 *
 * Answers like the Stellar relayer (`/api/sui-stellar/complete`): 202 `pending` until Circle has
 * signed, 200 `submitted` with the Sui digest or `delivered` once the USDC is there, 422 `refused`
 * with a reason, 502 `failed`.
 *
 * Anyone may call it for any burn: the USDC always goes to the address Circle signed for (see
 * `lib/stellar-sui/relayer.ts`). With no `SUI_RELAYER_SECRET` it is switched off (404) and the
 * transfer is claimed at `/claim` instead.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STELLAR_DOMAIN = 27;
const EVM_TX = /^0x[0-9a-fA-F]{64}$/;

export async function POST(request: Request): Promise<Response> {
  const key = suiRelayerKey();
  if (!key) return notFound();

  let rawTx: string | null = null;
  let src: number = STELLAR_DOMAIN;
  try {
    const body = (await request.json()) as { tx?: unknown; src?: unknown };
    rawTx = typeof body.tx === "string" ? body.tx.trim() : null;
    if (body.src !== undefined && body.src !== null) {
      src = typeof body.src === "number" ? body.src : Number(body.src);
    }
  } catch {
    // falls through to the validation below
  }

  if (src === STELLAR_DOMAIN) {
    const tx = normaliseTxHash("stellar", rawTx);
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

  // An EVM chain into Sui: only the chains this deployment sends to Sui from.
  const sources = evmSuiSources();
  if (!Number.isInteger(src) || !sources.includes(src)) {
    return Response.json(
      {
        error:
          sources.length > 0
            ? `src must be 27 (Stellar) or the CCTP domain of a chain that sends to Sui here: ${sources.join(", ")}.`
            : "src must be 27 (Stellar): no EVM chain sends to Sui here.",
      },
      { status: 400 },
    );
  }
  if (!rawTx || !EVM_TX.test(rawTx)) {
    return Response.json({ error: "tx must be 0x and 64 hex characters." }, { status: 400 });
  }
  try {
    return completeResultResponse(await relayEvmToSui(rawTx.toLowerCase(), src, { key, sources }));
  } catch (err) {
    console.error("evm-sui complete failed", err);
    return completeErrorResponse(err);
  }
}
