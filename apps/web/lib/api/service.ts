import { StrKey } from "@stellar/stellar-sdk";
import type { CircleHealth } from "@xebra/cctp-client";
import { type BurnRecipient, FINALITY, encodeReceiveMessage } from "@xebra/cctp-evm";
import {
  InsufficientUsdcError,
  StellarSimulationError,
  type TransferStep,
  buildEvmBridge,
  buildStellarBridge,
} from "@xebra/sdk/build";
import {
  EVM_CHAINS,
  type EvmChainId,
  type FeePlan,
  type FeeTier,
  STELLAR_CCTP_DOMAIN,
  type WrapperTerms,
  bytesToHex,
  checkAddressOn,
  checkSolanaAddress,
  chooseMaxFee,
  evmChainForDomain,
  evmDestinationsFrom,
  evmSources,
  formatUsdc,
  formatUsdcAmount,
  forwardBoundHolds,
  isEvmChainId,
  minimumEvmAmount,
  minimumForwardedAmount,
  planEvmFee,
  planWrapperFee,
  solanaAddressToBytes32,
  stellarDestination,
  suggestedEvmMinimum,
  suggestedMinimum,
  withTableCeiling,
} from "@xebra/sdk/core";
import { humanizeContractError } from "../cctp-bridge";
import { ARC_GAS_RESERVE_UNITS, spendableUsdc } from "../evm-bridge";
import { termsFor } from "../evm-wrapper";
import { formatError } from "../format-error";
import { feeDestination, routeDestination } from "../route-destination";
import { SUI_CCTP_DOMAIN } from "../sui-stellar/config";
import type { Deps } from "./deps";
import { ApiError } from "./errors";

/**
 * Routes, prices and status, once, for every surface that answers them: the public API (`/v1`),
 * the MCP tools and, later, the SDK's own client. Amounts are 6-decimal USDC units throughout;
 * Stellar's 7-decimal stroops are converted here and nowhere else.
 */

export type Speed = "standard" | "fast";
export type SourceId = "stellar" | "sui" | "solana" | EvmChainId;
export type DestId = "stellar" | "solana" | EvmChainId;

export interface RouteGroup {
  from: SourceId;
  name: string;
  to: Array<{ id: DestId; name: string; speeds: Speed[] }>;
}

export interface Fees {
  /** What Xebra keeps. */
  xebra: bigint;
  /** Circle's transfer fee (Fast only). */
  circle: bigint;
  /** What Circle is paid to deliver on the destination. */
  delivery: bigint;
  total: bigint;
}

export interface Quote {
  from: SourceId;
  to: DestId;
  speed: Speed;
  amount: bigint;
  recipientGets: bigint;
  fees: Fees;
  /** The smallest amount this route takes right now, with a margin for fees moving. */
  minimum: bigint;
  /** The largest, or null when the route sets none. */
  maximum: bigint | null;
  circleStatus: "ok" | "degraded" | null;
  /** Fees move; after this the quote should be asked for again. */
  expiresAt: string;
}

/** A quote plus what produced it, for the surfaces that explain the figures. */
export interface PricedQuote {
  quote: Quote;
  /** Stellar sources: the contract's own figures, in stroops. */
  stellar: { amount: bigint; fee: bigint; deliveryFee: bigint; received: bigint } | null;
  evm: Extract<FeePlan, { ok: true }> | null;
  /** EVM sources through Xebra's wrapper: where to send, and the most it may take in all. */
  evmVia?: { address: string; maxWrapperFee: bigint } | null;
}

export type QuoteOption =
  | { speed: Speed; ok: true; priced: PricedQuote }
  | { speed: Speed; ok: false; error: ApiError };

export type DeliveryState = "pending" | "delivering" | "delivered" | "needs_claim" | "failed";

export interface TransferStatus {
  state: DeliveryState;
  chain: SourceId;
  tx: string;
  /** The mint on the destination, once Circle has delivered it. */
  deliveryTx: string | null;
  /** Circle's own words when delivery failed, shortened. */
  reason: string | null;
  /** Where the recipient finishes a delivery that did not complete on its own. */
  claimUrl: string | null;
  /** Circle's state word, for the MCP tool's text. */
  circleState: string;
}

const QUOTE_TTL_MS = 60_000;
/** Stellar has Standard finality only. */
const STANDARD_FINALITY = 2000;
/** How long a signed Stellar request stays valid; the contract refuses beyond an hour. */
const REQUEST_TTL_SECONDS = 600;
const SUI_ADDRESS = /^0x[0-9a-fA-F]{64}$/;
/** A Sui transaction digest: base58, 32 bytes. */
const SUI_DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
/** A Solana transaction signature: base58, 64 bytes. */
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const SOLANA_DOMAIN = 5;
/** The smallest Solana to Stellar transfer: what the relayer completes (`/api/stellar-inbound/complete`). */
const SOLANA_STELLAR_MIN_UNITS = 1_000_000n;

function checkSender(from: SourceId, sender: string): void {
  const ok =
    from === "stellar"
      ? StrKey.isValidEd25519PublicKey(sender)
      : from === "sui"
        ? SUI_ADDRESS.test(sender)
        : from === "solana"
          ? checkSolanaAddress(sender).ok
          : checkAddressOn(EVM_CHAINS[from], sender).ok;
  if (!ok) {
    throw new ApiError(
      "invalid_request",
      `sender must be the ${from === "stellar" ? "Stellar account (G...)" : from === "sui" ? "Sui address (0x + 64 hex)" : from === "solana" ? "Solana wallet address" : `${EVM_CHAINS[from].name} address`} that will sign.`,
    );
  }
}

/**
 * Runs a read against Circle or a chain. Our own refusals pass through; anything else means the
 * upstream could not be asked, which is a "try again" (503), never a verdict on the transfer.
 */
async function upstream<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof ApiError || err instanceof InsufficientUsdcError) throw err;
    console.error(`${what} could not be read`, err);
    throw new ApiError(
      "upstream_unavailable",
      `${what} could not be read just now. Try again shortly.`,
    );
  }
}

/** Ends a borrowed message with exactly one full stop. */
function sentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

function short(have: bigint, need: bigint, chain: string, note = ""): ApiError {
  return new ApiError(
    "insufficient_balance",
    `The sender holds ${formatUsdcAmount(have)} USDC on ${chain}; this transfer needs ${formatUsdcAmount(need)}.${note}`,
    { have, need },
  );
}
const STROOPS_PER_UNIT = 10n;

const SOURCE_NAME = (id: SourceId): string =>
  id === "stellar"
    ? "Stellar"
    : id === "sui"
      ? "Sui"
      : id === "solana"
        ? "Solana"
        : EVM_CHAINS[id].name;
const DEST_NAME = (id: DestId): string =>
  id === "stellar" ? "Stellar" : id === "solana" ? "Solana" : EVM_CHAINS[id].name;

export function isSourceId(v: string): v is SourceId {
  return v === "stellar" || v === "sui" || v === "solana" || isEvmChainId(v);
}
export function isDestId(v: string): v is DestId {
  return v === "stellar" || v === "solana" || isEvmChainId(v);
}

const ceilToUnits = (stroops: bigint) => (stroops + STROOPS_PER_UNIT - 1n) / STROOPS_PER_UNIT;
const floorToUnits = (stroops: bigint) => stroops / STROOPS_PER_UNIT;

/** How long a wrapper request stays good once built. The contract allows at most 3,600 s. */
const WRAPPER_DEADLINE_SECS = 1_800;

export function createService(deps: Deps, now: () => number = Date.now) {
  async function routes(): Promise<{ routes: RouteGroup[]; stellarContractRead: boolean }> {
    const stellar = await deps.stellarRoutes();
    const groups: RouteGroup[] = [
      {
        from: "stellar",
        name: "Stellar",
        to: stellar.destinations.map((d) => ({ id: d.id, name: d.name, speeds: ["standard"] })),
      },
    ];
    for (const source of evmSources(deps.evmRoutes)) {
      const speeds: Speed[] = EVM_CHAINS[source].fast ? ["standard", "fast"] : ["standard"];
      groups.push({
        from: source,
        name: SOURCE_NAME(source),
        to: evmDestinationsFrom(source, deps.evmRoutes).map((id) => ({
          id,
          name: DEST_NAME(id),
          speeds,
        })),
      });
    }
    if (deps.suiStellar.enabled) {
      groups.push({
        from: "sui",
        name: "Sui",
        to: [{ id: "stellar", name: "Stellar", speeds: ["standard"] }],
      });
    }
    const solana = deps.solanaSource;
    if (solana && (solana.stellar || solana.evm.length > 0)) {
      const to: DestId[] = [...(solana.stellar ? (["stellar"] as const) : []), ...solana.evm];
      groups.push({
        from: "solana",
        name: "Solana",
        // Standard only: Circle charges nothing for it, and Solana finalises in seconds.
        to: to.map((id) => ({ id, name: DEST_NAME(id), speeds: ["standard"] })),
      });
    }
    return { routes: groups, stellarContractRead: stellar.domains !== null };
  }

  /** Throws `route_unavailable` unless `from` reaches `to` right now. */
  async function checkRoute(from: SourceId, to: DestId): Promise<void> {
    const { routes: groups } = await routes();
    const live = groups.find((g) => g.from === from)?.to.some((d) => d.id === to) ?? false;
    if (!live) {
      throw new ApiError(
        "route_unavailable",
        `Xebra does not send from ${SOURCE_NAME(from)} to ${DEST_NAME(to)} right now.`,
        { from, to },
      );
    }
  }

  function quoteOf(
    from: SourceId,
    to: DestId,
    speed: Speed,
    amount: bigint,
    p: {
      recipientGets: bigint;
      fees: Omit<Fees, "total">;
      minimum: bigint;
      maximum: bigint | null;
    },
    health: CircleHealth | null,
  ): Quote {
    const { xebra, circle, delivery } = p.fees;
    return {
      from,
      to,
      speed,
      amount,
      recipientGets: p.recipientGets,
      fees: { xebra, circle, delivery, total: xebra + circle + delivery },
      minimum: p.minimum,
      maximum: p.maximum,
      circleStatus: health ? (health.status === "ok" ? "ok" : "degraded") : null,
      expiresAt: new Date(now() + QUOTE_TTL_MS).toISOString(),
    };
  }

  async function circleFor(from: SourceId, to: DestId, newAccount: boolean): Promise<CircleHealth> {
    const src =
      from === "stellar"
        ? STELLAR_CCTP_DOMAIN
        : from === "solana"
          ? SOLANA_DOMAIN
          : EVM_CHAINS[from as EvmChainId].cctpDomainId;
    const dst =
      to === "solana"
        ? stellarDestination("solana").domain
        : EVM_CHAINS[to as EvmChainId].cctpDomainId;
    const health = newAccount ? await deps.circle(src, dst, true) : await deps.circle(src, dst);
    if (!health?.quote) {
      throw new ApiError(
        "upstream_unavailable",
        "Circle's delivery fee could not be read just now, so no price can be given. Try again shortly.",
      );
    }
    if (health.status === "down") {
      throw new ApiError(
        "upstream_unavailable",
        `Circle is not carrying transfers on this route right now (${health.reasons.join("; ") || "down"}). Do not start one.`,
      );
    }
    return health;
  }

  async function stellarOption(
    to: DestId,
    units: bigint,
    health: CircleHealth,
    needsAccount: boolean,
  ): Promise<QuoteOption> {
    const speed: Speed = "standard";
    const dest = stellarDestination(to as Exclude<DestId, "stellar">);
    const [{ domains }, params] = await Promise.all([deps.stellarRoutes(), deps.feeParams()]);
    if (!params) {
      throw new ApiError(
        "upstream_unavailable",
        "The bridge contract's fee schedule could not be read just now. Try again shortly.",
      );
    }
    // The contract's caps for this chain, lowered to the table's ceiling. If the contract cannot be
    // read, only the table's ceiling applies here and the contract checks the rest at signing.
    const committed = domains?.get(dest.domain);
    if (domains && !committed) {
      throw new ApiError(
        "route_unavailable",
        `The bridge contract does not send to ${dest.name} yet.`,
      );
    }
    const cfg = withTableCeiling(
      committed ?? {
        forward: true,
        maxForwardFee: BigInt(Number.MAX_SAFE_INTEGER),
        accountCreation: true,
        maxForwardFeeNewAccount: BigInt(Number.MAX_SAFE_INTEGER),
      },
      dest.evm?.maxForwardFeeUnits ?? null,
    );
    const choice = chooseMaxFee({
      quote: health.quote as NonNullable<CircleHealth["quote"]>,
      needsAccount,
      cfg,
      destinationName: dest.name,
    });
    if (!choice.ok) throw new ApiError("upstream_unavailable", choice.reason);

    const amount = units * STROOPS_PER_UNIT;
    const m = choice.maxFee;
    const minimumStroops = suggestedMinimum(minimumForwardedAmount(m, params));
    const minimum = ceilToUnits(
      params.minTransfer !== undefined && params.minTransfer > minimumStroops
        ? params.minTransfer
        : minimumStroops,
    );
    const maximum = params.maxTransfer !== undefined ? floorToUnits(params.maxTransfer) : null;
    if (!forwardBoundHolds(amount, m, params)) {
      return {
        speed,
        ok: false,
        error: new ApiError(
          "amount_below_minimum",
          `Fees would take more than a tenth of this transfer. Send at least ${formatUsdc(minimumStroops)} USDC to ${dest.name}.`,
          { minimum },
        ),
      };
    }
    if (params.minTransfer !== undefined && amount < params.minTransfer) {
      return {
        speed,
        ok: false,
        error: new ApiError(
          "amount_below_minimum",
          `The bridge contract takes at least ${formatUsdc(params.minTransfer)} USDC per transfer.`,
          { minimum },
        ),
      };
    }
    if (params.maxTransfer !== undefined && amount > params.maxTransfer) {
      return {
        speed,
        ok: false,
        error: new ApiError(
          "amount_above_maximum",
          `The bridge contract takes at most ${formatUsdc(params.maxTransfer)} USDC per transfer.`,
          { maximum },
        ),
      };
    }
    // The contract's split: our fee is the largest of the percentage, the floor and Circle's fee;
    // what is burned is what remains after our share, floored to a whole unit; Circle keeps `m`.
    const pct = (amount * params.feeBps) / 10_000n;
    const base = pct > params.minFee ? pct : params.minFee;
    const fee = base > m ? base : m;
    const after = amount - (fee - m);
    const burned = after - (after % STROOPS_PER_UNIT);
    const received = burned - m;
    return {
      speed,
      ok: true,
      priced: {
        quote: quoteOf(
          "stellar",
          to,
          speed,
          units,
          {
            recipientGets: floorToUnits(received),
            // Xebra's share can carry a seventh decimal; it is shown rounded up, never down.
            fees: { xebra: ceilToUnits(fee - m), circle: 0n, delivery: floorToUnits(m) },
            minimum,
            maximum,
          },
          health,
        ),
        stellar: { amount, fee, deliveryFee: m, received },
        evm: null,
      },
    };
  }

  function evmOption(
    from: EvmChainId,
    to: DestId,
    units: bigint,
    speed: Speed,
    tier: FeeTier,
    health: CircleHealth,
    opensAccount: boolean,
    wrapper: { address: string; terms: WrapperTerms } | null,
  ): QuoteOption {
    const dest = routeDestination(to as Exclude<DestId, "stellar">);
    const destination = feeDestination(dest, opensAccount);
    const plan = wrapper
      ? planWrapperFee({
          amount: units,
          tier,
          destination,
          terms: wrapper.terms,
          opensAccount,
          sourceName: SOURCE_NAME(from),
        })
      : planEvmFee({ amount: units, tier, destination });
    const floor = suggestedEvmMinimum(minimumEvmAmount(tier));
    const minimum =
      wrapper && wrapper.terms.minTransfer > floor ? wrapper.terms.minTransfer : floor;
    if (!plan.ok) {
      const code =
        plan.kind === "minimum"
          ? "amount_below_minimum"
          : plan.kind === "maximum"
            ? "amount_above_maximum"
            : plan.kind === "amount"
              ? "invalid_amount"
              : "upstream_unavailable";
      return { speed, ok: false, error: new ApiError(code, plan.reason, { minimum }) };
    }
    return {
      speed,
      ok: true,
      priced: {
        quote: quoteOf(
          from,
          to,
          speed,
          units,
          {
            recipientGets: plan.received,
            fees: { xebra: plan.xebraFee, circle: plan.speedFee, delivery: plan.deliveryFee },
            minimum,
            maximum: wrapper ? wrapper.terms.maxTransfer : null,
          },
          health,
        ),
        stellar: null,
        evm: plan,
        evmVia: wrapper ? { address: wrapper.address, maxWrapperFee: plan.fee } : null,
      },
    };
  }

  /**
   * Xebra's wrapper on `from`, narrowed to the destination, when this build sends through one there.
   * Unreadable settings stop the quote: an unpriced fee is not a zero fee.
   */
  async function evmWrapperFor(
    from: EvmChainId,
    to: DestId,
  ): Promise<{ address: string; terms: WrapperTerms } | null> {
    const chain = EVM_CHAINS[from];
    const address = deps.evmWrapperAddress?.(chain) ?? null;
    if (!address) return null;
    const settings = await deps.evmWrapperSettings?.(chain);
    if (!settings) {
      throw new ApiError(
        "upstream_unavailable",
        `Xebra's contract on ${chain.name} could not be read just now, so no price can be given. Try again shortly.`,
      );
    }
    const dest = routeDestination(to as Exclude<DestId, "stellar">);
    return { address, terms: termsFor(settings, dest.cctpDomainId) };
  }

  /**
   * Every speed the route offers, each priced or refused with its reason. Throws only for what
   * stops the route as a whole (not offered, Circle unreadable or down, contract unreadable).
   */
  async function quoteOptions(q: {
    from: SourceId;
    to: DestId;
    amount: bigint;
    /** Solana: Circle also opens the recipient's USDC account, which costs more. */
    opensAccount?: boolean;
  }): Promise<{ health: CircleHealth | null; options: QuoteOption[] }> {
    const opensAccount = q.opensAccount ?? false;
    if (q.amount <= 0n) throw new ApiError("invalid_amount", "The amount must be more than zero.");
    await checkRoute(q.from, q.to);

    if (q.from === "sui") {
      // Standard finality, no fee from Circle, none from us yet: the recipient gets all of it.
      const cap = deps.suiStellar.maxUnits;
      if (cap !== null && q.amount > cap) {
        throw new ApiError(
          "amount_above_maximum",
          `Sui to Stellar takes at most ${formatUsdcAmount(cap)} USDC per transfer.`,
          { maximum: cap },
        );
      }
      const quote = quoteOf(
        "sui",
        "stellar",
        "standard",
        q.amount,
        {
          recipientGets: q.amount,
          fees: { xebra: 0n, circle: 0n, delivery: 0n },
          minimum: 1n,
          maximum: cap,
        },
        null,
      );
      return {
        health: null,
        options: [{ speed: "standard", ok: true, priced: { quote, stellar: null, evm: null } }],
      };
    }

    if (q.from === "solana") return solanaOptions(q.to, q.amount);

    const health = await circleFor(q.from, q.to, opensAccount);
    if (q.from === "stellar") {
      return { health, options: [await stellarOption(q.to, q.amount, health, opensAccount)] };
    }
    const from = q.from;
    const wrapper = await evmWrapperFor(from, q.to);
    const tiers: Array<[Speed, FeeTier | null]> = [
      ["standard", health.tiers.standard],
      ["fast", EVM_CHAINS[from].fast ? health.tiers.fast : null],
    ];
    const options = tiers
      .filter((t): t is [Speed, FeeTier] => t[1] !== null)
      .map(([speed, tier]) =>
        evmOption(from, q.to, q.amount, speed, tier, health, opensAccount, wrapper),
      );
    return { health, options };
  }

  /**
   * Solana's one speed, Standard. To Stellar: no fee from anyone, so the recipient gets it all, from
   * 1 USDC (what the relayer completes). To an EVM chain: Circle's delivery fee only, priced as
   * every direct EVM route is. Xebra takes nothing: it has no contract on Solana.
   */
  async function solanaOptions(
    to: DestId,
    amount: bigint,
  ): Promise<{ health: CircleHealth | null; options: QuoteOption[] }> {
    const cap = deps.solanaSource?.maxUnits ?? null;
    if (cap !== null && amount > cap) {
      throw new ApiError(
        "amount_above_maximum",
        `Transfers from Solana take at most ${formatUsdcAmount(cap)} USDC each.`,
        { maximum: cap },
      );
    }
    if (to === "stellar") {
      const quote = quoteOf(
        "solana",
        "stellar",
        "standard",
        amount,
        {
          recipientGets: amount,
          fees: { xebra: 0n, circle: 0n, delivery: 0n },
          minimum: SOLANA_STELLAR_MIN_UNITS,
          maximum: cap,
        },
        null,
      );
      const option: QuoteOption =
        amount < SOLANA_STELLAR_MIN_UNITS
          ? {
              speed: "standard",
              ok: false,
              error: new ApiError(
                "amount_below_minimum",
                `Send at least ${formatUsdcAmount(SOLANA_STELLAR_MIN_UNITS)} USDC from Solana to Stellar.`,
                { minimum: SOLANA_STELLAR_MIN_UNITS },
              ),
            }
          : { speed: "standard", ok: true, priced: { quote, stellar: null, evm: null } };
      return { health: null, options: [option] };
    }
    const health = await circleFor("solana", to, false);
    const tier = health.tiers.standard;
    if (!tier) {
      throw new ApiError(
        "upstream_unavailable",
        "Circle's delivery fee could not be read just now, so no price can be given. Try again shortly.",
      );
    }
    const chain = EVM_CHAINS[to as EvmChainId];
    const plan = planEvmFee({ amount, tier, destination: chain });
    const minimum = suggestedEvmMinimum(minimumEvmAmount(tier));
    if (!plan.ok) {
      const code =
        plan.kind === "minimum"
          ? "amount_below_minimum"
          : plan.kind === "maximum"
            ? "amount_above_maximum"
            : plan.kind === "amount"
              ? "invalid_amount"
              : "upstream_unavailable";
      return {
        health,
        options: [
          { speed: "standard", ok: false, error: new ApiError(code, plan.reason, { minimum }) },
        ],
      };
    }
    return {
      health,
      options: [
        {
          speed: "standard",
          ok: true,
          priced: {
            quote: quoteOf(
              "solana",
              to,
              "standard",
              amount,
              {
                recipientGets: plan.received,
                fees: { xebra: 0n, circle: plan.speedFee, delivery: plan.deliveryFee },
                minimum,
                maximum: cap,
              },
              health,
            ),
            stellar: null,
            evm: plan,
          },
        },
      ],
    };
  }

  /** One speed's price, or the reason it cannot be priced. */
  async function quote(q: {
    from: SourceId;
    to: DestId;
    amount: bigint;
    speed?: Speed;
    opensAccount?: boolean;
  }): Promise<PricedQuote> {
    const speed = q.speed ?? "standard";
    const { options } = await quoteOptions(q);
    const option = options.find((o) => o.speed === speed);
    if (!option) {
      throw new ApiError(
        "route_unavailable",
        `${speed === "fast" ? "Fast" : "Standard"} transfers are not offered from ${SOURCE_NAME(q.from)} to ${DEST_NAME(q.to)}.`,
      );
    }
    if (!option.ok) throw option.error;
    return option.priced;
  }

  async function transferStatus(r: { chain: SourceId; tx: string }): Promise<TransferStatus> {
    if (r.chain === "sui") return suiStatus(r.tx.trim());
    if (r.chain === "solana") return solanaStatus(r.tx.trim());
    return circleStatus(r.chain, r.tx.trim().toLowerCase());
  }

  /**
   * A Solana burn: into Stellar, it is finished by the relayer or the owner's claim, so Stellar's
   * own record is the answer; to an EVM chain, Circle's delivery record is, as for any source.
   */
  async function solanaStatus(tx: string): Promise<TransferStatus> {
    if (!SOLANA_SIGNATURE.test(tx)) {
      throw new ApiError("invalid_request", "tx must be a Solana transaction signature.");
    }
    const stellar = await deps.solanaStellarStatus?.(tx).catch(() => null);
    if (stellar?.state === "complete" && typeof stellar.refusal !== "string") {
      return {
        state: stellar.delivered === true ? "delivered" : "needs_claim",
        chain: "solana",
        tx,
        deliveryTx: null,
        reason: null,
        // Finished through POST /v1/claims, or by the relayer; the bridge page follows it itself.
        claimUrl: null,
        circleState: "complete",
      };
    }
    return circleStatus("solana", tx);
  }

  async function circleStatus(
    chain: Exclude<SourceId, "sui">,
    tx: string,
  ): Promise<TransferStatus> {
    const r = { chain, tx };
    const kind =
      r.chain === "stellar"
        ? /^[0-9a-f]{64}$/
        : r.chain === "solana"
          ? SOLANA_SIGNATURE
          : /^0x[0-9a-f]{64}$/;
    if (!kind.test(tx)) {
      throw new ApiError(
        "invalid_request",
        r.chain === "stellar"
          ? "tx must be 64 hex characters, without 0x."
          : "tx must be 0x followed by 64 hex characters.",
      );
    }
    const domain =
      r.chain === "stellar"
        ? STELLAR_CCTP_DOMAIN
        : r.chain === "solana"
          ? SOLANA_DOMAIN
          : EVM_CHAINS[r.chain].cctpDomainId;
    const answer = await deps.delivery(tx, domain);
    if (!answer || answer.status === "unknown") {
      throw new ApiError(
        "upstream_unavailable",
        "Circle's status could not be read just now. That does not mean the transfer failed. Try again shortly.",
      );
    }
    const circleState = String(answer.state ?? "unknown");
    const state: DeliveryState =
      circleState === "delivered"
        ? "delivered"
        : circleState === "forwarding"
          ? "delivering"
          : circleState === "claimable"
            ? "needs_claim"
            : circleState === "failed"
              ? "failed"
              : "pending";
    const claimable = state === "needs_claim" || state === "failed";
    return {
      state,
      chain: r.chain,
      tx,
      deliveryTx: typeof answer.forwardTxHash === "string" ? answer.forwardTxHash : null,
      // Circle's own words, shown as data: short, and nothing is done with them.
      reason: typeof answer.reason === "string" ? answer.reason.slice(0, 200) : null,
      claimUrl: claimable
        ? `${deps.siteUrl.replace(/\/+$/, "")}/claim?tx=${tx}${r.chain === "stellar" ? "" : `&src=${domain}`}`
        : null,
      circleState,
    };
  }

  /**
   * A Solana wallet's USDC token account, and whether Circle must open it (which costs more).
   * Refuses rather than guesses when the lookup fails, because the price depends on the answer.
   */
  async function solanaRecipient(
    recipient: string,
  ): Promise<{ tokenAccount: Uint8Array; owner: Uint8Array; opensAccount: boolean }> {
    const b = deps.build;
    if (!b) throw new Error("solanaRecipient needs the build dependencies");
    const check = checkSolanaAddress(recipient.trim());
    if (!check.ok || !check.bytes) {
      throw new ApiError(
        "invalid_recipient",
        `That is not a Solana address: ${sentence(check.error ?? recipient)}`,
      );
    }
    const found = await upstream("The recipient's Solana account", () =>
      b.solanaRecipient(recipient.trim()),
    );
    if (found.status === "unknown") {
      throw new ApiError(
        "upstream_unavailable",
        "Whether the recipient has a USDC account on Solana could not be read just now, and the price depends on it. Try again shortly.",
      );
    }
    return {
      tokenAccount: solanaAddressToBytes32(found.tokenAccount),
      owner: check.bytes,
      opensAccount: found.status === "missing",
    };
  }

  /** Whether a transfer to this Solana wallet must also open its USDC account. */
  async function solanaOpensAccount(recipient: string): Promise<boolean> {
    return (await solanaRecipient(recipient)).opensAccount;
  }

  /**
   * Prices the transfer for this sender and recipient, checks what can be checked before anyone
   * signs (addresses, the recipient's account, the sender's balance), and returns the unsigned
   * transactions in signing order. Nothing is signed or sent.
   */
  async function buildTransfer(r: {
    from: SourceId;
    to: DestId;
    amount: bigint;
    sender: string;
    recipient: string;
    speed?: Speed;
    /** The most the caller will let fees come to, typically the total it showed its user. */
    maxTotalFee?: bigint;
  }): Promise<{ quote: Quote; steps: TransferStep[] }> {
    const b = deps.build;
    if (!b) throw new Error("buildTransfer needs the build dependencies");
    const sender = r.sender.trim();
    const recipient = r.recipient.trim();
    checkSender(r.from, sender);

    // The recipient, read the way the destination needs it.
    let opensAccount = false;
    let mintRecipient: Uint8Array | null = null;
    let solana: { tokenAccount: Uint8Array; owner: Uint8Array } | null = null;
    if (r.to === "solana") {
      const found = await solanaRecipient(recipient);
      opensAccount = found.opensAccount;
      solana = { tokenAccount: found.tokenAccount, owner: found.owner };
      mintRecipient = found.tokenAccount;
    } else if (r.to === "stellar") {
      if (!StrKey.isValidEd25519PublicKey(recipient)) {
        throw new ApiError(
          "invalid_recipient",
          "The recipient must be a Stellar account address starting with G.",
        );
      }
      const account = await upstream("The recipient's Stellar account", () =>
        b.stellarAccount(recipient),
      );
      if (!account.exists) {
        throw new ApiError(
          "invalid_recipient",
          "That Stellar account does not exist yet. It needs XLM to be created and a USDC trustline before it can receive.",
        );
      }
      if (!account.hasTrustline) {
        throw new ApiError(
          "invalid_recipient",
          "That Stellar account has no USDC trustline. Add one, then try again.",
        );
      }
    } else {
      const check = checkAddressOn(EVM_CHAINS[r.to], recipient);
      if (!check.ok || !check.bytes) {
        throw new ApiError(
          "invalid_recipient",
          `That is not a valid ${EVM_CHAINS[r.to].name} address: ${sentence(check.error ?? recipient)}`,
        );
      }
      mintRecipient = check.bytes;
    }

    const priced = await quote({
      from: r.from,
      to: r.to,
      amount: r.amount,
      ...(r.speed ? { speed: r.speed } : {}),
      opensAccount,
    });
    if (r.maxTotalFee !== undefined && priced.quote.fees.total > r.maxTotalFee) {
      throw new ApiError(
        "fee_above_limit",
        `Fees are now ${formatUsdcAmount(priced.quote.fees.total)} USDC, above the ${formatUsdcAmount(r.maxTotalFee)} USDC limit. Quote again.`,
        { total: priced.quote.fees.total, limit: r.maxTotalFee },
      );
    }

    if (r.from === "solana") {
      if (!b.solanaBurn) {
        throw new ApiError("route_unavailable", "Sending from Solana is not configured here.");
      }
      const solanaBurn = b.solanaBurn;
      const step = await upstream("Solana's RPC", () =>
        solanaBurn({
          sender,
          amount: r.amount,
          to: r.to as "stellar" | EvmChainId,
          recipient,
          maxFee: priced.evm?.maxFee ?? 0n,
        }),
      );
      // A Solana transaction names a recent block and stops being valid about a minute later.
      return { quote: priced.quote, steps: [step] };
    }

    if (r.from === "sui") {
      try {
        const step = await upstream("The Sui node", () =>
          b.suiBurn({ sender, amount: r.amount, stellarRecipient: recipient }),
        );
        return { quote: priced.quote, steps: [step] };
      } catch (err) {
        if (err instanceof InsufficientUsdcError) throw short(err.have, err.need, "Sui");
        throw err;
      }
    }

    if (r.from === "stellar") {
      const figures = priced.stellar;
      if (!figures || !mintRecipient) throw new Error("a Stellar quote without its figures");
      if (!b.stellarWrapper) {
        throw new ApiError("route_unavailable", "Sending from Stellar is not configured here.");
      }
      // Read like the page reads it: no build while the contract's destinations are unknown.
      if ((await deps.stellarRoutes()).domains === null) {
        throw new ApiError(
          "upstream_unavailable",
          "The bridge contract could not be read just now. Try again shortly.",
        );
      }
      const account = await upstream("The sender's Stellar account", () =>
        b.stellarAccount(sender),
      );
      if (!account.exists) {
        throw new ApiError(
          "insufficient_balance",
          "The sender's Stellar account does not exist yet, so it holds no USDC.",
          { have: 0n, need: r.amount },
        );
      }
      if (account.balance < figures.amount) {
        throw short(
          floorToUnits(account.balance),
          r.amount,
          "Stellar",
          account.hasTrustline ? "" : " It has no USDC trustline.",
        );
      }
      try {
        const step = await buildStellarBridge(b.stellarRpc(), b.stellarWrapper, {
          user: sender,
          amount: figures.amount,
          destinationDomain: stellarDestination(r.to as Exclude<DestId, "stellar">).domain,
          mintRecipient,
          maxFee: figures.deliveryFee,
          // Pins the fee in this quote: if it rises before the transaction lands, the contract
          // refuses rather than charging more than was shown.
          maxWrapperFee: figures.fee,
          minFinalityThreshold: STANDARD_FINALITY,
          recipientNeedsAccount: opensAccount,
          recipientOwner: opensAccount && solana ? solana.owner : null,
          ttlSeconds: REQUEST_TTL_SECONDS,
        });
        return { quote: priced.quote, steps: [step] };
      } catch (err) {
        if (err instanceof StellarSimulationError) {
          throw new ApiError(
            "transaction_rejected",
            `Stellar would reject this transfer: ${humanizeContractError(formatError(err), b.stellarWrapper.wrapperContractId)}`,
          );
        }
        console.error("stellar build failed", err);
        throw new ApiError(
          "upstream_unavailable",
          "Stellar's RPC could not be reached to prepare the transfer. Try again shortly.",
        );
      }
    }

    // An EVM source: through Xebra's wrapper where the quote priced one, else straight to Circle.
    const source = EVM_CHAINS[r.from];
    const via = priced.evmVia ?? null;
    const plan = priced.evm;
    if (!plan) throw new Error("an EVM quote without its fee plan");
    const burnRecipient: BurnRecipient = solana
      ? {
          kind: "solana",
          tokenAccount: bytesToHex(solana.tokenAccount),
          createAccountFor: opensAccount ? bytesToHex(solana.owner) : undefined,
        }
      : recipient;
    const { balance, allowance } = await upstream(`The sender's USDC on ${source.name}`, () =>
      b.evmUsdc(source, sender, via ? via.address : source.tokenMessengerAddress),
    );
    if (balance < r.amount) throw short(balance, r.amount, source.name);
    if (spendableUsdc(source, balance) < r.amount) {
      throw new ApiError(
        "insufficient_balance",
        `${source.name} pays gas in USDC. Leave ${formatUsdcAmount(ARC_GAS_RESERVE_UNITS)} USDC in the wallet for it and send up to ${formatUsdcAmount(spendableUsdc(source, balance))}.`,
        { have: balance, need: r.amount + ARC_GAS_RESERVE_UNITS },
      );
    }
    const steps = buildEvmBridge({
      source,
      from: sender,
      destination: {
        cctpDomainId: routeDestination(r.to as Exclude<DestId, "stellar">).cctpDomainId,
      },
      recipient: burnRecipient,
      amount: r.amount,
      maxFee: plan.maxFee,
      finality: priced.quote.speed === "fast" ? FINALITY.fast : FINALITY.standard,
      via,
      allowance,
      // The wrapper refuses a request past its deadline, and one more than an hour out. Half an
      // hour leaves room for an approval to confirm first.
      deadline: via ? BigInt(Math.floor(now() / 1000) + WRAPPER_DEADLINE_SECS) : 0n,
    }).map((step) =>
      // Circle's fee is fixed into the burn when it is built. If an approval comes first and takes
      // longer than the quote lasts, build again: the approval stands, and the burn is re-priced.
      step.id === "burn"
        ? {
            ...step,
            expiresAt: priced.quote.expiresAt,
            description: `${step.description} Signed after ${priced.quote.expiresAt}, build it again first: the fee may have moved.`,
          }
        : step,
    );
    return { quote: priced.quote, steps };
  }

  async function suiStatus(digest: string): Promise<TransferStatus> {
    if (!SUI_DIGEST.test(digest)) {
      throw new ApiError("invalid_request", "tx must be a Sui transaction digest.");
    }
    if (!deps.suiStellar.enabled || !deps.suiStatus) {
      throw new ApiError("route_unavailable", "Sui to Stellar is not switched on here.");
    }
    const answer = await deps.suiStatus(digest);
    if (!answer) {
      throw new ApiError(
        "upstream_unavailable",
        "Circle's status could not be read just now. That does not mean the transfer failed. Try again shortly.",
      );
    }
    const circleState = String(answer.state ?? "unknown");
    const refusal = typeof answer.refusal === "string" ? answer.refusal.slice(0, 200) : null;
    if (circleState === "complete" && answer.delivered !== true && refusal) {
      // Not a burn the Stellar side would complete. A Sui burn to an EVM chain (Sui to Monad) is
      // minted by Circle's Forwarding Service, so its record, not the Stellar check, is the answer.
      const forwarded = await suiForwarded(digest);
      if (forwarded) return forwarded;
    }
    // Circle not having indexed the burn yet is "not yet", the same as waiting for attestation.
    const state: DeliveryState =
      circleState !== "complete"
        ? "pending"
        : answer.delivered === true
          ? "delivered"
          : refusal
            ? "failed"
            : "needs_claim";
    return {
      state,
      chain: "sui",
      tx: digest,
      deliveryTx: null,
      reason: refusal,
      // Finished through POST /v1/claims; the Sui page takes no link.
      claimUrl: null,
      circleState,
    };
  }

  /** A Sui burn Circle forwarded (minted, or minting) on its destination, or null if it did not. */
  async function suiForwarded(digest: string): Promise<TransferStatus | null> {
    const answer = await deps.delivery(digest, SUI_CCTP_DOMAIN).catch(() => null);
    if (!answer || answer.status !== "known") return null;
    const circleState = String(answer.state ?? "unknown");
    if (circleState !== "delivered" && circleState !== "forwarding") return null;
    return {
      state: circleState === "delivered" ? "delivered" : "delivering",
      chain: "sui",
      tx: digest,
      deliveryTx: typeof answer.forwardTxHash === "string" ? answer.forwardTxHash : null,
      reason: null,
      claimUrl: null,
      circleState,
    };
  }

  /**
   * The unsigned mint for a transfer whose delivery did not complete on its own, with `payer`
   * paying the destination's fee. Checked before it is returned: a mint that already happened, or
   * one that would revert, is refused here instead of costing anyone a fee.
   */
  async function buildClaim(r: {
    chain: SourceId;
    tx: string;
    payer: string;
    /** Solana only: the wallet that owns the recipient's USDC account, when it must be opened. */
    recipientOwner?: string;
  }): Promise<{ steps: TransferStep[] }> {
    const b = deps.build;
    if (!b) throw new Error("buildClaim needs the build dependencies");
    const payer = r.payer.trim();

    if (r.chain === "sui") {
      const digest = r.tx.trim();
      if (!SUI_DIGEST.test(digest)) {
        throw new ApiError("invalid_request", "tx must be a Sui transaction digest.");
      }
      if (!StrKey.isValidEd25519PublicKey(payer)) {
        throw new ApiError(
          "invalid_request",
          "payer must be the Stellar account (G...) that pays the fee.",
        );
      }
      // The payer is the transaction's source, so it has to exist (and hold XLM for the fee).
      if (!(await upstream("The payer's Stellar account", () => b.stellarAccount(payer))).exists) {
        throw new ApiError(
          "invalid_request",
          "payer's Stellar account does not exist yet. It needs XLM to pay the fee.",
        );
      }
      const plan = await upstream("Circle's record of this burn", () => b.suiClaim(digest, payer));
      if (!plan.ok) {
        if (plan.delivered)
          throw new ApiError("already_delivered", "This transfer has already been delivered.");
        throw new ApiError(
          /attested/.test(plan.reason) ? "not_ready" : "transaction_rejected",
          plan.reason,
        );
      }
      return {
        steps: [
          {
            id: "claim",
            chain: "stellar",
            description: "Mint the USDC on Stellar and pay it to the recipient the burn names.",
            tx: {
              kind: "stellar",
              xdr: plan.xdr,
              networkPassphrase: b.stellarWrapper?.networkPassphrase ?? "",
            },
            expiresAt: null,
          },
        ],
      };
    }

    const onSolana = r.chain === "solana";
    const tx = onSolana ? r.tx.trim() : r.tx.trim().toLowerCase();
    const kind =
      r.chain === "stellar" ? /^[0-9a-f]{64}$/ : onSolana ? SOLANA_SIGNATURE : /^0x[0-9a-f]{64}$/;
    if (!kind.test(tx)) {
      throw new ApiError(
        "invalid_request",
        r.chain === "stellar"
          ? "tx must be 64 hex characters, without 0x."
          : onSolana
            ? "tx must be a Solana transaction signature."
            : "tx must be 0x followed by 64 hex characters.",
      );
    }
    const srcDomain =
      r.chain === "stellar"
        ? STELLAR_CCTP_DOMAIN
        : onSolana
          ? SOLANA_DOMAIN
          : EVM_CHAINS[r.chain as EvmChainId].cctpDomainId;
    const att = await upstream("Circle's record of this burn", () => b.attestation(tx, srcDomain));
    if (!att || att.status === "unknown") {
      throw new ApiError(
        "upstream_unavailable",
        `Circle's record of this burn could not be read just now${typeof att?.reason === "string" ? ` (${att.reason})` : ""}. Try again shortly.`,
      );
    }
    if (att.status !== "complete") {
      throw new ApiError(
        "not_ready",
        "Circle has not attested this burn yet. Try again in a few minutes.",
      );
    }
    const message = String(att.message) as `0x${string}`;
    const attestation = String(att.attestation) as `0x${string}`;
    const destinationDomain = Number(att.destinationDomain);

    // A Solana burn into Stellar: the forwarder's mint, paid for by the payer's Stellar account.
    if (onSolana && destinationDomain === STELLAR_CCTP_DOMAIN) {
      if (!b.solanaStellarClaim) {
        throw new ApiError("route_unavailable", "Claims into Stellar are not configured here.");
      }
      if (!StrKey.isValidEd25519PublicKey(payer)) {
        throw new ApiError(
          "invalid_request",
          "payer must be the Stellar account (G...) that pays the fee.",
        );
      }
      if (!(await upstream("The payer's Stellar account", () => b.stellarAccount(payer))).exists) {
        throw new ApiError(
          "invalid_request",
          "payer's Stellar account does not exist yet. It needs XLM to pay the fee.",
        );
      }
      const claimStellar = b.solanaStellarClaim;
      const plan = await upstream("Circle's record of this burn", () => claimStellar(tx, payer));
      if (!plan.ok) {
        if (plan.delivered)
          throw new ApiError("already_delivered", "This transfer has already been delivered.");
        throw new ApiError("transaction_rejected", plan.reason);
      }
      return {
        steps: [
          {
            id: "claim",
            chain: "stellar",
            description: "Mint the USDC on Stellar and pay it to the recipient the burn names.",
            tx: {
              kind: "stellar",
              xdr: plan.xdr,
              networkPassphrase: b.stellarWrapper?.networkPassphrase ?? "",
            },
            expiresAt: null,
          },
        ],
      };
    }

    const evm = evmChainForDomain(destinationDomain);
    if (evm) {
      if (!checkAddressOn(evm, payer).ok) {
        throw new ApiError(
          "invalid_request",
          `payer must be the ${evm.name} address that pays the gas.`,
        );
      }
      const check = await upstream(`${evm.name}'s RPC`, () =>
        b.evmClaimCheck(evm, payer, message, attestation),
      );
      if (check.state === "delivered") {
        throw new ApiError("already_delivered", "This transfer has already been delivered.");
      }
      if (check.state === "expired") {
        throw new ApiError(
          "transaction_rejected",
          "Circle's signature on this Fast transfer has expired. Open the claim page to have it signed again.",
        );
      }
      if (check.state === "refused") {
        throw new ApiError(
          "transaction_rejected",
          `${evm.name} would reject this mint: ${check.reason}`,
        );
      }
      return {
        steps: [
          {
            id: "claim",
            chain: evm.id,
            description: `Mint the USDC on ${evm.name} to the recipient the burn names.`,
            tx: {
              kind: "evm",
              chainId: evm.chainId,
              to: evm.messageTransmitterAddress as `0x${string}`,
              data: encodeReceiveMessage(message, attestation),
              value: "0",
            },
            expiresAt: null,
          },
        ],
      };
    }

    if (destinationDomain === stellarDestination("solana").domain) {
      if (!checkSolanaAddress(payer).ok) {
        throw new ApiError("invalid_request", "payer must be the Solana wallet that pays the fee.");
      }
      const prep = await upstream("Solana's RPC", () =>
        b.solanaClaim({
          message,
          attestation,
          usdcMint: String(att.usdcMint),
          sourceDomainId: Number(att.sourceDomainId),
          payer,
          ...(r.recipientOwner ? { recipientOwner: r.recipientOwner.trim() } : {}),
        }),
      );
      if (prep.state === "delivered") {
        throw new ApiError("already_delivered", "This transfer has already been delivered.");
      }
      if (prep.state === "needs-owner") {
        throw new ApiError("invalid_request", `Claiming needs recipientOwner: ${prep.reason}.`, {
          needs: "recipientOwner",
        });
      }
      const steps: TransferStep[] = [];
      if (prep.setup) {
        steps.push({
          id: "open_account",
          chain: "solana",
          description:
            "Open the recipient's USDC account on Solana (about 0.002 SOL that cannot be reclaimed). Confirm it before the next step.",
          tx: { kind: "solana", transaction: prep.setup },
          expiresAt: null,
        });
      }
      steps.push({
        id: "claim",
        chain: "solana",
        description: "Mint the USDC on Solana into the recipient's USDC account.",
        tx: { kind: "solana", transaction: prep.mint },
        expiresAt: null,
      });
      return { steps };
    }

    throw new ApiError(
      "invalid_request",
      "This burn's destination cannot be claimed through the API.",
    );
  }

  return {
    routes,
    checkRoute,
    quoteOptions,
    quote,
    buildTransfer,
    buildClaim,
    solanaOpensAccount,
    transferStatus,
    SOURCE_NAME,
    DEST_NAME,
  };
}

export type Service = ReturnType<typeof createService>;
