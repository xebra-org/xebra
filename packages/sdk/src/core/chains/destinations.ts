import { checkAddressOn } from "../addresses/evm.js";
import { type AddressCheck, checkSolanaAddress } from "../addresses/solana.js";
import {
  EVM_CHAINS,
  type EvmChain,
  type EvmChainId,
  type EvmPeerId,
  explorerTxUrl,
} from "./evm.js";

/**
 * Where a transfer from Stellar can land: Solana, or any EVM chain in the table, Arc included.
 * (A transfer from an EVM chain has its own: `lib/route-destination.ts`.)
 *
 * The domain ids are Circle's and never change (`packages/network-config` pins and tests them);
 * they are literals here for the reason `lib/env.ts` gives — the browser bundle should not
 * import the whole preset table to learn a few integers.
 *
 * Everything that differs by destination is answered here, once, so the Stellar form asks
 * `stellarDestination(id)` instead of branching on a chain name in a dozen places.
 */
export type DestinationId = "solana" | EvmChainId;

/** Stellar's CCTP domain: the source of every transfer this file describes. */
export const STELLAR_CCTP_DOMAIN = 27;

export interface Destination {
  id: DestinationId;
  name: string;
  /** Circle's CCTP domain id. */
  domain: number;
  /** Label for the recipient field. */
  addressLabel: string;
  addressPlaceholder: string;
  checkAddress(input: string): AddressCheck;
  /** Only Solana: a wallet must be resolved to its USDC token account before the burn. */
  needsAccountResolution: boolean;
  explorerTxUrl(hash: string): string;
  /** What the person who claims by hand pays, said plainly. */
  claimCost: string;
  /** The chain's row, for an EVM destination; null for Solana. */
  evm: EvmChain | null;
}

const SOLANA: Destination = {
  id: "solana",
  name: "Solana",
  domain: 5,
  addressLabel: "Solana address",
  addressPlaceholder: "Recipient wallet",
  checkAddress: checkSolanaAddress,
  needsAccountResolution: true,
  explorerTxUrl: (hash) => `https://solscan.io/tx/${hash}`,
  claimCost: "roughly 0.001 SOL",
  evm: null,
};

export function stellarDestination(id: DestinationId): Destination {
  if (id === "solana") return SOLANA;
  const chain = EVM_CHAINS[id];
  return {
    id,
    name: chain.name,
    domain: chain.cctpDomainId,
    addressLabel: `${chain.name} address`,
    addressPlaceholder: "0x…",
    checkAddress: (input) => checkAddressOn(chain, input),
    needsAccountResolution: false,
    explorerTxUrl: (hash) => explorerTxUrl(chain, hash),
    claimCost: chain.claimCost,
    evm: chain,
  };
}

/**
 * Which destinations the Stellar form offers.
 *
 *   - Solana, always.
 *   - Arc, once `NEXT_PUBLIC_ARC_ENABLED` is on. It was the second route and keeps its own switch.
 *   - Each other EVM chain the build names (`NEXT_PUBLIC_STELLAR_SENDS_TO`) *and* the wrapper has
 *     committed. The second half is read from the contract, so a chain appears the moment its
 *     48-hour proposal is committed, and never before: offering a domain the contract refuses would
 *     invite someone to sign a transfer that fails. While the list is unknown (`committed` null) no
 *     such chain is offered.
 */
export function stellarDestinations(input: {
  arcEnabled: boolean;
  sendsTo: readonly EvmPeerId[];
  committed: ReadonlySet<number> | null;
}): Destination[] {
  const { arcEnabled, sendsTo, committed } = input;
  const others = sendsTo.map(stellarDestination).filter((d) => committed?.has(d.domain) === true);
  return [SOLANA, ...(arcEnabled ? [stellarDestination("arc")] : []), ...others];
}
