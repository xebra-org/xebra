/**
 * Xebra for NEAR Intents.
 *
 * NEAR Intents settles trades between balances held in its Verifier contract (`intents.near`), and
 * moves money on and off NEAR through bridges. It does not move USDC from one chain to another:
 * when a user starts on Stellar and the liquidity is on Base, someone has to carry the USDC across.
 * Circle's CCTP does that one-for-one, by burning on one chain and minting native USDC on the other,
 * with no pool and no slippage. Xebra runs CCTP between Stellar, Sui, Solana and the EVM chains.
 *
 * This module is the seam between the two:
 *
 * - `isRouteAvailable(from, to)` answers, from Xebra's live route list, whether Xebra moves USDC
 *   between two chains right now. Chains can be named the way NEAR Intents names them (`sol`,
 *   `arb`) or the way Xebra does (`solana`, `arbitrum`). A caller asks first and keeps its usual
 *   path when the answer is no, so a route Xebra adds later is picked up without a code change.
 * - `usdcChainOf(token)` says whether an asset from the 1Click token list is Circle's own USDC, by
 *   its contract address, never by its symbol.
 * - `buildDeposit(...)` builds the unsigned transaction that moves USDC from the user's chain
 *   straight to a 1Click deposit address on another chain. NEAR Intents then takes over from that
 *   deposit exactly as if the user had sent it there.
 *
 * Nothing here holds a key or signs: the user's own wallet signs what `buildDeposit` returns.
 */

import { StrKey } from "@stellar/stellar-base";
import type { TransferBuild } from "../api/schemas.js";
import type { XebraClient } from "../client/index.js";
import { EVM_CHAINS, type EvmChainId, isEvmChainId } from "../core/chains/evm.js";
import { type ChainId, isChainId } from "../core/chains/ids.js";

/**
 * NEAR Intents' chain names (the `blockchain` field of the 1Click token list) for the chains Xebra
 * can reach. Chains Intents lists that have no native Circle USDC on CCTP (Tron, TON, Bitcoin, BNB
 * Chain) are absent on purpose: Xebra cannot move USDC there, so the caller keeps its usual path.
 */
export const INTENTS_CHAINS = {
  stellar: "stellar",
  sui: "sui",
  sol: "solana",
  base: "base",
  arb: "arbitrum",
  op: "optimism",
  avax: "avalanche",
  pol: "polygon",
  monad: "monad",
} as const satisfies Record<string, ChainId>;

export type IntentsChain = keyof typeof INTENTS_CHAINS;

const XEBRA_TO_INTENTS = new Map<ChainId, IntentsChain>(
  (Object.entries(INTENTS_CHAINS) as [IntentsChain, ChainId][]).map(([k, v]) => [v, k]),
);

/** Xebra's name for a chain given either NEAR Intents' name or Xebra's own, or null if unknown. */
export function toXebraChain(name: string): ChainId | null {
  const n = name.trim().toLowerCase();
  if (Object.hasOwn(INTENTS_CHAINS, n)) return INTENTS_CHAINS[n as IntentsChain];
  return isChainId(n) ? n : null;
}

/** NEAR Intents' name for a Xebra chain, or null if Intents does not list it. */
export function toIntentsChain(chain: ChainId): IntentsChain | null {
  return XEBRA_TO_INTENTS.get(chain) ?? null;
}

/**
 * The NEAR Intents account a Stellar wallet already owns.
 *
 * Intents accepts intents signed with Stellar's signed-message standard (SEP-53), and names the
 * signer's account after its ed25519 public key in hex, NEAR's implicit-account rule
 * (`PublicKey::to_implicit_account_id` in near/intents). So every Stellar address has an Intents
 * account without creating anything, and a refund sent there is the user's to withdraw by signing
 * with the same wallet.
 */
export function intentsAccountFor(stellarAddress: string): string {
  if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
    throw new Error(`Not a Stellar account address: ${stellarAddress}`);
  }
  // No Buffer: this runs in browsers too.
  return Array.from(StrKey.decodeEd25519PublicKey(stellarAddress), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Circle's USDC on Solana (the mint). */
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Circle's USDC on Sui (the coin type). */
export const SUI_USDC_TYPE =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
/** Circle's USDC on Stellar (the classic asset's issuer). */
export const STELLAR_USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

/**
 * The address of Circle's own USDC on `chain`, written the way the 1Click token list writes
 * `contractAddress`: lower-case for EVM chains, as-is elsewhere.
 */
export function circleUsdcAddress(chain: ChainId): string {
  if (chain === "solana") return SOLANA_USDC_MINT;
  if (chain === "sui") return SUI_USDC_TYPE;
  if (chain === "stellar") return STELLAR_USDC_ISSUER;
  return EVM_CHAINS[chain as EvmChainId].usdcAddress.toLowerCase();
}

/** One entry of `GET https://1click.chaindefuser.com/v0/tokens`, the fields this module reads. */
export interface IntentsToken {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
  contractAddress?: string;
}

/**
 * The Xebra chain on which `token` is Circle's native USDC, or null.
 *
 * Decided by the contract address alone. A symbol proves nothing: anyone can name a token USDC,
 * and bridged copies of USDC share the symbol without being something CCTP can burn.
 */
export function usdcChainOf(token: IntentsToken): ChainId | null {
  const chain = toXebraChain(token.blockchain);
  if (!chain || !token.contractAddress) return null;
  if (!(chain === "stellar" || chain === "sui" || chain === "solana" || isEvmChainId(chain))) {
    return null;
  }
  const expected = circleUsdcAddress(chain);
  const actual = isEvmChainId(chain) ? token.contractAddress.toLowerCase() : token.contractAddress;
  return actual === expected ? chain : null;
}

/**
 * Chains to deliver to when the user's own chain has thin Intents liquidity, best first. Base and
 * Arbitrum carry the deepest USDC books in NEAR Intents; Solana is next. A hub is only used when
 * Xebra reaches it from the user's chain at that moment.
 */
export const DEFAULT_HUBS: readonly ChainId[] = ["base", "arbitrum", "solana"];

export interface IntentsRouterOptions {
  /** A Xebra client (`createXebraClient()`); only `routes` and `createTransfer` are used. */
  client: Pick<XebraClient, "routes" | "createTransfer">;
  /** How long the route list is reused before it is read again. Default 30 s, the API's own cache. */
  cacheMs?: number;
  /** Injected clock, for tests. */
  now?: () => number;
}

export interface DepositRequest {
  /** The chain the user's USDC is on, in either naming. */
  from: string;
  /** The chain of the 1Click deposit address, in either naming. */
  depositChain: string;
  /** The 1Click deposit address on `depositChain`, from a non-dry quote. */
  depositAddress: string;
  /** The user's address on `from`; it signs and pays. */
  sender: string;
  /** Decimal USDC, at most 6 places, e.g. "25". */
  amount: string;
  /** Refuse to build if Xebra's and Circle's fees together exceed this decimal USDC amount. */
  maxTotalFee?: string;
}

export function createIntentsRouter(opts: IntentsRouterOptions) {
  const cacheMs = opts.cacheMs ?? 30_000;
  const now = opts.now ?? Date.now;
  let cached: { at: number; pairs: Set<string> } | null = null;
  let inflight: Promise<Set<string>> | null = null;

  async function pairs(): Promise<Set<string>> {
    if (cached && now() - cached.at < cacheMs) return cached.pairs;
    inflight ??= opts.client
      .routes()
      .then((r) => {
        const set = new Set(r.routes.map((x) => `${x.from}>${x.to}`));
        // A short list (part of it could not be read) still answers this call, but is not kept:
        // the next call reads again rather than refusing a route for the whole cache window.
        cached = r.complete ? { at: now(), pairs: set } : null;
        return set;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  /**
   * Whether Xebra moves USDC from `from` to `to` right now. Either chain may be named as NEAR
   * Intents names it or as Xebra does. Unknown chains and the same chain at both ends answer false.
   * If Xebra cannot be reached the promise rejects; a caller treats that as "no" and keeps its
   * usual path.
   */
  async function isRouteAvailable(from: string, to: string): Promise<boolean> {
    const a = toXebraChain(from);
    const b = toXebraChain(to);
    if (!a || !b || a === b) return false;
    return (await pairs()).has(`${a}>${b}`);
  }

  /**
   * The first of `hubs` that Xebra reaches from `from` right now, or null. Used to pick where to
   * deliver a user's USDC when their own chain has no liquidity in NEAR Intents.
   */
  async function pickHub(from: string, hubs: readonly ChainId[] = DEFAULT_HUBS) {
    for (const hub of hubs) {
      if (await isRouteAvailable(from, hub)) return hub;
    }
    return null;
  }

  /**
   * The unsigned transaction(s) that move the user's USDC straight to a 1Click deposit address.
   * Throws if Xebra does not offer the route right now, so a caller can fall back before showing
   * anything to sign.
   */
  async function buildDeposit(r: DepositRequest): Promise<TransferBuild> {
    const from = toXebraChain(r.from);
    const to = toXebraChain(r.depositChain);
    if (!from || !to) throw new Error(`Unknown chain: ${!from ? r.from : r.depositChain}`);
    if (!(await isRouteAvailable(from, to))) {
      throw new Error(`Xebra does not move USDC from ${from} to ${to} right now.`);
    }
    return opts.client.createTransfer({
      from,
      to,
      amount: r.amount,
      sender: r.sender,
      recipient: r.depositAddress,
      ...(r.maxTotalFee !== undefined ? { maxTotalFee: r.maxTotalFee } : {}),
    });
  }

  return { isRouteAvailable, pickHub, buildDeposit };
}

export type IntentsRouter = ReturnType<typeof createIntentsRouter>;
