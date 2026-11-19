import type { Eip1193Provider } from "./wallets/types";

/**
 * The handful of JSON-RPC calls an EVM transfer or claim needs, made through the user's own wallet.
 *
 * No connector framework and no client object, for the reason `lib/wallets/evm.ts` gives. What this
 * adds over calling `provider.request` in place is the part that is easy to get subtly wrong:
 *
 *   - **Which chain the wallet is really on.** Circle's contracts sit at the same addresses on
 *     every chain this app touches, so a call made on the wrong one does not fail. It reaches a
 *     real contract and returns a plausible answer about a different chain. `ensureChain` therefore
 *     re-reads the chain id after asking for a switch and refuses on a mismatch, rather than
 *     trusting that a switch which did not throw also happened.
 *   - **A refusal is not a failure.** A wallet rejects with a plain object and a numeric code;
 *     the ones a person causes or can fix are turned into a sentence here.
 *   - **A dropped read is not an answer.** The receipt poll goes through whatever node the wallet
 *     uses, and one failed request must not be reported as a transaction that never landed.
 */

export interface ChainTarget {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

export type Hex = `0x${string}`;

const hex = (n: number) => `0x${n.toString(16)}`;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** The numeric code a wallet rejected with, if it gave one. */
export function walletErrorCode(err: unknown): number | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : null;
}

/** EIP-1193 codes that mean the person, not the chain: said plainly instead of dumped as JSON. */
export const WALLET_SENTENCES: Record<number, string> = {
  4001: "You declined the request in your wallet.",
  4100: "Your wallet has not given this site access to that account.",
  [-32002]: "Your wallet already has a request open. Finish or dismiss it there, then try again.",
};

export async function request(
  provider: Eip1193Provider,
  method: string,
  params?: unknown[],
): Promise<unknown> {
  try {
    return await provider.request(params ? { method, params } : { method });
  } catch (err) {
    const sentence = WALLET_SENTENCES[walletErrorCode(err) ?? 0];
    if (sentence) throw new Error(sentence, { cause: err });
    throw err;
  }
}

/** The chain the wallet is on right now, as a number. */
export async function readChainId(provider: Eip1193Provider): Promise<number> {
  const raw = await request(provider, "eth_chainId");
  const id = typeof raw === "string" ? Number.parseInt(raw, 16) : Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error("The wallet did not say which network it is on.");
  return id;
}

/**
 * Puts the wallet on `target`, adding the network first if the wallet has never seen it, and then
 * checks that it is actually there.
 */
export async function ensureChain(provider: Eip1193Provider, target: ChainTarget): Promise<void> {
  const chainId = hex(target.chainId);
  try {
    await request(provider, "wallet_switchEthereumChain", [{ chainId }]);
  } catch (err) {
    // 4902: the wallet does not know this chain. Anything else is a refusal or a real failure.
    if (walletErrorCode(err) !== 4902) throw err;
    await request(provider, "wallet_addEthereumChain", [
      {
        chainId,
        chainName: target.name,
        nativeCurrency: target.nativeCurrency,
        rpcUrls: [target.rpcUrl],
        blockExplorerUrls: [target.explorerUrl],
      },
    ]);
  }
  if ((await readChainId(provider)) !== target.chainId) {
    throw new Error(
      `Your wallet is not on ${target.name}. Switch networks in the wallet, then try again.`,
    );
  }
}

/** A read-only call at the latest block. Returns the raw result; decoding decides what it means. */
export async function ethCall(
  provider: Eip1193Provider,
  to: string,
  data: Hex,
  /** Who the call is made as. Needed to simulate something that depends on the caller. */
  from?: string,
): Promise<Hex> {
  const call = from === undefined ? { to, data } : { from, to, data };
  const result = await request(provider, "eth_call", [call, "latest"]);
  if (typeof result !== "string" || !result.startsWith("0x")) {
    throw new Error("The wallet's network returned an unreadable answer.");
  }
  return result as Hex;
}

/**
 * Asks the wallet to send a transaction and returns its hash. Gas, nonce and fees are the wallet's
 * to choose. `chainId` is passed when known so a wallet that checks it refuses to sign for a chain
 * it has drifted off since `ensureChain`.
 */
export async function sendTransaction(
  provider: Eip1193Provider,
  tx: { from: string; to: string; data: Hex; chainId?: number },
): Promise<Hex> {
  const { chainId, ...rest } = tx;
  const sent = await request(provider, "eth_sendTransaction", [
    chainId === undefined ? rest : { ...rest, chainId: hex(chainId) },
  ]);
  if (typeof sent !== "string" || !TX_HASH.test(sent)) {
    throw new Error("The wallet did not return a transaction hash.");
  }
  return sent as Hex;
}

export interface WaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Polls the wallet's own node for a receipt. A request that fails is tried again until the
 * deadline: a flaky node says nothing about the transaction.
 */
export async function waitForReceipt(
  provider: Eip1193Provider,
  hash: string,
  options: WaitOptions = {},
): Promise<"success" | "reverted"> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 1_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    let receipt: { status?: string } | null = null;
    try {
      receipt = (await provider.request({
        method: "eth_getTransactionReceipt",
        params: [hash],
      })) as { status?: string } | null;
    } catch {
      // Tried again on the next turn.
    }
    if (receipt) return receipt.status === "0x1" ? "success" : "reverted";
    await sleep(pollMs);
  }
  throw new Error(`no receipt for ${hash} after ${Math.round(timeoutMs / 1000)}s`);
}

/** The latest block number on the wallet's current chain. */
export async function readBlockNumber(provider: Eip1193Provider): Promise<bigint> {
  const raw = await request(provider, "eth_blockNumber");
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) {
    throw new Error("The wallet's network did not return a block number.");
  }
  return BigInt(raw);
}

/**
 * The latest block's timestamp on the wallet's current chain, in Unix seconds. What a contract's
 * `block.timestamp` will be near, so a deadline is measured against the chain and not against a
 * computer clock that may be minutes out.
 */
export async function readBlockTimestamp(provider: Eip1193Provider): Promise<bigint> {
  const block = (await request(provider, "eth_getBlockByNumber", ["latest", false])) as {
    timestamp?: unknown;
  } | null;
  const raw = block?.timestamp;
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) {
    throw new Error("The wallet's network did not return the latest block.");
  }
  return BigInt(raw);
}
