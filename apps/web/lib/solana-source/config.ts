/**
 * Server-side switches for transfers that start on Solana. Read at request time, so turning a route
 * on or off is a Vercel env change and a redeploy, not a rebuild of the bundle.
 *
 *  - `SOLANA_SENDS_TO`       where Solana may send. A comma list of chain ids from the EVM table
 *                            (`base,arbitrum,arc`) and `stellar`, or `all` for every one of them,
 *                            Stellar included, as `all` means for Aptos.
 *                            Unset, empty or `none`: Solana is not a source at all.
 *  - `SOLANA_SOURCE_MAX_USDC` optional per-transfer cap, enforced when the burn is built. Unset
 *                            means no cap.
 *
 * Solana to an EVM chain is delivered by Circle's Forwarding Service. Solana to Stellar is completed
 * by the same relayer as Sui to Stellar (`SUI_STELLAR_RELAYER_SECRET`), or by the owner's own claim.
 * Xebra takes no fee on any of these yet: there is no Xebra contract on Solana.
 */
import { EVM_CHAINS, type EvmChain, isEvmChainId } from "@xebra/sdk/core";

/** Solana's CCTP domain. Here so reading it loads no Solana SDK. */
export const SOLANA_CCTP_DOMAIN = 5;
/**
 * A Solana transaction signature: 64 bytes in base58, so 64 to 88 characters, and case matters. It is
 * what Circle indexes a Solana burn by (`/v2/messages/5?transactionHash=`).
 */
export const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
/** Stellar's CCTP domain. */
export const STELLAR_CCTP_DOMAIN = 27;
/**
 * The smallest Solana to Stellar transfer this deployment builds. The relayer completes burns into
 * Stellar from chains other than Sui only from 1 USDC (`/api/stellar-inbound/complete`), and a
 * burn it would refuse should not be offered.
 */
export const SOLANA_STELLAR_MIN_UNITS = 1_000_000n;

export interface SolanaSends {
  /** EVM chains, in table order. */
  evm: EvmChain[];
  stellar: boolean;
}

/** Pure: what a `SOLANA_SENDS_TO` value allows. Unknown names are ignored, never guessed at. */
export function parseSolanaSendsTo(raw: string | null | undefined): SolanaSends {
  const names = (raw ?? "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== "none");
  const all = names.includes("all");
  return {
    evm: Object.values(EVM_CHAINS).filter((c) => all || names.includes(c.id)),
    stellar: all || names.includes("stellar"),
  };
}

export function solanaSends(): SolanaSends {
  return parseSolanaSendsTo(process.env.SOLANA_SENDS_TO);
}

export function solanaSourceEnabled(): boolean {
  const s = solanaSends();
  return s.stellar || s.evm.length > 0;
}

/** Whether a Solana burn may be built for this CCTP domain. */
export function solanaSendsToDomain(domain: number): boolean {
  const s = solanaSends();
  if (domain === STELLAR_CCTP_DOMAIN) return s.stellar;
  return s.evm.some((c) => c.cctpDomainId === domain);
}

/** An EVM destination by id, only while it is switched on. */
export function solanaEvmDestination(id: unknown): EvmChain | null {
  if (typeof id !== "string" || !isEvmChainId(id)) return null;
  return solanaSends().evm.find((c) => c.id === id) ?? null;
}

/** The per-transfer cap in USDC base units, or null for no cap (the default). */
export function solanaMaxUsdcBase(): bigint | null {
  const raw = process.env.SOLANA_SOURCE_MAX_USDC?.trim();
  if (!raw) return null;
  const usdc = Number(raw);
  if (!Number.isFinite(usdc) || usdc <= 0) return null;
  return BigInt(Math.round(usdc * 1_000_000));
}
