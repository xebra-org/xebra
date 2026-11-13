import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type { Connection, WalletEntry } from "./types";

/**
 * Sui wallet discovery and signing through the Wallet Standard, the same mechanism as the Solana
 * wallets in `solana.ts`: wallets register themselves, so nothing here lists them by name.
 *
 * The server builds the transaction and the wallet signs and submits it. The page needs no Sui RPC
 * of its own and no Sui SDK in the browser bundle.
 */

const CONNECT = "standard:connect";
const SIGN_AND_EXECUTE = "sui:signAndExecuteTransaction";
export const SUI_MAINNET = "sui:mainnet";

export interface SuiWalletEntry {
  name: string;
  icon: string | null;
  wallet: Wallet;
}

/** A Sui wallet is one that speaks a `sui:` chain, can connect, and can sign-and-execute. Pure. */
export function isSuiWallet(w: Pick<Wallet, "chains" | "features">): boolean {
  const has = (f: string) => Object.prototype.hasOwnProperty.call(w.features, f);
  return w.chains.some((c) => c.startsWith("sui:")) && has(CONNECT) && has(SIGN_AND_EXECUTE);
}

export function suiEntries(wallets: readonly Wallet[]): SuiWalletEntry[] {
  return wallets
    .filter(isSuiWallet)
    .map((wallet) => ({
      name: wallet.name,
      icon: /^(data:image\/|https:\/\/)/.test(wallet.icon) ? wallet.icon : null,
      wallet,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Sui wallets as the wallet modal lists them, keyed `sui:<name>`. Pure. */
export function suiModalEntries(wallets: readonly SuiWalletEntry[]): WalletEntry[] {
  return wallets.map((w) => ({
    key: `sui:${w.name}`,
    family: "sui" as const,
    name: w.name,
    icon: w.icon,
    installed: true,
  }));
}

/** The first account usable on Sui mainnet. Pure. */
export function pickSuiAccount(accounts: readonly WalletAccount[]): WalletAccount | null {
  return (
    accounts.find((a) => a.chains.includes(SUI_MAINNET)) ??
    accounts.find((a) => a.chains.some((c) => c.startsWith("sui:"))) ??
    null
  );
}

export function watchSuiWallets(onChange: (w: SuiWalletEntry[]) => void): () => void {
  const registry = getWallets();
  const emit = () => onChange(suiEntries([...registry.get()]));
  emit();
  const offA = registry.on("register", emit);
  const offB = registry.on("unregister", emit);
  return () => {
    offA();
    offB();
  };
}

type ConnectFeature = {
  connect(): Promise<{ accounts: readonly WalletAccount[] }>;
};

export async function connectSui(entry: SuiWalletEntry): Promise<WalletAccount> {
  const feature = entry.wallet.features[CONNECT] as ConnectFeature | undefined;
  if (!feature) throw new Error(`${entry.name} cannot connect.`);
  const { accounts } = await feature.connect();
  const account = pickSuiAccount(accounts.length ? accounts : entry.wallet.accounts);
  if (!account) throw new Error(`${entry.name} did not share a Sui account.`);
  return account;
}

/**
 * Connects a wallet chosen in the wallet modal. The account is returned alongside the connection,
 * because signing needs the Wallet Standard account, not only its address.
 */
export async function connectSuiFromModal(
  entry: WalletEntry,
  wallet: SuiWalletEntry,
): Promise<{ connection: Connection; account: WalletAccount }> {
  const account = await connectSui(wallet);
  return {
    account,
    connection: {
      family: "sui",
      walletKey: entry.key,
      walletName: entry.name,
      address: account.address,
    },
  };
}

/** Asks the wallet to forget this site, where it supports that. Never throws. */
export async function disconnectSui(wallet: SuiWalletEntry): Promise<void> {
  const off = wallet.wallet.features["standard:disconnect"] as
    | { disconnect(): Promise<void> }
    | undefined;
  await off?.disconnect().catch(() => undefined);
}

type SignAndExecuteFeature = {
  signAndExecuteTransaction(input: {
    transaction: { toJSON(): Promise<string> };
    account: WalletAccount;
    chain: string;
  }): Promise<{ digest: string }>;
};

/**
 * Hands the wallet the transaction the server built and returns the digest once it has executed.
 * The wallet shows its own confirmation; declining throws, which the page reports as a plain
 * "cancelled".
 */
export async function signAndExecuteSui(
  entry: SuiWalletEntry,
  account: WalletAccount,
  transactionJson: string,
): Promise<string> {
  const feature = entry.wallet.features[SIGN_AND_EXECUTE] as SignAndExecuteFeature | undefined;
  if (!feature) throw new Error(`${entry.name} cannot send transactions.`);
  const result = await feature.signAndExecuteTransaction({
    transaction: { toJSON: async () => transactionJson },
    account,
    chain: SUI_MAINNET,
  });
  return result.digest;
}
