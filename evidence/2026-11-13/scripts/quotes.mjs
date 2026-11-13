// Collect public bridge quotes for USDC pairs at several sizes. Read-only: no signing, no tx.
import { writeFileSync, existsSync } from "node:fs";

const RAW = new URL("../raw", import.meta.url).pathname;
const EVM_DUMMY = "0x000000000000000000000000000000000000dEaD";
const EVM_ONES = "0x1111111111111111111111111111111111111111"; // 1Click rejects 0x...dEaD
const SOL_DUMMY = "1nc1nerator11111111111111111111111111111111";
const STELLAR_DUMMY = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"; // Circle USDC issuer, public
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const C = {
  eth: { usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", lifi: 1, relay: 1, debridge: 1, across: 1, mayan: "ethereum", oneclick: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", addr: EVM_DUMMY },
  base: { usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", lifi: 8453, relay: 8453, debridge: 8453, across: 8453, mayan: "base", oneclick: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", addr: EVM_DUMMY },
  arb: { usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", lifi: 42161, relay: 42161, debridge: 42161, across: 42161, mayan: "arbitrum", oneclick: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", addr: EVM_DUMMY },
  pol: { usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", lifi: 137, relay: 137, debridge: 137, across: 137, mayan: "polygon", oneclick: "nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near", addr: EVM_DUMMY },
  avax: { usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", lifi: 43114, relay: 43114, debridge: 43114, across: null, mayan: "avalanche", oneclick: "nep141:avax-0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e.omdep.near", addr: EVM_DUMMY },
  sol: { usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", lifi: 1151111081099710, relay: 792703809, debridge: 7565164, across: 34268394551451, mayan: "solana", oneclick: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", addr: SOL_DUMMY },
  near: { oneclick: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", addr: "intents.near" },
  sui: { oneclick: "nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near", addr: "0x0000000000000000000000000000000000000000000000000000000000000000" },
  stellar: { usdc: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", oneclick: "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu", addr: STELLAR_DUMMY, decimals: 7 },
};
const PAIRS = process.env.PAIRS ? JSON.parse(process.env.PAIRS) : [["base", "arb"], ["eth", "base"], ["arb", "eth"], ["stellar", "base"], ["base", "sol"], ["pol", "avax"]];
const SIZES = process.env.SIZES ? JSON.parse(process.env.SIZES) : [10, 100, 1000, 10000, 100000];
const only = process.argv[2];

async function hit(name, url, init = {}) {
  const fetchedAtUtc = new Date().toISOString();
  const t0 = Date.now();
  let status = 0, body = null, text = "";
  try {
    const res = await fetch(url, { ...init, headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) }, signal: AbortSignal.timeout(45000) });
    status = res.status; text = await res.text();
    try { body = JSON.parse(text); } catch { body = text; }
  } catch (e) { body = { fetchError: String(e) }; }
  const out = { meta: { url, method: init.method || "GET", requestBody: init.body ? JSON.parse(init.body) : null, fetchedAtUtc, latencyMs: Date.now() - t0, httpStatus: status }, body };
  writeFileSync(`${RAW}/${name}.json`, JSON.stringify(out, null, 2));
  console.log(name, status, JSON.stringify(body).slice(0, 160));
  return out;
}
const units = (n, d = 6) => BigInt(Math.round(n * 1e6)) * 10n ** BigInt(d) / 1000000n;

const providers = {
  async lifi(s, d, n) {
    if (!C[s].lifi || !C[d].lifi) return;
    const q = new URLSearchParams({ fromChain: C[s].lifi, toChain: C[d].lifi, fromToken: C[s].usdc, toToken: C[d].usdc, fromAmount: units(n).toString(), fromAddress: C[s].addr, toAddress: C[d].addr, slippage: "0.005" });
    await hit(`lifi_${s}_${d}_${n}`, `https://li.quest/v1/quote?${q}`);
    await sleep(2500);
  },
  async across(s, d, n) {
    if (!C[s].across || !C[d].across) return;
    const q = new URLSearchParams({ inputToken: C[s].usdc, outputToken: C[d].usdc, originChainId: C[s].across, destinationChainId: C[d].across, amount: units(n).toString(), recipient: C[d].addr });
    await hit(`across_${s}_${d}_${n}`, `https://app.across.to/api/suggested-fees?${q}`);
    await sleep(800);
  },
  async relay(s, d, n) {
    if (!C[s].relay || !C[d].relay) return;
    const body = { user: C[s].addr, recipient: C[d].addr, originChainId: C[s].relay, destinationChainId: C[d].relay, originCurrency: C[s].usdc, destinationCurrency: C[d].usdc, amount: units(n).toString(), tradeType: "EXACT_INPUT" };
    await hit(`relay_${s}_${d}_${n}`, "https://api.relay.link/quote", { method: "POST", body: JSON.stringify(body) });
    await sleep(1200);
  },
  async debridge(s, d, n) {
    if (!C[s].debridge || !C[d].debridge) return;
    const q = new URLSearchParams({ srcChainId: C[s].debridge, srcChainTokenIn: C[s].usdc, srcChainTokenInAmount: units(n).toString(), dstChainId: C[d].debridge, dstChainTokenOut: C[d].usdc, prependOperatingExpenses: "true" });
    await hit(`debridge_${s}_${d}_${n}`, `https://dln.debridge.finance/v1.0/dln/order/quote?${q}`);
    await sleep(1200);
  },
  async mayan(s, d, n) {
    if (!C[s].mayan || !C[d].mayan) return;
    const q = new URLSearchParams({ wormhole: "true", swift: "true", mctp: "true", fastMctp: "true", shuttle: "false", gasless: "false", onlyDirect: "false", fullList: "true", amountIn64: units(n).toString(), fromToken: C[s].usdc, fromChain: C[s].mayan, toToken: C[d].usdc, toChain: C[d].mayan, slippageBps: "auto", gasDrop: "0", sdkVersion: "11_0_0" });
    await hit(`mayan_${s}_${d}_${n}`, `https://price-api.mayan.finance/v3/quote?${q}`);
    await sleep(1200);
  },
  async oneclick(s, d, n) {
    const dec = C[s].decimals || 6;
    const ad = (k) => (C[k].addr === EVM_DUMMY ? EVM_ONES : C[k].addr);
    const body = { dry: true, ...(s === "stellar" ? { depositMode: "MEMO" } : {}), swapType: "EXACT_INPUT", slippageTolerance: 50, originAsset: C[s].oneclick, depositType: "ORIGIN_CHAIN", destinationAsset: C[d].oneclick, amount: units(n, dec).toString(), refundTo: ad(s), refundType: "ORIGIN_CHAIN", recipient: ad(d), recipientType: "DESTINATION_CHAIN", deadline: new Date(Date.now() + 3600e3).toISOString() };
    await hit(`oneclick_${s}_${d}_${n}`, "https://1click.chaindefuser.com/v0/quote", { method: "POST", body: JSON.stringify(body) });
    await sleep(1500);
  },
};

for (const [s, d] of PAIRS) {
  for (const n of SIZES) {
    for (const [p, fn] of Object.entries(providers)) {
      if (only && only !== p) continue;
      await fn(s, d, n);
    }
  }
}
