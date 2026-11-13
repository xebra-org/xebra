/**
 * Server-side switches for Aptos as a source chain. Read at request time, like the Sui switches in
 * `lib/sui-stellar/config.ts`, so turning a route on or off is an env change and a redeploy, not a
 * rebuild of the bundle. Everything is off until both are set:
 *
 *  - `APTOS_ENABLED=true`  the Aptos source, its API routes and its tab in the wallet modal answer;
 *                           anything else and they 404 (the config route says `enabled: false`).
 *  - `APTOS_SENDS_TO`       where Aptos may send: a comma list of EVM chain ids from the table
 *                           (`base,arbitrum,arc`), `solana`, `stellar`, or `all` for every one of
 *                           them. Unset or empty means none, so the switch alone offers nothing.
 *  - `APTOS_MAX_USDC`       optional per-transfer cap, enforced when the burn is built. Unset: none.
 *  - `APTOS_RPC_URL`        Aptos fullnode REST API. Defaults to Aptos Labs' public mainnet node.
 *  - `APTOS_API_KEY`        optional Aptos Labs API key for that node (sent as a bearer token).
 *
 * To EVM chains, Arc and Solana, Circle's Forwarding Service delivers the mint. To Stellar nothing
 * forwards: the relayer (`SUI_STELLAR_RELAYER_SECRET`, shared with Sui) completes it through
 * `/api/stellar-inbound/complete`, or the sender claims it from their own Stellar wallet.
 */
import { EVM_CHAINS, EVM_CHAIN_IDS, type EvmChainId, isEvmChainId } from "@xebra/sdk/core";

/** Aptos's CCTP domain. Literal here so reading it loads nothing else. */
export const APTOS_CCTP_DOMAIN = 9;
const SOLANA_DOMAIN = 5;
const STELLAR_DOMAIN = 27;

/** Where a transfer from Aptos can land. */
export type AptosDestination = EvmChainId | "solana" | "stellar";

/** Every destination Aptos could send to, in the order the page lists them. */
export const APTOS_ALL_DESTINATIONS: readonly AptosDestination[] = [
  "stellar",
  "arc",
  ...EVM_CHAIN_IDS.filter((id) => id !== "arc"),
  "solana",
];

export function aptosEnabled(): boolean {
  return process.env.APTOS_ENABLED === "true";
}

/**
 * The destinations `APTOS_SENDS_TO` names, in the page's order. Unknown names are ignored, never
 * guessed at. Empty when Aptos is off.
 */
export function aptosDestinations(): AptosDestination[] {
  if (!aptosEnabled()) return [];
  return parseAptosSendsTo(process.env.APTOS_SENDS_TO);
}

/** Pure, for tests: what a value of `APTOS_SENDS_TO` switches on. */
export function parseAptosSendsTo(raw: string | undefined): AptosDestination[] {
  const names = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.includes("all")) return [...APTOS_ALL_DESTINATIONS];
  const wanted = new Set(names);
  return APTOS_ALL_DESTINATIONS.filter((d) => wanted.has(d));
}

export function aptosDestinationDomain(d: AptosDestination): number {
  if (d === "solana") return SOLANA_DOMAIN;
  if (d === "stellar") return STELLAR_DOMAIN;
  return EVM_CHAINS[d].cctpDomainId;
}

export function isAptosDestination(v: unknown): v is AptosDestination {
  return v === "solana" || v === "stellar" || (typeof v === "string" && isEvmChainId(v));
}

/** Whether Aptos may send to this CCTP domain right now. */
export function aptosSendsToDomain(domain: number): boolean {
  return aptosDestinations().some((d) => aptosDestinationDomain(d) === domain);
}

/** The per-transfer cap in USDC base units, or null for none (the default). */
export function aptosMaxUsdcBase(): bigint | null {
  const raw = process.env.APTOS_MAX_USDC?.trim();
  if (!raw) return null;
  const usdc = Number(raw);
  if (!Number.isFinite(usdc) || usdc <= 0) return null;
  return BigInt(Math.round(usdc * 1_000_000));
}

export function aptosRpcUrl(): string {
  return (process.env.APTOS_RPC_URL?.trim() || "https://api.mainnet.aptoslabs.com/v1").replace(
    /\/+$/,
    "",
  );
}

export function aptosApiKey(): string | null {
  const v = process.env.APTOS_API_KEY?.trim();
  return v ? v : null;
}

export function notFound(): Response {
  return Response.json({ error: "not available" }, { status: 404 });
}
