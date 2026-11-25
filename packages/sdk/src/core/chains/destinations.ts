import { checkAddressOn } from "../addresses/evm.js";
import { type AddressCheck, checkSolanaAddress } from "../addresses/solana.js";
import { checkSuiAddress } from "../addresses/sui.js";
import {
  EVM_CHAINS,
  type EvmChain,
  type EvmChainId,
  type EvmPeerId,
  explorerTxUrl,
} from "./evm.js";

/**
 * Where a transfer from Stellar can land: Solana, Sui, or any EVM chain in the table, Arc included.
 * (A transfer from an EVM chain has its own: `lib/route-destination.ts`.)
 *
 * The domain ids are Circle's and never change (`packages/network-config` pins and tests them);
 * they are literals here for the reason `lib/env.ts` gives — the browser bundle should not
 * import the whole preset table to learn a few integers.
 *
 * Everything that differs by destination is answered here, once, so the Stellar form asks
 * `stellarDestination(id)` instead of branching on a chain name in a dozen places.
 */
export type DestinationId = "solana" | "sui" | EvmChainId;

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
  /** The chain's row, for an EVM destination; null for Solana and Sui. */
  evm: EvmChain | null;
  /**
   * Circle does not deliver here, so every transfer ends with the recipient (or anyone) submitting
   * the mint at `/claim`. Only Sui: Iris refuses a forward quote from Stellar to domain 8.
   */
  claimOnly: boolean;
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
  claimOnly: false,
};

const SUI: Destination = {
  id: "sui",
  name: "Sui",
  domain: 8,
  addressLabel: "Sui address",
  addressPlaceholder: "0x… (64 hex characters)",
  checkAddress: checkSuiAddress,
  needsAccountResolution: false,
  explorerTxUrl: (hash) => `https://suiscan.xyz/mainnet/tx/${hash}`,
  claimCost: "usually under 0.01 SUI",
  evm: null,
  claimOnly: true,
};

/** A destination Circle delivers to: every one but Sui. What callers that never ask for Sui get. */
export type DeliveredDestination = Destination & { id: Exclude<DestinationId, "sui"> };

export function stellarDestination(id: Exclude<DestinationId, "sui">): DeliveredDestination;
export function stellarDestination(id: DestinationId): Destination;
export function stellarDestination(id: DestinationId): Destination {
  if (id === "solana") return SOLANA;
  if (id === "sui") return SUI;
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
    claimOnly: false,
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
 *   - Sui, when the caller asks (`sui`, the web form's `NEXT_PUBLIC_STELLAR_TO_SUI`) *and* the wrapper
 *     has committed domain 8. Claimed at `/claim`, never delivered, so callers that only know the
 *     forwarded path (the `/v1` API, the route pages) leave it off.
 */
interface DestinationsInput {
  arcEnabled: boolean;
  sendsTo: readonly EvmPeerId[];
  committed: ReadonlySet<number> | null;
}

export function stellarDestinations(
  input: DestinationsInput & { sui?: false },
): DeliveredDestination[];
export function stellarDestinations(input: DestinationsInput & { sui: boolean }): Destination[];
export function stellarDestinations(input: DestinationsInput & { sui?: boolean }): Destination[] {
  const { arcEnabled, sendsTo, committed } = input;
  const others = sendsTo
    .map((id) => stellarDestination(id))
    .filter((d) => committed?.has(d.domain) === true);
  const sui = input.sui === true && committed?.has(SUI.domain) === true ? [SUI] : [];
  return [SOLANA, ...(arcEnabled ? [stellarDestination("arc")] : []), ...others, ...sui];
}
