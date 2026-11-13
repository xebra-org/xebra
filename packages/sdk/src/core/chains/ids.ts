import { EVM_CHAIN_IDS, type EvmChainId, isEvmChainId } from "./evm.js";

/** Every chain a transfer can start or end on, as the public API names it. */
export type ChainId = "stellar" | "solana" | "sui" | "aptos" | EvmChainId;

const NON_EVM = ["stellar", "solana", "sui", "aptos"] as const;

export const CHAIN_IDS: readonly ChainId[] = [...NON_EVM, ...EVM_CHAIN_IDS];

/**
 * Exact match only. Callers lower-case and trim what a person typed before asking, so a typo is
 * refused here instead of being guessed at.
 */
export function isChainId(value: string): value is ChainId {
  return (NON_EVM as readonly string[]).includes(value) || isEvmChainId(value);
}
