import { HYPERCORE } from "@xebra/sdk/core";
import { decodeFunctionData, keccak256, parseAbi, toHex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  CROSS_CHAIN_WITHDRAW_TOPIC,
  createHyperliquidReads,
  hypercoreUnits,
  parseHyperliquidConfig,
} from "./reads";

const USER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const NONCE = 1_795_870_421_000;
const BURN = `0x${"ab".repeat(32)}`;
const pad = (hex: string) => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;

type Rpc = (method: string, params: unknown[]) => unknown;
type Info = (body: Record<string, unknown>) => unknown;

/** A fake fetch: JSON-RPC to the HyperEVM URL, `/info` bodies to Hyperliquid's. */
function fakeFetch(rpc: Rpc, info: Info = () => null) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (String(url) === "https://rpc.test/evm") {
      try {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: rpc(body.method, body.params),
        });
      } catch (e) {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32005, message: String(e) },
        });
      }
    }
    if (String(url) === "https://api.test/info") return Response.json(info(body));
    return new Response("not here", { status: 404 });
  });
}

function reads(fetchImpl: ReturnType<typeof fakeFetch>, now = NONCE + 10_000) {
  return createHyperliquidReads({
    fetch: fetchImpl as unknown as typeof fetch,
    rpcUrl: "https://rpc.test/evm",
    infoUrl: "https://api.test/info",
    now: () => now,
  });
}

describe("hypercoreUnits", () => {
  it("reads Hyperliquid's decimal strings into 6-decimal units, rounding down", () => {
    expect(hypercoreUnits("2.00000261")).toBe(2_000_002n);
    expect(hypercoreUnits("13104.514502")).toBe(13_104_514_502n);
    expect(hypercoreUnits("0.0")).toBe(0n);
    expect(hypercoreUnits("1")).toBe(1_000_000n);
  });

  it("refuses what is not a plain decimal", () => {
    for (const bad of ["", "-1", "1e3", "abc", "1.2.3", " 1"])
      expect(hypercoreUnits(bad)).toBeNull();
  });
});

describe("CROSS_CHAIN_WITHDRAW_TOPIC", () => {
  it("is the hash of CoreDepositWallet's event signature", () => {
    expect(CROSS_CHAIN_WITHDRAW_TOPIC).toBe(
      keccak256(toHex("CrossChainWithdraw(address,bytes32,uint256,uint32,uint64)")),
    );
  });
});

describe("forwardFee", () => {
  const abi = parseAbi([
    "function calculateCrossChainWithdrawalFee(bool shouldForward, uint32 destinationChainId) view returns (uint256)",
    "function paused() view returns (bool)",
  ]);

  it("asks CoreDepositWallet for a forwarded withdrawal's fee to that domain", async () => {
    const calls: unknown[] = [];
    const f = fakeFetch((method, params) => {
      expect(method).toBe("eth_call");
      const call = params[0] as { to: string; data: `0x${string}` };
      expect(call.to).toBe(HYPERCORE.coreDepositWallet);
      const decoded = decodeFunctionData({ abi, data: call.data });
      calls.push(decoded);
      if (decoded.functionName === "paused") return pad("0");
      return pad((1_200_000).toString(16));
    });
    expect(await reads(f).forwardFee(0)).toBe(1_200_000n);
    expect(calls).toContainEqual({
      functionName: "calculateCrossChainWithdrawalFee",
      args: [true, 0],
    });
  });

  it("says paused when Circle has paused the contract", async () => {
    const f = fakeFetch((_m, params) => {
      const decoded = decodeFunctionData({
        abi,
        data: (params[0] as { data: `0x${string}` }).data,
      });
      return decoded.functionName === "paused" ? pad("1") : pad("30d40");
    });
    expect(await reads(f).forwardFee(3)).toBe("paused");
  });

  it("answers null, not a zero fee, when HyperEVM cannot be read", async () => {
    const f = fakeFetch(() => {
      throw new Error("rate limited");
    });
    expect(await reads(f).forwardFee(3)).toBeNull();
  });
});

describe("account", () => {
  it("reads perps withdrawable, spot USDC less holds, and whether the account has sent anything", async () => {
    const f = fakeFetch(
      () => null,
      (body) => {
        if (body.type === "clearinghouseState") return { withdrawable: "12.3456789" };
        if (body.type === "spotClearinghouseState") {
          return {
            balances: [
              { coin: "PURR", token: 1, total: "100", hold: "0" },
              { coin: "USDC", token: 0, total: "20.5", hold: "0.5" },
            ],
          };
        }
        if (body.type === "preTransferCheck") {
          expect(body).toEqual({ type: "preTransferCheck", user: USER, source: USER });
          return { fee: "0.0", isSanctioned: false, userExists: true, userHasSentTx: false };
        }
        return null;
      },
    );
    expect(await reads(f).account(USER)).toEqual({
      perps: 12_345_678n,
      spot: 20_000_000n,
      activated: false,
    });
  });

  it("answers null when any of it cannot be read", async () => {
    const f = fakeFetch(
      () => null,
      (body) => (body.type === "spotClearinghouseState" ? { nope: true } : { withdrawable: "1" }),
    );
    expect(await reads(f).account(USER)).toBeNull();
  });
});

describe("activationFeeTo", () => {
  it("is Hyperliquid's fee for sending to that address, 1 USDC while it does not exist", async () => {
    const f = fakeFetch(
      () => null,
      () => ({ fee: "1.0", isSanctioned: false, userExists: false, userHasSentTx: false }),
    );
    expect(await reads(f).activationFeeTo(USER, USER)).toBe(1_000_000n);
  });
});

describe("findBurn", () => {
  const LATEST = 52_473_573;
  const latestTs = Math.floor((NONCE + 10_000) / 1000);

  function chain(logsAt: Record<number, unknown[]>, seen: Array<[number, number]> = []) {
    return fakeFetch((method, params) => {
      if (method === "eth_blockNumber") return toHex(LATEST);
      if (method === "eth_getBlockByNumber")
        return { number: toHex(LATEST), timestamp: toHex(latestTs) };
      if (method === "eth_getLogs") {
        const q = params[0] as {
          address: string;
          topics: string[];
          fromBlock: string;
          toBlock: string;
        };
        expect(q.address).toBe(HYPERCORE.coreDepositWallet);
        expect(q.topics).toEqual([CROSS_CHAIN_WITHDRAW_TOPIC, pad(USER)]);
        const from = Number(q.fromBlock);
        const to = Number(q.toBlock);
        expect(to - from).toBeLessThan(1000);
        seen.push([from, to]);
        return Object.entries(logsAt)
          .filter(([b]) => Number(b) >= from && Number(b) <= to)
          .flatMap(([, logs]) => logs);
      }
      throw new Error(`unexpected ${method}`);
    });
  }

  const log = (nonce: number, tx = BURN) => ({
    transactionHash: tx,
    topics: [CROSS_CHAIN_WITHDRAW_TOPIC, pad(USER), pad("77"), pad(nonce.toString(16))],
  });

  it("finds Circle's burn by its signer and nonce, from about when it was signed", async () => {
    const seen: Array<[number, number]> = [];
    const f = chain({ [LATEST - 5]: [log(NONCE - 1, `0x${"11".repeat(32)}`), log(NONCE)] }, seen);
    expect(await reads(f).findBurn(USER, NONCE)).toEqual({ txHash: BURN });
    // Signed ten seconds ago: the search starts a minute or so before, not at block zero.
    expect(seen[0]?.[0]).toBeGreaterThan(LATEST - 200);
  });

  it("says not found, without guessing, when no burn carries that nonce", async () => {
    const f = chain({ [LATEST - 5]: [log(NONCE + 1)] });
    expect(await reads(f).findBurn(USER, NONCE)).toBe("not_found");
  });

  it("searches in windows HyperEVM's RPC accepts, and only so far", async () => {
    const seen: Array<[number, number]> = [];
    const f = chain({}, seen);
    // Signed two hours ago: more blocks than four windows cover.
    const r = createHyperliquidReads({
      fetch: f as unknown as typeof fetch,
      rpcUrl: "https://rpc.test/evm",
      infoUrl: "https://api.test/info",
      now: () => NONCE + 7_200_000,
    });
    expect(await r.findBurn(USER, NONCE)).toBe("not_found");
    expect(seen.length).toBeLessThanOrEqual(4);
  });

  it("answers null, not 'not found', when HyperEVM cannot be read", async () => {
    const f = fakeFetch(() => {
      throw new Error("rate limited");
    });
    expect(await reads(f).findBurn(USER, NONCE)).toBeNull();
  });
});

describe("parseHyperliquidConfig", () => {
  it("is off unless the switch says true", () => {
    expect(parseHyperliquidConfig({}).enabled).toBe(false);
    expect(parseHyperliquidConfig({ NEXT_PUBLIC_HYPERLIQUID_SOURCE: "1" }).enabled).toBe(false);
    expect(parseHyperliquidConfig({ NEXT_PUBLIC_HYPERLIQUID_SOURCE: "true" }).enabled).toBe(true);
  });

  it("reads the fee address, and keeps a malformed one from switching the route on", () => {
    const on = { NEXT_PUBLIC_HYPERLIQUID_SOURCE: "true" };
    expect(parseHyperliquidConfig(on).feeAddress).toBeNull();
    expect(
      parseHyperliquidConfig({
        ...on,
        XEBRA_FEE_ADDRESS_HYPERCORE: " 0x32e95718A4D9B60F2e4Fb1d371189ac5DD28211A ",
      }).feeAddress,
    ).toBe("0x32e95718A4D9B60F2e4Fb1d371189ac5DD28211A");
    expect(() => parseHyperliquidConfig({ ...on, XEBRA_FEE_ADDRESS_HYPERCORE: "0x1234" })).toThrow(
      /XEBRA_FEE_ADDRESS_HYPERCORE/,
    );
  });

  it("reads an optional cap and RPC", () => {
    const c = parseHyperliquidConfig({
      NEXT_PUBLIC_HYPERLIQUID_SOURCE: "true",
      HYPERLIQUID_MAX_USDC: "250",
      HYPEREVM_RPC_URL: "https://my.rpc/evm",
    });
    expect(c.maxUnits).toBe(250_000_000n);
    expect(c.rpcUrl).toBe("https://my.rpc/evm");
    expect(parseHyperliquidConfig({}).rpcUrl).toBe(HYPERCORE.evmRpcUrl);
  });
});
