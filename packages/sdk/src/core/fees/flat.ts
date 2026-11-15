/**
 * Xebra's flat fee on routes that run without a Xebra contract, paid as its own USDC transfer to
 * Xebra's fee address on the source chain, alongside the burn. Set by the destination:
 *
 *   - **deliver** (0.10 USDC): the transfer arrives by itself, minted by Circle's Forwarding Service
 *     or, into Stellar, by Xebra's relayer.
 *   - **claim** (0.05 USDC): Circle does not deliver there; the recipient finishes it at `/claim`.
 *
 * The Arc and Stellar contracts take their own fee and are not priced here.
 * All amounts are 6-decimal USDC units.
 */

export const XEBRA_FLAT_FEE = {
  deliver: 100_000n,
  claim: 50_000n,
} as const;

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

/** Xebra's flat fee for a transfer into `destinationDomain`, in 6-decimal units. */
export function flatFeeFor(destinationDomain: number): bigint {
  return XEBRA_FLAT_FEE[flatFeeKind(destinationDomain)];
}
