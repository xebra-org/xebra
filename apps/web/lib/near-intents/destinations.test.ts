import { describe, expect, it } from "vitest";
import { NON_CCTP_BLOCKCHAINS, WANTED, pickDestinations } from "./destinations";
import { RECIPIENT_RULES } from "./recipients";

describe("WANTED", () => {
  it("lists each asset once", () => {
    const keys = WANTED.map((w) => `${w.blockchain}/${w.symbol}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has a recipient rule, a chain name and a hint for every entry", () => {
    for (const w of WANTED) {
      expect(RECIPIENT_RULES[w.blockchain], w.blockchain).toBeDefined();
      expect(w.chain.trim(), w.blockchain).not.toBe("");
      expect(w.recipientHint.trim(), w.blockchain).not.toBe("");
    }
  });

  it("offers the 19 chains Circle's CCTP does not reach that 1Click quoted on 2026-11-28", () => {
    const offered = new Set(WANTED.map((w) => w.blockchain));
    expect([...NON_CCTP_BLOCKCHAINS].sort()).toEqual(
      [
        "adi",
        "aleo",
        "bch",
        "bera",
        "bsc",
        "btc",
        "cardano",
        "dash",
        "doge",
        "fogo",
        "gnosis",
        "hood",
        "ltc",
        "near",
        "scroll",
        "ton",
        "tron",
        "xrp",
        "zec",
      ].sort(),
    );
    for (const b of NON_CCTP_BLOCKCHAINS) expect(offered.has(b), b).toBe(true);
  });

  it("keeps the destinations offered before, in front", () => {
    expect(WANTED.slice(0, 10).map((w) => `${w.blockchain}/${w.symbol}`)).toEqual([
      "near/USDC",
      "near/wNEAR",
      "sol/USDC",
      "sol/SOL",
      "arb/USDC",
      "eth/ETH",
      "btc/BTC",
      "zec/ZEC",
      "tron/USDT",
      "ton/USDT",
    ]);
  });

  it("warns where an exchange deposit would need a tag or memo NEAR Intents cannot add", () => {
    const xrp = WANTED.find((w) => w.blockchain === "xrp");
    const ton = WANTED.find((w) => w.blockchain === "ton");
    expect(xrp?.note).toMatch(/destination tag/);
    expect(ton?.note).toMatch(/memo/);
  });
});

describe("pickDestinations", () => {
  const token = (blockchain: string, symbol: string, assetId: string, decimals = 6) => ({
    blockchain,
    symbol,
    assetId,
    decimals,
  });

  it("keeps only listed assets, with the live asset id and decimals", () => {
    const out = pickDestinations([
      token("xrp", "XRP", "nep141:xrp.omft.near"),
      token("bsc", "USDT", "nep141:bnb-0x55d3.omdep.near", 18),
    ]);
    expect(out.map((d) => d.assetId).sort()).toEqual([
      "nep141:bnb-0x55d3.omdep.near",
      "nep141:xrp.omft.near",
    ]);
    const bsc = out.find((d) => d.chain === "BNB Chain");
    expect(bsc).toMatchObject({ symbol: "USDT", decimals: 18, recipientHint: "0x address" });
  });

  it("never matches a retired asset marked (DEPRECATED)", () => {
    const out = pickDestinations([token("bsc", "USDT(DEPRECATED)", "nep245:old")]);
    expect(out).toEqual([]);
  });

  it("drops an entry 1Click stops listing", () => {
    expect(pickDestinations([])).toEqual([]);
  });

  it("passes the note through for the page to show", () => {
    const [xrp] = pickDestinations([token("xrp", "XRP", "nep141:xrp.omft.near")]);
    expect(xrp?.note).toMatch(/destination tag/);
  });
});
