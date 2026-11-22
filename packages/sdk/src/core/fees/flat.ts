/**
 * Xebra's fee on routes that run without a Xebra contract, paid as its own USDC transfer to Xebra's
 * fee address on the source chain, alongside the burn: **0.01% of the amount plus 0.01 USDC**, on
 * top of Circle's fee and gas. The same wherever the transfer goes; the kind only says how it ends:
 *
 *   - **deliver**: the transfer arrives by itself, minted by Circle's Forwarding Service or, into
 *     Stellar, by Xebra's relayer.
 *   - **claim**: Circle does not deliver there; the recipient finishes it at `/claim`.
 *
 * The Arc and Stellar contracts take their own fee and are not priced here.
 * All amounts are 6-decimal USDC units.
 */

/** The fixed part of Xebra's fee, 0.01 USDC, by kind. */
export const XEBRA_FLAT_FEE = {
  deliver: 10_000n,
  claim: 10_000n,
} as const;

/** The percentage part of Xebra's fee, in basis points of the amount: 1 is 0.01%. */
export const XEBRA_FEE_BPS = 1n;

export type FlatFeeKind = keyof typeof XEBRA_FLAT_FEE;

/**
 * CCTP domains Circle's Forwarding Service does not deliver to and Xebra has no relayer for:
 * Sui, Aptos, Starknet, Injective, Morph, Pharos (Circle's list, 2026-11-15).
 */
export const CLAIM_ONLY_DOMAINS: readonly number[] = [8, 9, 25, 29, 30, 31];

/** Whether a transfer into `destinationDomain` arrives by itself or is claimed. */
export function flatFeeKind(destinationDomain: number): FlatFeeKind {
  return CLAIM_ONLY_DOMAINS.includes(destinationDomain) ? "claim" : "deliver";
}

/**
 * Xebra's fee for sending `amount` (what leaves the wallet) into `destinationDomain`, in 6-decimal
 * units: 0.01 USDC plus 0.01% of the amount, rounded down to a whole unit. With no amount, the
 * fixed part alone.
 */
export function flatFeeFor(destinationDomain: number, amount = 0n): bigint {
  const pct = amount > 0n ? (amount * XEBRA_FEE_BPS) / 10_000n : 0n;
  return XEBRA_FLAT_FEE[flatFeeKind(destinationDomain)] + pct;
}

/**
 * The least amount to send into `destinationDomain` so that at least `burn` is left once Xebra's fee
 * is taken out of it. For minimums: `burn + 0.01` alone falls short by the 0.01% part.
 */
export function amountForBurn(destinationDomain: number, burn: bigint): bigint {
  const fixed = XEBRA_FLAT_FEE[flatFeeKind(destinationDomain)];
  let amount = ((burn + fixed) * 10_000n) / (10_000n - XEBRA_FEE_BPS);
  while (amount - flatFeeFor(destinationDomain, amount) < burn) amount += 1n;
  while (amount > 0n && amount - 1n - flatFeeFor(destinationDomain, amount - 1n) >= burn)
    amount -= 1n;
  return amount;
}
