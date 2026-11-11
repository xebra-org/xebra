/**
 * Choosing the `max_fee` a transfer signs, from Circle's forward-fee quote.
 *
 * With Circle's Forwarding Service the `max_fee` on the burn *is* the delivery fee: Circle charges the
 * whole of it, gas and service together, and keeps any excess as a priority fee with no refund. So it
 * is neither a ceiling to pad nor a number to guess. The rule used here is the one that held on
 * mainnet: Circle's `high` tier at 1.0x. `low` is stable but has not been proven to be accepted;
 * `med` and `high` drift a few percent over minutes, and 1.0x of `high` still landed twice when the
 * quote had moved 7 to 9 percent between the check and the send.
 *
 * The contract bounds the result anyway (a per-domain cap, and a tenth of the burn), so a wrong
 * choice here can fail a transfer before signing but cannot overcharge one. This module exists so
 * that failure reads as a sentence, and so a route the contract has switched off is refused before
 * anyone is asked to sign.
 *
 * Amounts: Circle quotes in the 6-decimal canonical unit, Stellar USDC has 7. One canonical unit is
 * ten stroops.
 */

export const STROOPS_PER_CANONICAL_UNIT = 10n;

export interface ForwardQuoteUnits {
  low: number;
  med: number;
  high: number;
}

/** A destination's forwarding switches and caps, as `get_domains` returns them (stroops). */
export interface DomainForwardConfig {
  forward: boolean;
  maxForwardFee: bigint;
  accountCreation: boolean;
  maxForwardFeeNewAccount: bigint;
}

export type MaxFeeChoice = { ok: true; maxFee: bigint } | { ok: false; reason: string };

/** Circle's canonical 6-decimal units to Stellar's 7-decimal stroops. */
export function unitsToStroops(units: number): bigint {
  return BigInt(units) * STROOPS_PER_CANONICAL_UNIT;
}

function usdc(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const frac = (stroops % 10_000_000n).toString().padStart(7, "0").slice(0, 4);
  return `${whole}.${frac}`;
}

export function chooseMaxFee(input: {
  quote: ForwardQuoteUnits;
  /** The recipient is a Solana wallet with no USDC account, so Circle also creates one. */
  needsAccount: boolean;
  cfg: DomainForwardConfig;
  destinationName: string;
}): MaxFeeChoice {
  const { quote, needsAccount, cfg, destinationName } = input;

  // With no relay to mint for the user, a transfer the contract would not forward is a burn nobody
  // delivers. It is refused here rather than discovered on the receipt.
  if (!cfg.forward) {
    return {
      ok: false,
      reason: `Automatic delivery to ${destinationName} is switched off right now.`,
    };
  }
  if (needsAccount && !cfg.accountCreation) {
    return {
      ok: false,
      reason:
        "This wallet has no USDC account yet, and opening one during delivery is switched off right now. Receiving any USDC there once will create it.",
    };
  }

  const maxFee = unitsToStroops(quote.high);
  const cap = needsAccount ? cfg.maxForwardFeeNewAccount : cfg.maxForwardFee;
  if (maxFee > cap) {
    return {
      ok: false,
      reason: `Circle's delivery fee (${usdc(maxFee)} USDC) is above the limit we allow for ${destinationName} right now (${usdc(cap)} USDC). Try again shortly.`,
    };
  }
  return { ok: true, maxFee };
}

/**
 * A committed domain's caps, lowered to this app's own ceiling for the chain where that is tighter.
 *
 * The contract's cap for an EVM chain is set by whoever commits it; the chain table's
 * `maxForwardFeeUnits` is the figure checked live by `pnpm check:evm`. The stricter of the two
 * applies, so neither a generous commit nor a stale table can let the page sign more than both
 * allow. Solana has no table ceiling from Stellar (`tableCeilingUnits` null): the contract's caps,
 * which differ for opening an account, stand alone.
 */
export function withTableCeiling(
  cfg: DomainForwardConfig,
  tableCeilingUnits: number | null,
): DomainForwardConfig {
  if (tableCeilingUnits === null) return cfg;
  const ceiling = unitsToStroops(tableCeilingUnits);
  return { ...cfg, maxForwardFee: cfg.maxForwardFee < ceiling ? cfg.maxForwardFee : ceiling };
}

/** The wrapper's on-chain fee parameters that decide how small a forwarded transfer can be. */
export interface FeeParams {
  feeBps: bigint;
  minFee: bigint;
}

/** Circle's delivery fee may be at most this fraction of what is burned: one tenth (`check_forward_fee`). */
const FORWARD_FEE_FRACTION_DENOM = 10n;

/**
 * Whether the contract would accept a forwarded transfer of `amount`, mirroring `compute_forward_split` and
 * `check_forward_fee` exactly: fee is the larger of our percentage, our floor and Circle's delivery fee `m`;
 * the burn is what is left after our share, floored to a whole canonical unit; and Circle's fee must be at
 * most a tenth of that burn.
 */
export function forwardBoundHolds(amount: bigint, m: bigint, p: FeeParams): boolean {
  const pct = (amount * p.feeBps) / 10_000n;
  const base = pct > p.minFee ? pct : p.minFee;
  const fee = base > m ? base : m;
  const after = amount - (fee - m);
  if (after <= 0n) return false;
  const net = after - (after % STROOPS_PER_CANONICAL_UNIT);
  return net > m && m <= net / FORWARD_FEE_FRACTION_DENOM;
}

/**
 * The smallest transfer, in stroops, the contract accepts for a given delivery fee. This is why a 1 USDC
 * transfer works to Arc (delivery about 0.02 USDC) and not to Solana (about 0.17, or 0.34 when the account
 * has to be opened): the fee cannot exceed a tenth of the burn. Found by search over the exact check rather
 * than by formula, so it cannot drift from it.
 */
export function minimumForwardedAmount(m: bigint, p: FeeParams): bigint {
  let lo = 1n;
  let hi = 100_000_000_000n; // 10,000 USDC: far above any delivery fee this bound could need
  if (!forwardBoundHolds(hi, m, p)) return hi;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (forwardBoundHolds(mid, m, p)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/** A figure to show a person: the minimum plus 5% for the fee moving, rounded up to the next cent. */
export function suggestedMinimum(minimum: bigint): bigint {
  const withMargin = (minimum * 105n) / 100n;
  const cent = 100_000n; // 0.01 USDC in stroops
  return ((withMargin + cent - 1n) / cent) * cent;
}
