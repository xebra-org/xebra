import { HYPERCORE, parseUsdcAmount } from "@xebra/sdk/core";
import { encodeFunctionData, parseAbi } from "viem";
import type { HyperliquidDeps } from "../api/deps";

/**
 * What a withdrawal from Hyperliquid reads, over plain HTTP: Hyperliquid's `/info` (balances, the
 * activation check) and HyperEVM's JSON-RPC (Circle's fee, Circle's burn). Nothing here signs or
 * sends, and every failure is an answer of null ("could not be read"), never a guess.
 *
 * HyperEVM's public RPC (`rpc.hyperliquid.xyz/evm`) rate-limits hard and answers `eth_getLogs`
 * over at most 1,000 blocks (probed 2026-11-28); `HYPEREVM_RPC_URL` points at another node.
 */

const ABI = parseAbi([
  "function calculateCrossChainWithdrawalFee(bool shouldForward, uint32 destinationChainId) view returns (uint256)",
  "function paused() view returns (bool)",
]);

/**
 * keccak256("CrossChainWithdraw(address,bytes32,uint256,uint32,uint64)"): `from`, `to` and
 * `coreNonce` are indexed, so topics are [this, from, to, coreNonce].
 */
export const CROSS_CHAIN_WITHDRAW_TOPIC =
  "0x761918307e881a4e311536b54c38a673f25126bd4ad389ccbff15ef9b3a24c41";

/** The most blocks one `eth_getLogs` may span on HyperEVM's public RPC. */
const LOG_WINDOW = 1000;
/** How many windows one status read searches: about an hour of HyperEVM's ~1 block a second. */
const MAX_WINDOWS = 4;
/** Searched from this long before the nonce's time, in seconds, for clock drift between the two. */
const LEAD_SECONDS = 60;

/**
 * Hyperliquid reports USDC as decimal strings with up to 8 places ("2.00000261"). Floors to the
 * 6-decimal units everything else here uses; null for anything that is not a plain decimal.
 */
export function hypercoreUnits(value: string): bigint | null {
  const m = /^(\d{1,15})(?:\.(\d{1,18}))?$/.exec(value);
  if (!m) return null;
  const whole = m[1] ?? "0";
  const frac = (m[2] ?? "").slice(0, 6);
  const parsed = parseUsdcAmount(frac ? `${whole}.${frac}` : whole);
  // parseUsdcAmount refuses zero; zero is a balance here.
  return parsed ?? (/^0*$/.test(whole) && /^0*$/.test(frac) ? 0n : null);
}

const pad32 = (hex: string) => `0x${hex.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;

export interface HyperliquidConfig {
  enabled: boolean;
  feeAddress: string | null;
  maxUnits: bigint | null;
  rpcUrl: string;
}

/**
 * The server's switches for Hyperliquid as a source:
 *
 *  - `NEXT_PUBLIC_HYPERLIQUID_SOURCE=true`  on; anything else, off (the default).
 *  - `XEBRA_FEE_ADDRESS_HYPERCORE`          Xebra's fee address on HyperCore. Unset: the route is
 *                                           listed nowhere and every quote is refused, never free.
 *                                           Malformed: the server refuses to start the route.
 *  - `HYPERLIQUID_MAX_USDC`                 optional cap per withdrawal.
 *  - `HYPEREVM_RPC_URL`                     optional HyperEVM node (default Hyperliquid's public one).
 */
export function parseHyperliquidConfig(env: Record<string, string | undefined>): HyperliquidConfig {
  const feeRaw = env.XEBRA_FEE_ADDRESS_HYPERCORE?.trim() ?? "";
  if (feeRaw && !/^0x[0-9a-fA-F]{40}$/.test(feeRaw)) {
    throw new Error(`XEBRA_FEE_ADDRESS_HYPERCORE is not a 0x address: ${feeRaw}`);
  }
  const capRaw = env.HYPERLIQUID_MAX_USDC?.trim() ?? "";
  const cap = capRaw ? parseUsdcAmount(capRaw) : null;
  if (capRaw && cap === null) throw new Error(`HYPERLIQUID_MAX_USDC is not an amount: ${capRaw}`);
  return {
    enabled: env.NEXT_PUBLIC_HYPERLIQUID_SOURCE?.trim() === "true",
    feeAddress: feeRaw || null,
    maxUnits: cap,
    rpcUrl: env.HYPEREVM_RPC_URL?.trim() || HYPERCORE.evmRpcUrl,
  };
}

type Reads = Omit<HyperliquidDeps, "feeAddress" | "maxUnits">;

export function createHyperliquidReads(o: {
  fetch: typeof fetch;
  rpcUrl: string;
  infoUrl: string;
  now: () => number;
}): Reads {
  let id = 0;

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await o.fetch(o.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HyperEVM ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error || body.result === undefined) {
      throw new Error(`HyperEVM ${method}: ${body.error?.message ?? "no result"}`);
    }
    return body.result;
  }

  async function info<T>(body: Record<string, unknown>): Promise<T> {
    const res = await o.fetch(o.infoUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Hyperliquid info ${String(body.type)}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** Runs a read; anything that goes wrong is "could not be read", logged for a person. */
  async function orNull<T>(what: string, read: () => Promise<T | null>): Promise<T | null> {
    try {
      return await read();
    } catch (err) {
      console.error(`${what} could not be read`, err);
      return null;
    }
  }

  async function preTransferCheck(user: string, source: string) {
    const r = await info<{ fee?: unknown; userHasSentTx?: unknown } | null>({
      type: "preTransferCheck",
      user,
      source,
    });
    const fee = typeof r?.fee === "string" ? hypercoreUnits(r.fee) : null;
    if (fee === null || typeof r?.userHasSentTx !== "boolean") {
      throw new Error("preTransferCheck answered something unexpected");
    }
    return { fee, hasSent: r.userHasSentTx };
  }

  return {
    forwardFee: (domain) =>
      orNull("Circle's HyperCore withdrawal fee", async () => {
        const call = (data: `0x${string}`) =>
          rpc<string>("eth_call", [{ to: HYPERCORE.coreDepositWallet, data }, "latest"]);
        const [paused, fee] = await Promise.all([
          call(encodeFunctionData({ abi: ABI, functionName: "paused" })),
          call(
            encodeFunctionData({
              abi: ABI,
              functionName: "calculateCrossChainWithdrawalFee",
              args: [true, domain],
            }),
          ),
        ]);
        if (BigInt(paused) !== 0n) return "paused" as const;
        return BigInt(fee);
      }),

    account: (user) =>
      orNull("A Hyperliquid account", async () => {
        const [perps, spot, check] = await Promise.all([
          info<{ withdrawable?: unknown } | null>({ type: "clearinghouseState", user }),
          info<{ balances?: unknown } | null>({ type: "spotClearinghouseState", user }),
          preTransferCheck(user, user),
        ]);
        const withdrawable =
          typeof perps?.withdrawable === "string" ? hypercoreUnits(perps.withdrawable) : null;
        if (withdrawable === null || !Array.isArray(spot?.balances)) {
          throw new Error("Hyperliquid answered something unexpected for the balances");
        }
        const usdc = (spot.balances as Array<Record<string, unknown>>).find(
          (b) => b.coin === "USDC" && b.token === 0,
        );
        let spotUnits = 0n;
        if (usdc) {
          const total = typeof usdc.total === "string" ? hypercoreUnits(usdc.total) : null;
          const hold = typeof usdc.hold === "string" ? hypercoreUnits(usdc.hold) : 0n;
          if (total === null || hold === null) throw new Error("unreadable spot USDC balance");
          spotUnits = total > hold ? total - hold : 0n;
        }
        return { perps: withdrawable, spot: spotUnits, activated: check.hasSent };
      }),

    activationFeeTo: (address, from) =>
      orNull(
        "Hyperliquid's account check",
        async () => (await preTransferCheck(address, from)).fee,
      ),

    findBurn: (user, nonce) =>
      orNull("Circle's burn on HyperEVM", async () => {
        const latest = Number(await rpc<string>("eth_blockNumber", []));
        const head = await rpc<{ timestamp?: string } | null>("eth_getBlockByNumber", [
          `0x${latest.toString(16)}`,
          false,
        ]);
        const headTs = Number(head?.timestamp);
        if (!Number.isFinite(latest) || !Number.isFinite(headTs)) {
          throw new Error("HyperEVM's head block could not be read");
        }
        // HyperEVM makes about one small block a second (10,000 blocks in 9,836 s, measured
        // 2026-11-28); 5% slack starts the search early rather than late.
        const behind = Math.max(0, headTs - (Math.floor(nonce / 1000) - LEAD_SECONDS));
        let from = Math.max(0, latest - Math.ceil(behind * 1.05));
        for (let i = 0; i < MAX_WINDOWS && from <= latest; i++) {
          const to = Math.min(from + LOG_WINDOW - 1, latest);
          const logs = await rpc<Array<{ transactionHash?: string; topics?: string[] }>>(
            "eth_getLogs",
            [
              {
                address: HYPERCORE.coreDepositWallet,
                topics: [CROSS_CHAIN_WITHDRAW_TOPIC, pad32(user)],
                fromBlock: `0x${from.toString(16)}`,
                toBlock: `0x${to.toString(16)}`,
              },
            ],
          );
          // Matched on the nonce in the event, never on amount or timing: one signer can have
          // several withdrawals in a window.
          const hit = logs.find((l) => l.topics?.[3] && BigInt(l.topics[3]) === BigInt(nonce));
          if (hit?.transactionHash) return { txHash: hit.transactionHash };
          from = to + 1;
        }
        return "not_found" as const;
      }),
  };
}
