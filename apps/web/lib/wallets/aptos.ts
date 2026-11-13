import { getWallets } from "@wallet-standard/app";
import type { Wallet } from "@wallet-standard/base";
import {
  type AptosBurnArgs,
  type AptosTxEnvelope,
  aptosBurnPayload,
  aptosBurnTransaction,
  normaliseAptosAddress,
} from "@xebra/sdk/build";
import type { Connection, WalletEntry } from "./types";

/**
 * Aptos wallet discovery and signing through AIP-62, Aptos's Wallet Standard. Petra, Nightly, OKX
 * and the rest register themselves on the same `wallet-standard` registry the Solana and Sui
 * wallets use, so nothing here lists them by name and a new wallet appears without a release.
 *
 * The server builds the burn and the wallet signs and submits it. The Aptos SDK is not in the
 * bundle (it could not be installed here); the arguments handed to the wallet are objects with the
 * SDK's shapes and serialization methods (`@xebra/sdk/build`), which is all a wallet reads, since a
 * page's copy of the SDK is never the wallet's own.
 */

const CONNECT = "aptos:connect";
const ACCOUNT = "aptos:account";
const NETWORK = "aptos:network";
const DISCONNECT = "aptos:disconnect";
const SIGN_AND_SUBMIT = "aptos:signAndSubmitTransaction";
export const APTOS_MAINNET = "aptos:mainnet";
const MAINNET_CHAIN_ID = 1;

const has = (w: Pick<Wallet, "features">, f: string) =>
  Object.prototype.hasOwnProperty.call(w.features, f);

/**
 * An Aptos wallet is one that speaks an `aptos:` chain, can connect, and can sign and submit.
 * (Signing and submitting is optional in AIP-62; a wallet without it could not send from here.)
 * Pure.
 */
export function isAptosWallet(w: Pick<Wallet, "chains" | "features">): boolean {
  return w.chains.some((c) => c.startsWith("aptos:")) && has(w, CONNECT) && has(w, SIGN_AND_SUBMIT);
}

export function aptosEntries(wallets: readonly Wallet[]): WalletEntry[] {
  return wallets
    .filter(isAptosWallet)
    .map((w) => ({
      key: `aptos:${w.name}`,
      family: "aptos" as const,
      name: w.name,
      icon: /^(data:image\/|https:\/\/)/.test(w.icon) ? w.icon : null,
      installed: true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The registered wallet a connection came from, or null if it has gone away. */
export function findAptosWallet(walletKey: string): Wallet | null {
  return (
    getWallets()
      .get()
      .find((w) => isAptosWallet(w) && `aptos:${w.name}` === walletKey) ?? null
  );
}

/**
 * An address as a wallet hands it over: the Aptos SDK's `AccountAddress` (whose `toString` is the
 * address, and whose `data` is its 32 bytes) or a plain string. Long form, lower case, or null.
 * Pure.
 */
export function readAptosAddress(v: unknown): `0x${string}` | null {
  if (typeof v === "string") return normaliseAptosAddress(v);
  if (v && typeof v === "object") {
    const data = (v as { data?: unknown }).data;
    if (data instanceof Uint8Array && data.length === 32) {
      return `0x${Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    }
    const s = String(v);
    if (s.startsWith("0x")) return normaliseAptosAddress(s);
  }
  return null;
}

/**
 * AIP-62 answers are `{ status: "Approved", args }` or `{ status: "Rejected" }`. A few wallets
 * still return the value bare; that is accepted too. A rejection throws, worded the way the pages
 * recognise a person declining.
 */
export function approved<T>(answer: unknown, what: string): T {
  if (answer && typeof answer === "object" && "status" in answer) {
    const a = answer as { status: unknown; args?: unknown };
    if (a.status === "Approved") return a.args as T;
    if (a.status === "Rejected") throw new Error(`You declined the ${what} in your wallet.`);
  }
  return answer as T;
}

type ConnectFeature = { connect(silent?: boolean): Promise<unknown> };
type AccountFeature = { account(): Promise<unknown> };
type NetworkFeature = { network(): Promise<unknown> };

export async function connectAptos(entry: WalletEntry, wallet: Wallet): Promise<Connection> {
  const feature = wallet.features[CONNECT] as ConnectFeature | undefined;
  if (!feature) throw new Error(`${wallet.name} cannot connect.`);
  const info = approved<{ address?: unknown }>(await feature.connect(), "connection");
  const address = readAptosAddress(info?.address);
  if (!address) throw new Error(`${wallet.name} did not share an Aptos account.`);
  return { family: "aptos", walletKey: entry.key, walletName: entry.name, address };
}

export async function disconnectAptos(wallet: Wallet): Promise<void> {
  const off = wallet.features[DISCONNECT] as { disconnect(): Promise<void> } | undefined;
  await off?.disconnect().catch(() => undefined);
}

/** The account the wallet would sign with now, which may not be the one it connected with. */
export async function currentAptosAccount(wallet: Wallet): Promise<`0x${string}` | null> {
  const feature = wallet.features[ACCOUNT] as AccountFeature | undefined;
  if (!feature) return null;
  try {
    return readAptosAddress(
      approved<{ address?: unknown }>(await feature.account(), "account")?.address,
    );
  } catch {
    return null;
  }
}

/**
 * Whether the wallet is on Aptos mainnet. Circle's script is compiled against the mainnet
 * packages, so on any other network it would fail; this says so before anyone signs. Null when
 * the wallet will not say.
 */
export async function aptosWalletOnMainnet(wallet: Wallet): Promise<boolean | null> {
  const feature = wallet.features[NETWORK] as NetworkFeature | undefined;
  if (!feature) return null;
  try {
    const n = approved<{ name?: unknown; chainId?: unknown }>(await feature.network(), "network");
    if (n?.chainId !== undefined) return Number(n.chainId) === MAINNET_CHAIN_ID;
    if (typeof n?.name === "string") return n.name.toLowerCase() === "mainnet";
    return null;
  } catch {
    return null;
  }
}

type SignAndSubmitFeature = {
  version?: string;
  signAndSubmitTransaction(input: unknown): Promise<unknown>;
};

/** 1.1.0 and later take a payload; 1.0.0 took a built transaction. Pure. */
export function takesPayload(version: string | undefined): boolean {
  const [major, minor] = (version ?? "1.0.0").split(".").map((n) => Number.parseInt(n, 10));
  return (major ?? 1) > 1 || ((major ?? 1) === 1 && (minor ?? 0) >= 1);
}

/**
 * Hands the wallet the burn the server built and returns the transaction hash once it has been
 * submitted. The wallet shows its own confirmation (and simulates first); declining throws, which
 * the page reports as a plain "cancelled".
 */
export async function signAndSubmitAptos(
  wallet: Wallet,
  args: AptosBurnArgs,
  envelope: AptosTxEnvelope,
): Promise<`0x${string}`> {
  const feature = wallet.features[SIGN_AND_SUBMIT] as SignAndSubmitFeature | undefined;
  if (!feature) throw new Error(`${wallet.name} cannot send transactions.`);
  const input = takesPayload(feature.version)
    ? {
        payload: aptosBurnPayload(args),
        maxGasAmount: Number(envelope.maxGasAmount),
      }
    : aptosBurnTransaction(args, envelope);
  const result = approved<{ hash?: unknown }>(
    await feature.signAndSubmitTransaction(input),
    "transaction",
  );
  const raw = typeof result?.hash === "string" ? result.hash.trim().toLowerCase() : "";
  const hash = /^[0-9a-f]{64}$/.test(raw) ? `0x${raw}` : raw;
  if (!/^0x[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`${wallet.name} did not return a transaction hash.`);
  }
  return hash as `0x${string}`;
}

export function watchAptosWallets(onChange: (w: Wallet[]) => void): () => void {
  const registry = getWallets();
  const emit = () => onChange([...registry.get()].filter(isAptosWallet));
  emit();
  const offA = registry.on("register", emit);
  const offB = registry.on("unregister", emit);
  return () => {
    offA();
    offB();
  };
}
