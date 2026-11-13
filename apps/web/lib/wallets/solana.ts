import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type { Connection, WalletEntry } from "./types";

/**
 * Solana wallet discovery through the Wallet Standard, which Phantom, Solflare, Backpack and the
 * rest all implement. Wallets register themselves; nothing here knows their names in advance, so a
 * new wallet appears in the list without a release.
 *
 * Connecting takes the account's address, to fill a recipient field and to identify who is on the
 * page. Signing is for transfers that start on Solana (`sendSolanaTransaction`): the server builds
 * the burn and the wallet adds the one signature it is missing.
 */

const CONNECT = "standard:connect";

/** A wallet is usable if it speaks Solana and can connect. Pure, so it is testable with a fake. */
export function isSolanaWallet(w: Pick<Wallet, "chains" | "features">): boolean {
  return (
    w.chains.some((c) => c.startsWith("solana:")) &&
    Object.prototype.hasOwnProperty.call(w.features, CONNECT)
  );
}

export function solanaEntries(wallets: readonly Wallet[]): WalletEntry[] {
  return wallets
    .filter(isSolanaWallet)
    .map((w) => ({
      key: `solana:${w.name}`,
      family: "solana" as const,
      name: w.name,
      icon: /^(data:image\/|https:\/\/)/.test(w.icon) ? w.icon : null,
      installed: true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The first account that is on a Solana chain. Pure. */
export function pickSolanaAccount(accounts: readonly WalletAccount[]): WalletAccount | null {
  return accounts.find((a) => a.chains.some((c) => c.startsWith("solana:"))) ?? null;
}

export function watchSolanaWallets(onChange: (w: Wallet[]) => void): () => void {
  const registry = getWallets();
  const emit = () => onChange([...registry.get()]);
  emit();
  const offA = registry.on("register", emit);
  const offB = registry.on("unregister", emit);
  return () => {
    offA();
    offB();
  };
}

type ConnectFeature = {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }>;
};

export async function connectSolana(entry: WalletEntry, wallet: Wallet): Promise<Connection> {
  const feature = wallet.features[CONNECT] as ConnectFeature | undefined;
  if (!feature) throw new Error(`${wallet.name} cannot connect.`);
  const { accounts } = await feature.connect();
  const account = pickSolanaAccount(accounts.length ? accounts : wallet.accounts);
  if (!account) throw new Error(`${wallet.name} did not share a Solana account.`);
  return {
    family: "solana",
    walletKey: entry.key,
    walletName: entry.name,
    address: account.address,
  };
}

const SIGN_AND_SEND = "solana:signAndSendTransaction";
const SIGN = "solana:signTransaction";
export const SOLANA_MAINNET = "solana:mainnet";

/** Whether a wallet can sign a Solana transaction, by either Wallet Standard feature. Pure. */
export function canSignSolana(w: Pick<Wallet, "features">): boolean {
  const has = (f: string) => Object.prototype.hasOwnProperty.call(w.features, f);
  return has(SIGN_AND_SEND) || has(SIGN);
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58, as Solana writes signatures and addresses. Pure, and free of Buffer. */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += (digits[i] as number) << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i] as number];
  return out;
}

type SignAndSendFeature = {
  signAndSendTransaction(
    ...inputs: Array<{
      account: WalletAccount;
      transaction: Uint8Array;
      chain: string;
      options?: { commitment?: string; skipPreflight?: boolean };
    }>
  ): Promise<ReadonlyArray<{ signature: Uint8Array }>>;
};
type SignFeature = {
  signTransaction(
    ...inputs: Array<{
      account: WalletAccount;
      transaction: Uint8Array;
      chain?: string;
    }>
  ): Promise<ReadonlyArray<{ signedTransaction: Uint8Array }>>;
};

/**
 * Has the wallet sign a transaction the server built (already carrying any other signature it needs)
 * and gets it onto the network, returning the signature. Wallets that send for themselves are asked
 * to; the others only sign, and `send` broadcasts the signed bytes (through our RPC proxy, since
 * Solana's public RPC refuses browsers). Declining in the wallet throws.
 *
 * The returned signature is the transaction's id, not a confirmation: the caller waits for it.
 */
export async function sendSolanaTransaction(
  wallet: Wallet,
  address: string,
  transaction: Uint8Array,
  send: (signed: Uint8Array) => Promise<string>,
): Promise<string> {
  const account = wallet.accounts.find((a) => a.address === address);
  if (!account)
    throw new Error(`${wallet.name} is no longer connected to ${address}. Reconnect it.`);
  const signAndSend = wallet.features[SIGN_AND_SEND] as SignAndSendFeature | undefined;
  if (signAndSend) {
    const [result] = await signAndSend.signAndSendTransaction({
      account,
      transaction,
      chain: SOLANA_MAINNET,
      options: { commitment: "confirmed" },
    });
    if (!result) throw new Error(`${wallet.name} did not return a signature.`);
    return base58Encode(result.signature);
  }
  const sign = wallet.features[SIGN] as SignFeature | undefined;
  if (!sign) throw new Error(`${wallet.name} cannot sign Solana transactions.`);
  const [signed] = await sign.signTransaction({ account, transaction, chain: SOLANA_MAINNET });
  if (!signed) throw new Error(`${wallet.name} did not return the signed transaction.`);
  return send(signed.signedTransaction);
}
