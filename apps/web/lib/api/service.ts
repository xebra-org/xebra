import type { CircleHealth } from "@xebra/cctp-client";
import {
  EVM_CHAINS,
  type EvmChainId,
  type FeePlan,
  type FeeTier,
  STELLAR_CCTP_DOMAIN,
  chooseMaxFee,
  evmDestinationsFrom,
  evmSources,
  formatUsdc,
  formatUsdcAmount,
  forwardBoundHolds,
  isEvmChainId,
  minimumEvmAmount,
  minimumForwardedAmount,
  planEvmFee,
  stellarDestination,
  suggestedEvmMinimum,
  suggestedMinimum,
  withTableCeiling,
} from "@xebra/sdk/core";
import { feeDestination, routeDestination } from "../route-destination";
import type { Deps } from "./deps";
import { ApiError } from "./errors";

/**
 * Routes, prices and status, once, for every surface that answers them: the public API (`/v1`),
 * the MCP tools and, later, the SDK's own client. Amounts are 6-decimal USDC units throughout;
 * Stellar's 7-decimal stroops are converted here and nowhere else.
 */

export type Speed = "standard" | "fast";
export type SourceId = "stellar" | "sui" | EvmChainId;
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
const STROOPS_PER_UNIT = 10n;

const SOURCE_NAME = (id: SourceId): string =>
  id === "stellar" ? "Stellar" : id === "sui" ? "Sui" : EVM_CHAINS[id].name;
const DEST_NAME = (id: DestId): string =>
  id === "stellar" ? "Stellar" : id === "solana" ? "Solana" : EVM_CHAINS[id].name;

export function isSourceId(v: string): v is SourceId {
  return v === "stellar" || v === "sui" || isEvmChainId(v);
}
export function isDestId(v: string): v is DestId {
  return v === "stellar" || v === "solana" || isEvmChainId(v);
}

const ceilToUnits = (stroops: bigint) => (stroops + STROOPS_PER_UNIT - 1n) / STROOPS_PER_UNIT;
const floorToUnits = (stroops: bigint) => stroops / STROOPS_PER_UNIT;

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

  async function circleFor(from: SourceId, to: DestId): Promise<CircleHealth> {
    const src =
      from === "stellar" ? STELLAR_CCTP_DOMAIN : EVM_CHAINS[from as EvmChainId].cctpDomainId;
    const dst =
      to === "solana"
        ? stellarDestination("solana").domain
        : EVM_CHAINS[to as EvmChainId].cctpDomainId;
    const health = await deps.circle(src, dst);
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
      needsAccount: false,
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
  ): QuoteOption {
    const dest = routeDestination(to as Exclude<DestId, "stellar">);
    const plan = planEvmFee({ amount: units, tier, destination: feeDestination(dest, false) });
    if (!plan.ok) {
      const minimum = suggestedEvmMinimum(minimumEvmAmount(tier));
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
            minimum: suggestedEvmMinimum(minimumEvmAmount(tier)),
            maximum: null,
          },
          health,
        ),
        stellar: null,
        evm: plan,
      },
    };
  }

  /**
   * Every speed the route offers, each priced or refused with its reason. Throws only for what
   * stops the route as a whole (not offered, Circle unreadable or down, contract unreadable).
   */
  async function quoteOptions(q: {
    from: SourceId;
    to: DestId;
    amount: bigint;
  }): Promise<{ health: CircleHealth | null; options: QuoteOption[] }> {
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

    const health = await circleFor(q.from, q.to);
    if (q.from === "stellar") {
      return { health, options: [await stellarOption(q.to, q.amount, health)] };
    }
    const from = q.from;
    const tiers: Array<[Speed, FeeTier | null]> = [
      ["standard", health.tiers.standard],
      ["fast", EVM_CHAINS[from].fast ? health.tiers.fast : null],
    ];
    const options = tiers
      .filter((t): t is [Speed, FeeTier] => t[1] !== null)
      .map(([speed, tier]) => evmOption(from, q.to, q.amount, speed, tier, health));
    return { health, options };
  }

  /** One speed's price, or the reason it cannot be priced. */
  async function quote(q: {
    from: SourceId;
    to: DestId;
    amount: bigint;
    speed?: Speed;
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
    if (r.chain === "sui") {
      throw new ApiError("invalid_request", "Sui transfers are tracked on the Sui page for now.");
    }
    const tx = r.tx.trim().toLowerCase();
    const kind = r.chain === "stellar" ? /^[0-9a-f]{64}$/ : /^0x[0-9a-f]{64}$/;
    if (!kind.test(tx)) {
      throw new ApiError(
        "invalid_request",
        r.chain === "stellar"
          ? "tx must be 64 hex characters, without 0x."
          : "tx must be 0x followed by 64 hex characters.",
      );
    }
    const domain = r.chain === "stellar" ? STELLAR_CCTP_DOMAIN : EVM_CHAINS[r.chain].cctpDomainId;
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

  return { routes, checkRoute, quoteOptions, quote, transferStatus, SOURCE_NAME, DEST_NAME };
}

export type Service = ReturnType<typeof createService>;
