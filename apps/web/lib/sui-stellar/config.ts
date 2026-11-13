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
 *                                 a comma list of chain ids from the EVM table (`monad`), `all` for
 *                                 every chain in the table (Arc included), or `none`. Unset means
 *                                 Monad. Names it does not know are ignored, never guessed at.
 *  - `SUI_SENDS_TO_SOLANA=true`  Sui may also send to Solana, through Circle's Forwarding Service,
 *                                 which opens the recipient's USDC account if it has none. Off
 *                                 unless set.
 *
 * Both destination switches only answer while `SUI_STELLAR_ENABLED` is on, which is the switch for
 * the whole Sui page.
 */
import { EVM_CHAINS, type EvmChain, isEvmChainId } from "@xebra/sdk/core";

/** Sui's CCTP domain. Here rather than in `cctp.ts` so that reading it does not load the Stellar SDK. */
export const SUI_CCTP_DOMAIN = 8;
/** Solana's CCTP domain, the one destination from Sui that is not an EVM chain. */
export const SOLANA_CCTP_DOMAIN = 5;

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
 * Reads `SUI_SENDS_TO_EVM`: the chains in the order it names them, every chain in the table (in
 * table order) for `all`, nothing for `none` or an empty value, and Monad when it is unset. Unknown
 * names are ignored, never guessed at. Pure, so the parsing is tested without an environment.
 */
export function parseSuiSendsToEvm(value: string | undefined): EvmChain[] {
  const raw = (value ?? DEFAULT_SUI_EVM).trim().toLowerCase();
  if (raw === "" || raw === "none") return [];
  if (raw === "all") return Object.values(EVM_CHAINS);
  const out: EvmChain[] = [];
  for (const name of raw.split(",").map((s) => s.trim())) {
    if (isEvmChainId(name) && !out.some((c) => c.id === name)) out.push(EVM_CHAINS[name]);
  }
  return out;
}

/** The EVM chains a Sui burn may be sent to. Empty when the Sui page is off. */
export function suiEvmDestinations(): EvmChain[] {
  if (!suiStellarEnabled()) return [];
  return parseSuiSendsToEvm(process.env.SUI_SENDS_TO_EVM);
}

/** Whether a Sui burn may be sent to Solana. Off unless `SUI_SENDS_TO_SOLANA=true`. */
export function suiSendsToSolana(): boolean {
  return suiStellarEnabled() && process.env.SUI_SENDS_TO_SOLANA?.trim().toLowerCase() === "true";
}

/** Whether Sui sends to this domain through Circle's Forwarding Service (Stellar is not one). */
export function suiSendsToDomain(domain: number): boolean {
  if (domain === SOLANA_CCTP_DOMAIN) return suiSendsToSolana();
  return suiEvmDestinations().some((c) => c.cctpDomainId === domain);
}
