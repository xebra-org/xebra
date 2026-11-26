import { suiRelayerKey } from "../../../../lib/stellar-sui/relayer";
import { relayEvmToSui, suiInboundSources } from "../../../../lib/sui-inbound/relayer";
import {
  completeErrorResponse,
  completeResultResponse,
} from "../../../../lib/sui-stellar/complete-response";
import { notFound } from "../../../../lib/sui-stellar/config";

/**
 * Finishes an EVM to Sui transfer (Arc first) on Sui, paying the gas from Xebra's Sui relayer key.
 *
 * `POST {"src": <CCTP domain of the EVM chain>, "tx": <burn transaction hash>}`. Answers like the
 * other relayers: 202 `pending` until Circle has signed, 200 `submitted` with the Sui digest or
 * `delivered` once the USDC is there, 422 `refused` with a reason, 502 `failed`.
 *
 * Switched off (404) while there is no `SUI_RELAYER_SECRET` or no chain in
 * `NEXT_PUBLIC_EVM_TO_SUI`; the recipient then claims at `/claim`. Anyone may call it: the USDC
 * always goes to the address Circle signed for (see `lib/sui-inbound/relayer.ts`).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const EVM_TX = /^0x[0-9a-fA-F]{64}$/;

export async function POST(request: Request): Promise<Response> {
  const key = suiRelayerKey();
  const sources = suiInboundSources();
  if (!key || sources.length === 0) return notFound();

  let src = Number.NaN;
  let tx = "";
  try {
    const body = (await request.json()) as { src?: unknown; tx?: unknown };
    src = typeof body.src === "number" ? body.src : Number(body.src);
    tx = typeof body.tx === "string" ? body.tx.trim() : "";
  } catch {
    // falls through to the validation below
  }
  if (!Number.isInteger(src) || !sources.includes(src)) {
    return Response.json(
      {
        error: `src must be the CCTP domain of a chain that sends to Sui here: ${sources.join(", ")}.`,
      },
      { status: 400 },
    );
  }
  if (!EVM_TX.test(tx)) {
    return Response.json({ error: "tx must be 0x and 64 hex characters." }, { status: 400 });
  }

  try {
    return completeResultResponse(await relayEvmToSui(tx.toLowerCase(), src, { key, sources }));
  } catch (err) {
    console.error("sui-inbound complete failed", err);
    return completeErrorResponse(err);
  }
}
