/**
 * One vocabulary for four wallet ecosystems.
 *
 * Stellar, Solana, EVM and Aptos wallets discover, connect and sign in unrelated ways, but the interface
 * only needs a few facts about each: what to list, whether it is installed, and — once connected —
 * whose address it is. Everything chain-specific stays behind `connect`.
 */
export type Family = "stellar" | "solana" | "evm" | "aptos";

export const FAMILIES: readonly Family[] = ["stellar", "solana", "evm", "aptos"];

export const FAMILY_LABEL: Record<Family, string> = {
  stellar: "Stellar",
  solana: "Solana",
  evm: "EVM",
  aptos: "Aptos",
};

export interface WalletEntry {
  /** Unique across families: `evm:io.metamask`, `solana:Phantom`, `stellar:freighter`, `aptos:Petra`. */
  key: string;
  family: Family;
  name: string;
  /** A data: or https: URL, or null when the wallet advertises none. */
  icon: string | null;
  installed: boolean;
  /** Where to get it when it is not installed. */
  installUrl?: string | undefined;
}

/** EIP-1193, the only part of an EVM provider this app relies on. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export interface Connection {
  family: Family;
  walletKey: string;
  walletName: string;
  address: string;
  /** EVM only: the provider the address came from, for signing and network switching. */
  provider?: Eip1193Provider;
  /**
   * EVM only: the network the wallet is on, kept current from its `chainChanged` events.
   * Undefined when the wallet would not say. Circle's contracts have the same addresses on every
   * chain, so nothing may be read or sent until this matches the chain a transfer starts on.
   */
  chainId?: number | undefined;
}
