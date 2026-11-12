import { describe, expect, it, vi } from "vitest";
import type { Routes, TransferBuild, TransferRequest } from "../api/schemas.js";
import { EVM_CHAINS } from "../core/chains/evm.js";
import {
  INTENTS_CHAINS,
  type IntentsToken,
  createIntentsRouter,
  toIntentsChain,
  toXebraChain,
  usdcChainOf,
} from "./index.js";

const ROUTES: Routes = {
  routes: [
    { from: "stellar", to: "base", speeds: ["standard"] },
    { from: "stellar", to: "solana", speeds: ["standard"] },
    { from: "sui", to: "stellar", speeds: ["standard"] },
  ],
  complete: true,
};

function fakeClient(routes: Routes = ROUTES) {
  return {
    routes: vi.fn(async () => routes),
    createTransfer: vi.fn(
      async (_r: TransferRequest) => ({ steps: [] }) as unknown as TransferBuild,
    ),
  };
}

// Entries copied from the live 1Click token list on 2026-11-12.
const TOKENS = {
  baseUsdc: {
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    blockchain: "base",
    symbol: "USDC",
    decimals: 6,
    contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
  solUsdc: {
    assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    blockchain: "sol",
    symbol: "USDC",
    decimals: 6,
    contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  stellarUsdc: {
    assetId: "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu",
    blockchain: "stellar",
    symbol: "USDC",
    decimals: 7,
    contractAddress: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
  suiUsdc: {
    assetId: "nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near",
    blockchain: "sui",
    symbol: "USDC",
    decimals: 6,
    contractAddress:
      "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  },
  monadUsdc: {
    assetId: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
    blockchain: "monad",
    symbol: "USDC",
    decimals: 6,
    contractAddress: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
  },
  bscUsdc: {
    assetId: "nep141:bnb-0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d.omdep.near",
    blockchain: "bsc",
    symbol: "USDC",
    decimals: 18,
    contractAddress: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
  },
} satisfies Record<string, IntentsToken>;

describe("chain names", () => {
  it("maps every NEAR Intents name to a Xebra chain and back", () => {
    for (const [intents, xebra] of Object.entries(INTENTS_CHAINS)) {
      expect(toXebraChain(intents)).toBe(xebra);
      expect(toIntentsChain(xebra)).toBe(intents);
    }
  });

  it("accepts Xebra's own names and ignores case and spaces", () => {
    expect(toXebraChain("arbitrum")).toBe("arbitrum");
    expect(toXebraChain(" ARB ")).toBe("arbitrum");
  });

  it("refuses chains Xebra cannot reach", () => {
    expect(toXebraChain("tron")).toBeNull();
    expect(toXebraChain("btc")).toBeNull();
    expect(toXebraChain("bsc")).toBeNull();
  });

  it("names only chains whose EVM entry exists", () => {
    for (const xebra of Object.values(INTENTS_CHAINS)) {
      if (xebra === "stellar" || xebra === "sui" || xebra === "solana") continue;
      expect(EVM_CHAINS[xebra]).toBeDefined();
    }
  });
});

describe("usdcChainOf", () => {
  it("recognises Circle's USDC on each chain Xebra reaches", () => {
    expect(usdcChainOf(TOKENS.baseUsdc)).toBe("base");
    expect(usdcChainOf(TOKENS.solUsdc)).toBe("solana");
    expect(usdcChainOf(TOKENS.stellarUsdc)).toBe("stellar");
    expect(usdcChainOf(TOKENS.suiUsdc)).toBe("sui");
    expect(usdcChainOf(TOKENS.monadUsdc)).toBe("monad");
  });

  it("refuses USDC on a chain Xebra does not reach", () => {
    expect(usdcChainOf(TOKENS.bscUsdc)).toBeNull();
  });

  it("refuses a token that only calls itself USDC", () => {
    expect(
      usdcChainOf({
        ...TOKENS.baseUsdc,
        contractAddress: "0x0000000000000000000000000000000000000001",
      }),
    ).toBeNull();
    const { contractAddress: _, ...noAddress } = TOKENS.baseUsdc;
    expect(usdcChainOf(noAddress)).toBeNull();
  });
});

describe("isRouteAvailable", () => {
  it("answers from the live route list in either naming", async () => {
    const r = createIntentsRouter({ client: fakeClient() });
    expect(await r.isRouteAvailable("stellar", "base")).toBe(true);
    expect(await r.isRouteAvailable("stellar", "sol")).toBe(true);
    expect(await r.isRouteAvailable("base", "stellar")).toBe(false);
    expect(await r.isRouteAvailable("stellar", "arb")).toBe(false);
  });

  it("answers false for unknown chains and the same chain twice", async () => {
    const r = createIntentsRouter({ client: fakeClient() });
    expect(await r.isRouteAvailable("stellar", "tron")).toBe(false);
    expect(await r.isRouteAvailable("base", "base")).toBe(false);
  });

  it("reads the route list once per cache window, and again after it", async () => {
    let t = 0;
    const client = fakeClient();
    const r = createIntentsRouter({ client, cacheMs: 1000, now: () => t });
    await Promise.all([
      r.isRouteAvailable("stellar", "base"),
      r.isRouteAvailable("sui", "stellar"),
    ]);
    t = 999;
    await r.isRouteAvailable("stellar", "base");
    expect(client.routes).toHaveBeenCalledTimes(1);
    t = 1000;
    await r.isRouteAvailable("stellar", "base");
    expect(client.routes).toHaveBeenCalledTimes(2);
  });

  it("picks up a route Xebra adds later without a code change", async () => {
    let t = 0;
    let routes = ROUTES;
    const client = { ...fakeClient(), routes: vi.fn(async () => routes) };
    const r = createIntentsRouter({ client, cacheMs: 10, now: () => t });
    expect(await r.isRouteAvailable("stellar", "arb")).toBe(false);
    routes = {
      ...ROUTES,
      routes: [...ROUTES.routes, { from: "stellar", to: "arbitrum", speeds: ["standard"] }],
    };
    t = 10;
    expect(await r.isRouteAvailable("stellar", "arb")).toBe(true);
  });

  it("does not keep a list that came back incomplete", async () => {
    const client = fakeClient({ ...ROUTES, complete: false });
    const r = createIntentsRouter({ client, now: () => 0 });
    await r.isRouteAvailable("stellar", "base");
    await r.isRouteAvailable("stellar", "base");
    expect(client.routes).toHaveBeenCalledTimes(2);
  });

  it("rejects when Xebra cannot be reached, so the caller keeps its usual path", async () => {
    const client = {
      ...fakeClient(),
      routes: vi.fn(async () => Promise.reject(new Error("down"))),
    };
    const r = createIntentsRouter({ client });
    await expect(r.isRouteAvailable("stellar", "base")).rejects.toThrow("down");
  });
});

describe("pickHub", () => {
  it("takes the first preferred hub Xebra reaches", async () => {
    const r = createIntentsRouter({ client: fakeClient() });
    expect(await r.pickHub("stellar")).toBe("base");
    expect(await r.pickHub("stellar", ["arbitrum", "solana"])).toBe("solana");
    expect(await r.pickHub("sui")).toBeNull();
  });
});

describe("buildDeposit", () => {
  it("sends the USDC straight to the deposit address", async () => {
    const client = fakeClient();
    const r = createIntentsRouter({ client });
    await r.buildDeposit({
      from: "stellar",
      depositChain: "base",
      depositAddress: "0x1bEDCb7651837e4a60574C50Eb1d141bA0D9E270",
      sender: "GBTVJ6JACFRBNI6BETAY4CWYWYNJHX43TGNEAVC3YQCSPPPY4R7H5TBN",
      amount: "25",
      maxTotalFee: "0.40",
    });
    expect(client.createTransfer).toHaveBeenCalledWith({
      from: "stellar",
      to: "base",
      amount: "25",
      sender: "GBTVJ6JACFRBNI6BETAY4CWYWYNJHX43TGNEAVC3YQCSPPPY4R7H5TBN",
      recipient: "0x1bEDCb7651837e4a60574C50Eb1d141bA0D9E270",
      maxTotalFee: "0.40",
    });
  });

  it("refuses a route Xebra does not offer before building anything", async () => {
    const client = fakeClient();
    const r = createIntentsRouter({ client });
    await expect(
      r.buildDeposit({
        from: "stellar",
        depositChain: "arb",
        depositAddress: "0x1bEDCb7651837e4a60574C50Eb1d141bA0D9E270",
        sender: "GBTVJ6JACFRBNI6BETAY4CWYWYNJHX43TGNEAVC3YQCSPPPY4R7H5TBN",
        amount: "25",
      }),
    ).rejects.toThrow("does not move USDC from stellar to arbitrum");
    expect(client.createTransfer).not.toHaveBeenCalled();
  });
});
