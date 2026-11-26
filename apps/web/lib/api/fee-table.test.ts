import { ZERO_BYTES32 } from "@xebra/cctp-evm";
import { QuoteSchema, TransferBuildSchema, createXebraClient } from "@xebra/sdk";
import { APTOS_BURN_SCRIPT, APTOS_CCTP, type TransferStep } from "@xebra/sdk/build";
import { EVM_CHAINS } from "@xebra/sdk/core";
import { createRebalancer } from "@xebra/sdk/intents";
import { decodeFunctionData, parseAbi } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { AptosBuildAnswer } from "../aptos/build";
import { feeTableFrom } from "../server/fee-table";
import { flatFeeOn } from "../server/flat-fee";
import { createGuard, createMemoryKeyStore, hashKey } from "./auth";
import type { BuildDeps, Deps } from "./deps";
import { endpoints } from "./endpoints";
import {
  EVM_SENDER,
  RECIPIENT,
  SOLANA_WALLET,
  STELLAR_RECIPIENT,
  SUI_SENDER,
  SUI_STEP,
  buildDeps,
  deps,
} from "./fakes";
import { ANYONE, type DestId, type Pricing, type SourceId, createService } from "./service";

/**
 * Xebra's fee table (`FEE_TABLE`, `priceFee`) as the API and the page's build routes use it: what
 * a quote shows is what the build charges, a rebalance is priced as one only with a named market-maker key, and
 * everything else keeps today's price.
 */

const FEES = {
  evm: "0x32e95718A4D9B60F2e4Fb1d371189ac5DD28211A",
  solana: "2GiJjxVmqSSTL2yfUbVnBBDkTeXEn1DM8QM2ZrRGumte",
  sui: `0x${"fe".repeat(32)}`,
  aptos: `0x${"fa".repeat(32)}`,
};
const SOLANA_SENDER = "4UXmtLwyV5tRyzuCFtQccrHkepyVDnL29GLsg5LwFN82";
const APTOS_SENDER = `0x${"74".repeat(32)}`;
const ERC20 = parseAbi(["function transfer(address to, uint256 value) returns (bool)"]);
const USDC = 1_000_000n;
const KEY = `xk_live_${"A".repeat(32)}`;
const KEY_ID = "key_mm";
/** A valid key that is not named as a market maker: an ordinary integrator. */
const OTHER_KEY = `xk_live_${"B".repeat(32)}`;
const OTHER_KEY_ID = "key_wallet";
/** The table as production builds it with `XEBRA_REBALANCE_KEY_IDS=key_mm`. */
const TABLE = feeTableFrom(KEY_ID);

const REBALANCE: Pricing = { product: "rebalance", partner: KEY_ID };
const REBALANCE_NO_KEY: Pricing = { product: "rebalance", partner: null };
const TRANSFER_WITH_KEY: Pricing = { product: "transfer", partner: KEY_ID };

/** Today's price: 0.01 plus 0.01% of the amount, rounded down. */
const today = (amount: bigint) => 10_000n + amount / 10_000n;

const APTOS_BUILT: AptosBuildAnswer = {
  status: 200,
  body: {
    transaction: {
      kind: "aptos",
      chainId: 1,
      bytecode: APTOS_BURN_SCRIPT,
      arguments: {
        amount: "1",
        destinationDomain: 27,
        mintRecipient: ZERO_BYTES32,
        destinationCaller: ZERO_BYTES32,
        burnToken: APTOS_CCTP.usdc,
        maxFee: "0",
        minFinalityThreshold: 2000,
        hookData: "0x",
      },
    },
    envelope: {
      sequenceNumber: "1",
      maxGasAmount: "2000",
      gasUnitPrice: "100",
      expirationTimestampSecs: "1800000600",
    },
    maxFee: "0",
    received: "1",
  },
};

function mocks() {
  return {
    solanaBurn: vi.fn(async (_p: Parameters<NonNullable<BuildDeps["solanaBurn"]>>[0]) => ({
      ...SUI_STEP,
      chain: "solana" as const,
    })),
    suiBurn: vi.fn(async (_p: Parameters<BuildDeps["suiBurn"]>[0]) => SUI_STEP),
    suiForwardBurn: vi.fn(async (_p: Parameters<BuildDeps["suiForwardBurn"]>[0]) => SUI_STEP),
    aptosBuild: vi.fn(async () => APTOS_BUILT),
  };
}

function svc(m = mocks(), top: Partial<Deps> = {}) {
  return createService(
    deps({
      build: buildDeps({
        ...m,
        // Enough USDC for the largest move below.
        evmUsdc: async () => ({ balance: 100_000_000n * USDC, allowance: 0n }),
      }),
      evmRoutes: {
        arcSendsTo: [],
        arcReceivesFrom: [],
        evmMesh: ["base", "arbitrum", "injective"],
        evmToStellar: ["base"],
      },
      suiStellar: { enabled: true, maxUnits: null, sendsTo: ["base"] },
      solanaSource: { evm: ["base"], stellar: true, maxUnits: null },
      aptos: { destinations: ["stellar", "base"], maxUnits: null },
      feeAddresses: FEES,
      feeTable: TABLE,
      ...top,
    }),
  );
}

/** Every off-contract route kind: EVM direct, EVM into Stellar, a claim-only chain, and the rest. */
const ROUTES: Array<{ from: SourceId; to: DestId; sender: string; recipient: string }> = [
  { from: "base", to: "arbitrum", sender: EVM_SENDER, recipient: RECIPIENT },
  { from: "base", to: "stellar", sender: EVM_SENDER, recipient: STELLAR_RECIPIENT },
  { from: "base", to: "injective", sender: EVM_SENDER, recipient: RECIPIENT },
  { from: "solana", to: "stellar", sender: SOLANA_SENDER, recipient: STELLAR_RECIPIENT },
  { from: "solana", to: "base", sender: SOLANA_SENDER, recipient: RECIPIENT },
  { from: "sui", to: "stellar", sender: SUI_SENDER, recipient: STELLAR_RECIPIENT },
  { from: "sui", to: "base", sender: SUI_SENDER, recipient: RECIPIENT },
  { from: "aptos", to: "stellar", sender: APTOS_SENDER, recipient: STELLAR_RECIPIENT },
  { from: "aptos", to: "base", sender: APTOS_SENDER, recipient: RECIPIENT },
];

/** What the built transfer actually pays Xebra, read from what the wallet will sign. */
function charged(steps: TransferStep[], m: ReturnType<typeof mocks>): bigint {
  const step = steps.find((s) => s.id === "fee");
  if (step?.tx.kind === "evm") {
    const call = decodeFunctionData({ abi: ERC20, data: step.tx.data });
    expect(call.args[0]).toBe(FEES.evm);
    return call.args[1];
  }
  if (step?.tx.kind === "aptos_call") {
    expect(step.tx.functionArguments[1]).toBe(FEES.aptos);
    return BigInt(step.tx.functionArguments[2] ?? "0");
  }
  // Solana and Sui pay the fee inside the burn's own transaction.
  const solana = m.solanaBurn.mock.calls.at(-1)?.[0]?.fee;
  if (solana) return solana.amount;
  const sui = (m.suiBurn.mock.calls.at(-1)?.[0] ?? m.suiForwardBurn.mock.calls.at(-1)?.[0])?.fee;
  if (sui) return sui.amount;
  throw new Error("no fee in this build");
}

describe("quote and build, priced by the fee table", () => {
  it("charge in the build exactly the fee the quote showed, on every off-contract route", async () => {
    for (const route of ROUTES) {
      for (const pricing of [ANYONE, REBALANCE, REBALANCE_NO_KEY, TRANSFER_WITH_KEY]) {
        for (const amount of [25n * USDC, 1_000n * USDC, 100_000n * USDC]) {
          const m = mocks();
          const s = svc(m);
          const shown = await s.quote({ from: route.from, to: route.to, amount, pricing });
          const built = await s.buildTransfer({ ...route, amount, pricing });
          const fee = charged(built.steps, m);
          const what = `${route.from}->${route.to} ${amount} ${JSON.stringify(pricing)}`;
          expect(fee, what).toBe(shown.quote.fees.xebra);
          expect(built.quote.fees.xebra, what).toBe(shown.quote.fees.xebra);
          expect(built.quote.feeRule, what).toBe(shown.quote.feeRule);
          // The fee never exceeds a tenth of what is sent, and is never zero.
          expect(fee * 10n <= amount, what).toBe(true);
          expect(fee > 0n, what).toBe(true);
          const expected =
            pricing === REBALANCE
              ? {
                  fee: 10_000n + (amount / 10_000n > 2n * USDC ? 2n * USDC : amount / 10_000n),
                  rule: "rebalance-capped",
                }
              : { fee: today(amount), rule: "default" };
          expect({ fee, rule: shown.quote.feeRule }, what).toEqual(expected);
        }
      }
    }
  }, 120_000);

  it("a contract-priced route names no rule", async () => {
    const q = await svc().quote({ from: "stellar", to: "base", amount: 10n * USDC });
    expect(q.quote.feeRule).toBeNull();
  });

  it("the page's build routes price an ordinary transfer, as the default rule does", () => {
    for (const amount of [1n, 25n * USDC, 100_000n * USDC, 10_000_000n * USDC]) {
      for (const [family, to] of [
        ["solana", 27],
        ["sui", 27],
        ["sui", 6],
        ["aptos", 6],
        ["aptos", 30],
      ] as const) {
        expect(flatFeeOn(family, to, amount, FEES)).toEqual({
          fee: today(amount),
          address: FEES[family],
          kind: to === 30 ? "claim" : "deliver",
          rule: "default",
        });
      }
    }
  });
});

describe("/v1 with and without an API key", () => {
  async function keyStore() {
    const store = createMemoryKeyStore([]);
    store.keys.set(await hashKey(KEY), { id: KEY_ID, integrator: "mm", revokedAt: null });
    store.keys.set(await hashKey(OTHER_KEY), {
      id: OTHER_KEY_ID,
      integrator: "wallet",
      revokedAt: null,
    });
    return store;
  }
  async function api() {
    return endpoints(svc(), createGuard({ store: await keyStore() }));
  }
  const BASE = "https://api.xebra.exchange/v1";
  const quote = (query: string, key?: string) =>
    new Request(
      `${BASE}/quote?${query}`,
      key ? { headers: { Authorization: `Bearer ${key}` } } : {},
    );
  const transfer = (body: Record<string, unknown>, key?: string) =>
    new Request(`${BASE}/transfers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const move = "from=base&to=arbitrum&amount=100000";

  it("prices a keyed 100,000 USDC rebalance at 2.01, and the same request without a key at 10.01", async () => {
    const v1 = await api();
    const keyed = QuoteSchema.parse(
      await (await v1.quote(quote(`${move}&product=rebalance`, KEY))).json(),
    );
    expect(keyed.fees.xebra).toBe("2.01");
    expect(keyed.feeRule).toBe("rebalance-capped");

    const anonymous = QuoteSchema.parse(
      await (await v1.quote(quote(`${move}&product=rebalance`))).json(),
    );
    expect(anonymous.fees.xebra).toBe("10.01");
    expect(anonymous.feeRule).toBe("default");

    // A valid key that is not named as a market maker pays the default for a rebalance.
    const otherKey = QuoteSchema.parse(
      await (await v1.quote(quote(`${move}&product=rebalance`, OTHER_KEY))).json(),
    );
    expect(otherKey.fees.xebra).toBe("10.01");
    expect(otherKey.feeRule).toBe("default");

    // With no key named at all, the market maker's key pays the default too.
    const unnamed = endpoints(
      svc(mocks(), { feeTable: feeTableFrom(undefined) }),
      createGuard({ store: await keyStore() }),
    );
    const notListed = QuoteSchema.parse(
      await (await unnamed.quote(quote(`${move}&product=rebalance`, KEY))).json(),
    );
    expect(notListed.feeRule).toBe("default");

    // A key alone does not make a transfer a rebalance.
    const transferWithKey = QuoteSchema.parse(await (await v1.quote(quote(move, KEY))).json());
    expect(transferWithKey.fees.xebra).toBe("10.01");
    expect(transferWithKey.feeRule).toBe("default");

    // 1,000 USDC: 0.11 either way.
    const small = QuoteSchema.parse(
      await (
        await v1.quote(quote("from=base&to=arbitrum&amount=1000&product=rebalance", KEY))
      ).json(),
    );
    expect(small.fees.xebra).toBe("0.11");
    expect(small.feeRule).toBe("rebalance-capped");
  });

  it("builds a keyed rebalance with the fee its quote showed", async () => {
    const v1 = await api();
    const res = await v1.createTransfer(
      transfer(
        {
          from: "base",
          to: "arbitrum",
          amount: "100000",
          sender: EVM_SENDER,
          recipient: RECIPIENT,
          product: "rebalance",
          maxTotalFee: "2.03",
        },
        KEY,
      ),
    );
    expect(res.status).toBe(200);
    const built = TransferBuildSchema.parse(await res.json());
    expect(built.quote.fees.xebra).toBe("2.01");
    expect(built.quote.feeRule).toBe("rebalance-capped");
    const fee = built.steps.find((s) => s.id === "fee");
    if (fee?.tx.kind !== "evm") throw new Error("no EVM fee step");
    expect(decodeFunctionData({ abi: ERC20, data: fee.tx.data as `0x${string}` }).args).toEqual([
      FEES.evm,
      2_010_000n,
    ]);
  });

  it("without a key, a rebalance build is priced as a transfer, and a fee cap set from the keyed price refuses it", async () => {
    const v1 = await api();
    const res = await v1.createTransfer(
      transfer({
        from: "base",
        to: "arbitrum",
        amount: "100000",
        sender: EVM_SENDER,
        recipient: RECIPIENT,
        product: "rebalance",
        maxTotalFee: "2.03",
      }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("fee_above_limit");
  });

  it("refuses a product it does not know", async () => {
    const v1 = await api();
    const res = await v1.quote(quote(`${move}&product=free`, KEY));
    expect(res.status).toBe(400);
  });
});

describe("the EVM chains these tests name", () => {
  it("are the ones they mean", () => {
    expect(EVM_CHAINS.base.cctpDomainId).toBe(6);
    expect(EVM_CHAINS.arbitrum.cctpDomainId).toBe(3);
    expect(EVM_CHAINS.injective.cctpDomainId).toBe(29);
  });
});

describe("the SDK's rebalancer, end to end against /v1", () => {
  /** 1Click: a same-asset withdrawal costs 0.07, a deposit is free, a direct swap finds no one. */
  const oneClick = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const json = (v: unknown, status = 200) => Response.json(v, { status });
    if (path === "/v0/tokens") {
      return json([
        {
          assetId: "nep141:base-usdc",
          blockchain: "base",
          symbol: "USDC",
          decimals: 6,
          contractAddress: EVM_CHAINS.base.usdcAddress.toLowerCase(),
        },
        {
          assetId: "nep141:arb-usdc",
          blockchain: "arb",
          symbol: "USDC",
          decimals: 6,
          contractAddress: EVM_CHAINS.arbitrum.usdcAddress.toLowerCase(),
        },
      ]);
    }
    if (body.originAsset !== body.destinationAsset) return json({ message: "No liquidity" }, 400);
    const amount = BigInt(String(body.amount));
    const out = body.depositType === "INTENTS" ? amount - 70_000n : amount;
    return json({
      quote: {
        ...(body.dry ? {} : { depositAddress: "0x4444444444444444444444444444444444444444" }),
        amountIn: String(amount),
        amountInFormatted: "",
        amountOut: String(out),
        amountOutFormatted: "",
        minAmountOut: String(out),
        timeEstimate: 10,
      },
    });
  }) as typeof fetch;

  async function rebalancer(apiKey?: string) {
    const store = createMemoryKeyStore([]);
    store.keys.set(await hashKey(KEY), { id: KEY_ID, integrator: "mm", revokedAt: null });
    const v1 = endpoints(svc(), createGuard({ store }));
    const xebra = createXebraClient({
      baseUrl: "https://api.xebra.exchange",
      ...(apiKey ? { apiKey } : {}),
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const req = new Request(String(url), init);
        const path = new URL(req.url).pathname;
        if (path === "/v1/routes") return v1.routes(req);
        if (path === "/v1/quote") return v1.quote(req);
        return v1.createTransfer(req);
      }) as typeof fetch,
    });
    return createRebalancer({ xebra, fetch: oneClick });
  }
  const REQUEST = {
    intentsAccount: "mm.near",
    from: "base",
    to: "arb",
    amount: "100000",
    fromWallet: EVM_SENDER,
    toWallet: RECIPIENT,
  };

  it("100,000 USDC Base to Arbitrum: Xebra takes 2.01 with a key, 10.01 without", async () => {
    const keyed = await (await rebalancer(KEY)).estimate(REQUEST);
    const anonymous = await (await rebalancer()).estimate(REQUEST);
    expect(keyed.feeRule).toBe("rebalance-capped");
    expect(anonymous.feeRule).toBe("default");
    expect(keyed.fees.withdraw).toBe("0.07");
    // Xebra prices what the withdrawal leaves, 99,999.93: 0.01 + 9.999993 without a key, 2.01
    // with one. The withdrawal and Circle's fee are the same either way.
    const units = (v: string) => BigInt(Math.round(Number(v) * 1e6));
    expect(units(anonymous.fees.cctp) - units(keyed.fees.cctp)).toBe(10_009_993n - 2_010_000n);
    expect(units(anonymous.fees.total) - units(keyed.fees.total)).toBe(7_999_993n);
    expect(units(keyed.fees.cctp)).toBeGreaterThanOrEqual(2_010_000n);
  });

  it("prepares the burn at the price it quoted, with the fee step to Xebra at 2.01", async () => {
    const d = await (await rebalancer(KEY)).prepareDeposit(REQUEST, { amount: "99999.93" });
    expect(d.xebra.fees.xebra).toBe("2.01");
    expect(d.build.quote.fees.xebra).toBe("2.01");
    const fee = d.build.steps.find((s) => s.id === "fee");
    if (fee?.tx.kind !== "evm") throw new Error("no EVM fee step");
    expect(decodeFunctionData({ abi: ERC20, data: fee.tx.data as `0x${string}` }).args[1]).toBe(
      2_010_000n,
    );
  });
});
