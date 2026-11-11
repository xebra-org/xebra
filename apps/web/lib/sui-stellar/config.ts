/**
 * Server-side switches for the Sui to Stellar page. All read at request time, so turning the feature
 * on or off, or changing the cap, is a Vercel env change and a redeploy, not a rebuild of the bundle.
 *
 *  - `SUI_STELLAR_ENABLED=true`  the page and its routes answer; anything else and they 404.
 *  - `SUI_STELLAR_MAX_USDC`      optional per-transfer cap enforced when the burn is built.
 *                                 Unset (the default) means no cap.
 *  - `SUI_STELLAR_RELAYER_SECRET` the funded Stellar account that pays the fee to complete a burn.
 *                                 Without it the page still builds burns, but nothing completes them.
 *  - `SUI_RPC_URL`               Sui fullnode (gRPC-web). Defaults to Mysten's public mainnet node.
 *  - `SUI_SENDS_TO_EVM`          EVM chains Sui may also send to, through Circle's Forwarding Service:
 *                                 a comma list of chain ids from the EVM table (`monad`), or `none`.
 *                                 Unset means Monad. Only answers while `SUI_STELLAR_ENABLED` is on,
 *                                 which is the switch for the whole Sui page.
 */
import { EVM_CHAINS, type EvmChain, isEvmChainId } from "../evm-chains";

/** Sui's CCTP domain. Here rather than in `cctp.ts` so that reading it does not load the Stellar SDK. */
export const SUI_CCTP_DOMAIN = 8;

const DEFAULT_SUI_EVM = "monad";
export function suiStellarEnabled(): boolean {
  return process.env.SUI_STELLAR_ENABLED === "true";
}

/** The per-transfer cap in USDC base units, or null for no cap (the default). */
export function maxUsdcBase(): bigint | null {
  const raw = process.env.SUI_STELLAR_MAX_USDC?.trim();
  if (!raw) return null;
  const usdc = Number(raw);
  if (!Number.isFinite(usdc) || usdc <= 0) return null;
  return BigInt(Math.round(usdc * 1_000_000));
}

export function relayerSecret(): string | null {
  const v = process.env.SUI_STELLAR_RELAYER_SECRET?.trim();
  return v ? v : null;
}

export function suiRpcUrl(): string {
  return process.env.SUI_RPC_URL?.trim() || "https://fullnode.mainnet.sui.io:443";
}

export function notFound(): Response {
  return Response.json({ error: "not available" }, { status: 404 });
}

/**
 * The EVM chains a Sui burn may be sent to, in the order the env names them. Unknown names are
 * ignored, never guessed at. Empty when the Sui page is off.
 */
export function suiEvmDestinations(): EvmChain[] {
  if (!suiStellarEnabled()) return [];
  const raw = (process.env.SUI_SENDS_TO_EVM ?? DEFAULT_SUI_EVM).trim().toLowerCase();
  if (raw === "" || raw === "none") return [];
  const out: EvmChain[] = [];
  for (const name of raw.split(",").map((s) => s.trim())) {
    if (isEvmChainId(name) && !out.some((c) => c.id === name)) out.push(EVM_CHAINS[name]);
  }
  return out;
}

export function suiSendsToDomain(domain: number): boolean {
  return suiEvmDestinations().some((c) => c.cctpDomainId === domain);
}
