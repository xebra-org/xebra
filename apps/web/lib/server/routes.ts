import { CCTP_DOMAIN, evmChainForDomain, isArcToSolana, isEvmRoute } from "@xebra/network-config";
import { parseEvmMesh } from "@xebra/sdk/core";
import { APTOS_CCTP_DOMAIN, aptosEnabled, aptosSendsToDomain } from "../aptos/config";
import {
  SOLANA_CCTP_DOMAIN,
  SOLANA_SIGNATURE,
  solanaSendsToDomain,
  solanaSourceEnabled,
} from "../solana-source/config";
import { SUI_CCTP_DOMAIN, suiSendsToDomain, suiStellarEnabled } from "../sui-stellar/config";

/**
 * Which burns the server will ask Circle about, and how each chain writes a transaction hash.
 *
 * The API routes started life with one source, Stellar, and a bare `?tx=` still means exactly that:
 * every link already sent to someone keeps working. A burn made on an EVM chain names its chain
 * with `&src=<CCTP domain>`, because the same 32 bytes could be a transaction on any of them.
 *
 * Only domains this product actually burns on are accepted. These routes proxy Circle's API on our
 * rate budget, and are not a general-purpose lookup for every chain Circle supports.
 */

export type SourceKind = "stellar" | "evm" | "sui" | "solana" | "aptos";

export interface Source {
  domain: number;
  kind: SourceKind;
}

const STELLAR_HASH = /^[0-9a-f]{64}$/;
const EVM_HASH = /^0x[0-9a-f]{64}$/;
/** A Sui transaction digest: base58, so case matters and it is never lower-cased. */
const SUI_DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const DOMAIN = /^\d{1,4}$/;
const STELLAR_DOMAIN = 27;

/**
 * The source a request names. `stellarDomain` is passed in (it has a server-side override) and is
 * what an absent `src` means.
 */
export function readSource(raw: string | null, stellarDomain: number): Source | null {
  if (raw === null || raw === "") return { domain: stellarDomain, kind: "stellar" };
  if (!DOMAIN.test(raw)) return null;
  const domain = Number(raw);
  if (domain === stellarDomain) return { domain, kind: "stellar" };
  // Sui is a source only while its page is switched on.
  if (domain === SUI_CCTP_DOMAIN) return suiStellarEnabled() ? { domain, kind: "sui" } : null;
  // Solana is a source only while `SOLANA_SENDS_TO` names somewhere it may send.
  if (domain === SOLANA_CCTP_DOMAIN) {
    return solanaSourceEnabled() ? { domain, kind: "solana" } : null;
  }
  // Aptos likewise, only while its switch is on.
  if (domain === APTOS_CCTP_DOMAIN) return aptosEnabled() ? { domain, kind: "aptos" } : null;
  return evmChainForDomain(domain) ? { domain, kind: "evm" } : null;
}

/**
 * A transaction hash in the form Circle indexes it for that kind of chain, or null if it is not
 * one. Stellar hashes are bare hex; EVM and Aptos hashes carry `0x` (both are 32 bytes, lower-cased
 * as Circle indexes them). Neither is accepted in the other's form:
 * a hash pasted against the wrong source should be told so, not looked up and reported "pending".
 */
export function normaliseTxHash(kind: SourceKind, raw: string | null | undefined): string | null {
  if (kind === "sui") {
    const digest = raw?.trim();
    return digest && SUI_DIGEST.test(digest) ? digest : null;
  }
  if (kind === "solana") {
    const signature = raw?.trim();
    return signature && SOLANA_SIGNATURE.test(signature) ? signature : null;
  }
  const tx = raw?.trim().toLowerCase();
  if (!tx) return null;
  return (kind === "evm" || kind === "aptos" ? EVM_HASH : STELLAR_HASH).test(tx) ? tx : null;
}

export const txHashHint = (kind: SourceKind) =>
  kind === "sui"
    ? "tx must be a Sui transaction digest"
    : kind === "solana"
      ? "tx must be a Solana transaction signature"
      : kind === "aptos"
        ? "tx must be an Aptos transaction hash: 0x followed by 64 hex characters"
        : kind === "evm"
          ? "tx must be 0x followed by 64 hex characters"
          : "tx must be a 64-character hex string";

/** A CCTP domain from a query parameter, or null. */
export function readDomain(raw: string | null): number | null {
  return raw !== null && DOMAIN.test(raw) ? Number(raw) : null;
}

/**
 * Whether a quote may be asked for between two domains: the wrapper's Stellar routes (to Solana and
 * to every EVM chain in the table, Arc included), and the direct routes (each EVM peer with Arc,
 * both ways, Arc to Solana, and any two chains of `NEXT_PUBLIC_EVM_MESH`).
 *
 * Stellar's list is every destination the wrapper *could* have committed, not the ones it has: a
 * quote is a public fact about Circle, and the contract, which is read by the page, decides what can
 * actually be sent.
 */
export function isOfferedRoute(
  source: number,
  destination: number,
  stellarDomain: number,
): boolean {
  if (source === stellarDomain) {
    return destination === CCTP_DOMAIN.solana || evmChainForDomain(destination) !== null;
  }
  // Sui to the EVM chains its switch names, delivered by Circle's Forwarding Service.
  if (source === SUI_CCTP_DOMAIN) return suiSendsToDomain(destination);
  // Solana to the EVM chains (forwarded by Circle) and to Stellar (completed by our relayer) that
  // `SOLANA_SENDS_TO` names.
  if (source === SOLANA_CCTP_DOMAIN) return solanaSendsToDomain(destination);
  // Aptos to the chains its switch names. Stellar is among them only to be built and relayed:
  // Circle forwards nothing into Stellar, so there is no delivery quote to ask for.
  if (source === APTOS_CCTP_DOMAIN) {
    return destination !== STELLAR_DOMAIN && aptosSendsToDomain(destination);
  }
  return (
    isEvmRoute(source, destination) ||
    isArcToSolana(source, destination) ||
    inEvmMesh(source, destination)
  );
}

/**
 * Two different EVM chains that are both in `NEXT_PUBLIC_EVM_MESH`, which lets every chain in it
 * send to every other. Read on each call, like the Sui switch, so the answer follows the build.
 */
function inEvmMesh(source: number, destination: number): boolean {
  if (source === destination) return false;
  const a = evmChainForDomain(source);
  const b = evmChainForDomain(destination);
  if (!a || !b) return false;
  let mesh: string[];
  try {
    mesh = parseEvmMesh(process.env.NEXT_PUBLIC_EVM_MESH);
  } catch {
    return false;
  }
  return mesh.length >= 2 && mesh.includes(a.id) && mesh.includes(b.id);
}
