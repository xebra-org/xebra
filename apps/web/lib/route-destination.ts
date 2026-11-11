import {
  EVM_CHAINS,
  type EvmChain,
  type FeeDestination,
  type RouteDestinationId,
  SOLANA_FROM_ARC,
  explorerTxUrl,
  stellarDestination,
} from "@xebra/sdk/core";

/**
 * Where a transfer from an EVM chain lands, in the one shape the form and receipt need: an EVM
 * chain from the table, or Solana, which only Arc sends to on these routes.
 *
 * `evm` is null for Solana, and that is the switch everything else turns on: an EVM recipient is
 * an address, a Solana recipient is a USDC token account that may not exist yet.
 */
export interface RouteDestination {
  id: RouteDestinationId;
  name: string;
  cctpDomainId: number;
  claimCost: string;
  explorerTxUrl(hash: string): string;
  evm: EvmChain | null;
}

export function routeDestination(id: RouteDestinationId): RouteDestination {
  if (id === "solana") {
    const solana = stellarDestination("solana");
    return {
      id,
      name: solana.name,
      cctpDomainId: SOLANA_FROM_ARC.cctpDomainId,
      claimCost: solana.claimCost,
      explorerTxUrl: solana.explorerTxUrl,
      evm: null,
    };
  }
  const chain = EVM_CHAINS[id];
  return {
    id,
    name: chain.name,
    cctpDomainId: chain.cctpDomainId,
    claimCost: chain.claimCost,
    explorerTxUrl: (hash) => explorerTxUrl(chain, hash),
    evm: chain,
  };
}

/**
 * The fee ceiling that applies. Opening a Solana USDC account costs Circle about twice an ordinary
 * delivery, so it has a ceiling of its own; every other destination has one figure.
 */
export function feeDestination(dest: RouteDestination, opensAccount: boolean): FeeDestination {
  if (dest.evm) return { name: dest.name, maxForwardFeeUnits: dest.evm.maxForwardFeeUnits };
  return {
    name: dest.name,
    maxForwardFeeUnits: opensAccount
      ? SOLANA_FROM_ARC.maxForwardFeeNewAccountUnits
      : SOLANA_FROM_ARC.maxForwardFeeUnits,
  };
}
