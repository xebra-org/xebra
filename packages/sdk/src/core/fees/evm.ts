import { formatUsdc6 } from "../amounts.js";

/**
 * Choosing the `maxFee` an EVM transfer signs, and refusing the ones it should not.
 *
 * On the Stellar route the wrapper contract bounds this number: a per-destination cap, and a tenth
 * of the burn. On the routes that call Circle directly nothing on chain does, and Circle keeps the
 * whole `maxFee` whatever delivery really cost (measured on Stellar; assumed here until a transfer
 * shows otherwise). So the same two bounds are applied in this file, before anyone is asked to
 * sign, and they are the only place they exist.
 *
 * The fee has two parts:
 *
 *   - **delivery**: Circle's `high` forwarding quote at 1.0x, the rule that has held on mainnet
 *     (`packages/sdk/src/core/fees/stellar.ts`). Headroom above it is pure cost, because none of it comes back.
 *   - **speed**: Circle's Fast Transfer fee, a fraction of the amount, zero for Standard. Rounded
 *     up to a whole unit so the fee signed is never a unit short of the fee owed.
 *
 * All amounts are 6-decimal USDC units, the unit Circle quotes in.
 */

/** One speed of Circle's quote, as `/api/circle-health` returns it. */
export interface FeeTier {
  finalityThreshold: 1000 | 2000;
  /** Circle's `high` delivery fee, in 6-decimal units. */
  high: number;
  /** Circle's transfer fee, in parts per billion of the amount. */
  minimumFeePpb: number;
}

export interface FeeDestination {
  name: string;
  /** The most Circle may be paid to deliver into this chain, in 6-decimal units. */
  maxForwardFeeUnits: number;
}

export type FeePlan =
  | {
      ok: true;
      /** What the burn signs: everything Circle may keep. */
      maxFee: bigint;
      deliveryFee: bigint;
      speedFee: bigint;
      /** What Xebra keeps: zero on a direct route, the wrapper's take through it. */
      xebraFee: bigint;
      /** Everything the sender pays besides what the recipient gets. */
      fee: bigint;
      /** What the recipient is minted. */
      received: bigint;
    }
  | {
      ok: false;
      /**
       * `amount`: nothing to price yet. `minimum` / `maximum`: this amount does not fit the route,
       * which belongs under the amount field. `cap`: Circle's quote is one we will not sign, or the
       * wrapper will not send, which is about the route and not about anything the person typed.
       */
      kind: "amount" | "minimum" | "maximum" | "cap";
      reason: string;
    };

const PPB = 1_000_000_000n;
/** Fees may be at most this fraction of what is burned: one tenth, the wrapper's own rule. */
const FEE_FRACTION_DENOM = 10n;

/** Circle's Fast Transfer fee for `amount`, rounded up to a whole unit. */
export function speedFeeFor(amount: bigint, minimumFeePpb: number): bigint {
  if (minimumFeePpb <= 0) return 0n;
  return (amount * BigInt(minimumFeePpb) + PPB - 1n) / PPB;
}

function feesFor(amount: bigint, tier: FeeTier): { deliveryFee: bigint; speedFee: bigint } {
  return { deliveryFee: BigInt(tier.high), speedFee: speedFeeFor(amount, tier.minimumFeePpb) };
}

function withinTenth(amount: bigint, tier: FeeTier): boolean {
  const { deliveryFee, speedFee } = feesFor(amount, tier);
  const maxFee = deliveryFee + speedFee;
  return amount > maxFee && maxFee <= amount / FEE_FRACTION_DENOM;
}

/**
 * The smallest amount whose fees are at most a tenth of it. Found by search over the exact check,
 * as `minimumForwardedAmount` is, so the figure shown can never disagree with the rule applied.
 */
export function minimumEvmAmount(tier: FeeTier): bigint {
  return smallestPassing((amount) => withinTenth(amount, tier));
}

/** The smallest amount `passes`, given that every larger one passes too. */
function smallestPassing(passes: (amount: bigint) => boolean): bigint {
  let lo = 1n;
  let hi = 100_000_000_000n; // 100,000 USDC: far above any fee this bound could need
  if (!passes(hi)) return hi;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (passes(mid)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/** A figure to show a person: the minimum plus 5% for the fee moving, rounded up to the next cent. */
export function suggestedEvmMinimum(minimum: bigint): bigint {
  const withMargin = (minimum * 105n) / 100n;
  const cent = 10_000n;
  return ((withMargin + cent - 1n) / cent) * cent;
}

export function planEvmFee(input: {
  amount: bigint;
  tier: FeeTier;
  destination: FeeDestination;
}): FeePlan {
  const { amount, tier, destination } = input;
  if (amount <= 0n) return { ok: false, kind: "amount", reason: "Enter an amount to send." };
  if (!Number.isSafeInteger(tier.high) || tier.high <= 0) {
    return {
      ok: false,
      kind: "cap",
      reason: "Circle's delivery fee could not be read. Try again shortly.",
    };
  }

  const { deliveryFee, speedFee } = feesFor(amount, tier);
  const cap = BigInt(destination.maxForwardFeeUnits);
  if (deliveryFee > cap) {
    return {
      ok: false,
      kind: "cap",
      reason: `Circle's delivery fee (${formatUsdc6(deliveryFee)} USDC) is above the limit we allow for ${destination.name} right now (${formatUsdc6(cap)} USDC). Try again shortly.`,
    };
  }

  const maxFee = deliveryFee + speedFee;
  if (!withinTenth(amount, tier)) {
    const minimum = suggestedEvmMinimum(minimumEvmAmount(tier));
    return {
      ok: false,
      kind: "minimum",
      reason: `Fees would take more than a tenth of this transfer. Send at least ${formatUsdc6(minimum)} USDC to ${destination.name}.`,
    };
  }
  return {
    ok: true,
    maxFee,
    deliveryFee,
    speedFee,
    xebraFee: 0n,
    fee: maxFee,
    received: amount - maxFee,
  };
}

/**
 * The wrapper's settings that price a transfer through it, read from the contract
 * (`lib/evm-wrapper.ts`): they change through its 48-hour timelock, so they are never pinned here.
 */
export interface WrapperTerms {
  paused: boolean;
  feeBps: number;
  minFee: bigint;
  minTransfer: bigint;
  maxTransfer: bigint;
  maxFastFeeBps: number;
  /** The destination's caps on the wrapper, or null when it does not send there. */
  domain: {
    maxForwardFee: bigint;
    accountCreation: boolean;
    maxForwardFeeNewAccount: bigint;
  } | null;
}

/**
 * The wrapper's split, exactly as `XebraCctpWrapper.computeSplit` makes it: the fee is the larger of
 * Xebra's (percentage, or the floor) and Circle's, Circle's is paid out of it, and the recipient gets
 * the amount less the fee. Null where the contract would refuse it because nothing would arrive.
 */
export function wrapperSplit(
  amount: bigint,
  maxFee: bigint,
  terms: Pick<WrapperTerms, "feeBps" | "minFee">,
): { fee: bigint; xebraFee: bigint; netBurned: bigint } | null {
  const pct = (amount * BigInt(terms.feeBps)) / 10_000n;
  const base = pct > terms.minFee ? pct : terms.minFee;
  const fee = base > maxFee ? base : maxFee;
  if (fee >= amount) return null;
  const xebraFee = fee - maxFee;
  const netBurned = amount - xebraFee;
  return netBurned > maxFee ? { fee, xebraFee, netBurned } : null;
}

/**
 * `planEvmFee` for a transfer through Xebra's wrapper. Every bound the contract enforces is applied
 * here first, so a wallet is never asked to sign what the contract would refuse: its pause, the
 * destination being on its list, its transfer range, its per-destination cap (with the Fast
 * allowance), and Circle's fee at most a tenth of what is burned. The chain table's own ceiling still
 * applies on top, as it does on a direct route.
 */
export function planWrapperFee(input: {
  amount: bigint;
  tier: FeeTier;
  destination: FeeDestination;
  terms: WrapperTerms;
  /** Circle is to open the recipient's Solana USDC account. */
  opensAccount: boolean;
  /** The chain the transfer leaves from, for sentences. */
  sourceName: string;
}): FeePlan {
  const { amount, tier, destination, terms, opensAccount, sourceName } = input;
  if (amount <= 0n) return { ok: false, kind: "amount", reason: "Enter an amount to send." };
  if (terms.paused) {
    return {
      ok: false,
      kind: "cap",
      reason: `Xebra has paused transfers from ${sourceName}. Nothing can be sent until they resume.`,
    };
  }
  const domain = terms.domain;
  if (!domain) {
    return {
      ok: false,
      kind: "cap",
      reason: `Xebra's contract on ${sourceName} does not send to ${destination.name} yet.`,
    };
  }
  if (opensAccount && !domain.accountCreation) {
    return {
      ok: false,
      kind: "cap",
      reason: `Xebra's contract cannot have Circle open a USDC account on ${destination.name} right now. Send to a wallet that already holds USDC there.`,
    };
  }
  if (!Number.isSafeInteger(tier.high) || tier.high <= 0) {
    return {
      ok: false,
      kind: "cap",
      reason: "Circle's delivery fee could not be read. Try again shortly.",
    };
  }

  const { deliveryFee, speedFee } = feesFor(amount, tier);
  const tableCap = BigInt(destination.maxForwardFeeUnits);
  if (deliveryFee > tableCap) {
    return {
      ok: false,
      kind: "cap",
      reason: `Circle's delivery fee (${formatUsdc6(deliveryFee)} USDC) is above the limit we allow for ${destination.name} right now (${formatUsdc6(tableCap)} USDC). Try again shortly.`,
    };
  }
  if (amount > terms.maxTransfer) {
    return {
      ok: false,
      kind: "maximum",
      reason: `Xebra sends at most ${formatUsdc6(terms.maxTransfer)} USDC per transfer for now.`,
    };
  }

  const fits = (a: bigint): boolean => {
    if (a < terms.minTransfer) return false;
    const { deliveryFee: d, speedFee: s } = feesFor(a, tier);
    const split = wrapperSplit(a, d + s, terms);
    return split !== null && d + s <= split.netBurned / FEE_FRACTION_DENOM;
  };
  const maxFee = deliveryFee + speedFee;
  const split = wrapperSplit(amount, maxFee, terms);
  if (!fits(amount) || split === null) {
    const minimum = suggestedEvmMinimum(smallestPassing(fits));
    return {
      ok: false,
      kind: "minimum",
      reason: `Send at least ${formatUsdc6(minimum)} USDC to ${destination.name}: below that, fees would take more than a tenth of the transfer.`,
    };
  }

  const cap = opensAccount ? domain.maxForwardFeeNewAccount : domain.maxForwardFee;
  const fastAllowance =
    tier.finalityThreshold === 1000
      ? (split.netBurned * BigInt(terms.maxFastFeeBps) + 9_999n) / 10_000n
      : 0n;
  if (maxFee > cap + fastAllowance) {
    return {
      ok: false,
      kind: "cap",
      reason: `Circle's fee (${formatUsdc6(maxFee)} USDC) is above what Xebra's contract allows for ${destination.name} right now (${formatUsdc6(cap + fastAllowance)} USDC). Try again shortly.`,
    };
  }

  return {
    ok: true,
    maxFee,
    deliveryFee,
    speedFee,
    xebraFee: split.xebraFee,
    fee: split.fee,
    received: amount - split.fee,
  };
}
