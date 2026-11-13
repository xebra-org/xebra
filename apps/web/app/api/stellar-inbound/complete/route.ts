import { EVM_CHAINS, SUI_DOMAIN } from "@xebra/sdk/core";
import { SOLANA_CCTP_DOMAIN, SOLANA_SIGNATURE } from "../../../../lib/solana-source/config";
import { SUI_DIGEST } from "../../../../lib/sui-stellar/attestation";
import { relayerSecret } from "../../../../lib/sui-stellar/config";

/** Aptos's CCTP domain; its transaction hashes are 0x and 64 hex, like an EVM chain's. */
const APTOS_DOMAIN = 9;
import { completeBurn, stellarInboundSources } from "../../../../lib/sui-stellar/stellar-side";

/**
 * Completes an attested burn into Stellar from any chain we list (Sui, Solana, an EVM chain, or
 * Aptos while Aptos may send to Stellar), paying the
 * XLM fee from the relayer account. Circle's Forwarding Service delivers to Stellar from no chain, so
 * this is how every transfer into Stellar lands unless its owner claims it.
 *
 * `POST {"src": <CCTP domain>, "tx": <burn transaction>}`: a Sui digest, a Solana signature (both
 * base58, never lower-cased), or an EVM or Aptos hash. Anyone may call it for any burn, and that
 * is safe by construction: the recipient is read from the burn's own hook, never from the request;
 * the message must be a USDC burn to Stellar minting to Circle's forwarder; and the recipient must
 * hold a trustline. A caller can only make us finish a transfer someone already burned for.
 *
 * Burns under 1 USDC from chains other than Sui (Solana included) are refused until the relayer checks Xebra's fee:
 * each completion costs XLM, and a free relay for dust would be a way to drain it.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MIN_RELAYED_UNITS = 1_000_000n;
const EVM_TX = /^0x[0-9a-fA-F]{64}$/;

export async function POST(request: Request): Promise<Response> {
  const secret = relayerSecret();
  if (!secret) {
    return Response.json(
      { status: "unavailable", reason: "Completion is not switched on for this deployment." },
      { status: 503 },
    );
  }

  let src = Number.NaN;
  let tx = "";
  try {
    const body = (await request.json()) as { src?: unknown; tx?: unknown };
    src = typeof body.src === "number" ? body.src : Number(body.src);
    tx = typeof body.tx === "string" ? body.tx.trim() : "";
  } catch {
    // falls through to the validation below
  }
  const sources = stellarInboundSources();
  if (!Number.isInteger(src) || !sources.includes(src)) {
    const names = [
      "Sui (8)",
      "Solana (5)",
      ...Object.values(EVM_CHAINS).map((c) => `${c.name} (${c.cctpDomainId})`),
      ...(sources.includes(APTOS_DOMAIN) ? ["Aptos (9)"] : []),
    ];
    return Response.json(
      { error: `src must be the CCTP domain of one of: ${names.join(", ")}.` },
      { status: 400 },
    );
  }
  const sui = src === SUI_DOMAIN;
  const solana = src === SOLANA_CCTP_DOMAIN;
  if (!(sui ? SUI_DIGEST : solana ? SOLANA_SIGNATURE : EVM_TX).test(tx)) {
    return Response.json(
      {
        error: sui
          ? "tx must be a Sui transaction digest."
          : solana
            ? "tx must be a Solana transaction signature."
            : src === APTOS_DOMAIN
              ? "tx must be an Aptos transaction hash: 0x and 64 hex characters."
              : "tx must be 0x and 64 hex characters.",
      },
      { status: 400 },
    );
  }

  try {
    // Base58 (Sui, Solana) is case-sensitive; only an EVM hash is normalised.
    const result = await completeBurn(sui || solana ? tx : tx.toLowerCase(), secret, src, {
      ...(sui ? {} : { minAmount: MIN_RELAYED_UNITS }),
    });
    const code = result.status === "refused" ? 422 : result.status === "failed" ? 502 : 200;
    return Response.json(result, { status: code });
  } catch (err) {
    console.error("stellar-inbound complete failed", err);
    return Response.json(
      { status: "failed", reason: "Could not complete the transfer. It is safe to try again." },
      { status: 502 },
    );
  }
}
