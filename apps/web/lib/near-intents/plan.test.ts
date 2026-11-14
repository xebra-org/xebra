import { describe, expect, it } from "vitest";
import { ONECLICK_REFERRAL, legSeconds, refundFor, request, sourceOf, toUnits } from "./plan";

describe("toUnits", () => {
  it("scales a decimal amount to a token's base units", () => {
    expect(toUnits("24.7", 6)).toBe("24700000");
    expect(toUnits("25", 7)).toBe("250000000");
    expect(toUnits("0.000001", 6)).toBe("1");
  });

  it("drops digits beyond the token's precision instead of rounding up", () => {
    expect(toUnits("1.2345678", 6)).toBe("1234567");
  });

  it("refuses anything that is not a plain decimal", () => {
    expect(() => toUnits("1e6", 6)).toThrow();
    expect(() => toUnits("-1", 6)).toThrow();
    expect(() => toUnits("", 6)).toThrow();
  });
});

describe("sourceOf", () => {
  it("defaults to Stellar and takes either naming", () => {
    expect(sourceOf({})).toBe("stellar");
    expect(sourceOf({ from: "arc" })).toBe("arc");
    expect(sourceOf({ from: "arb" })).toBe("arbitrum");
    expect(sourceOf({ from: "Unichain" })).toBe("unichain");
  });

  it("refuses chains a swap cannot start on through Xebra", () => {
    expect(() => sourceOf({ from: "solana" })).toThrow("not solana");
    expect(() => sourceOf({ from: "sui" })).toThrow("not sui");
    expect(() => sourceOf({ from: "tron" })).toThrow("not tron");
  });
});

describe("refundFor", () => {
  const G = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  it("sends a Stellar user's refund to their own NEAR Intents account", () => {
    const r = refundFor("stellar", G);
    expect(r.refundType).toBe("INTENTS");
    expect(r.refundTo).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends an EVM user's refund to the same address on the hub", () => {
    const a = "0x1111111111111111111111111111111111111111";
    expect(refundFor("arc", a)).toEqual({ refundTo: a, refundType: "ORIGIN_CHAIN" });
  });
});

describe("legSeconds", () => {
  it("is a minute from Stellar and fast-finality chains, longer from rollups", () => {
    expect(legSeconds("stellar")).toBe(60);
    expect(legSeconds("arc")).toBe(60);
    expect(legSeconds("base")).toBe(20 * 60);
  });
});

describe("request", () => {
  const r = {
    amount: "25",
    sender: "0x1111111111111111111111111111111111111111",
    destinationAsset: "nep141:wrap.near",
    recipient: "alice.near",
  };
  const over = {
    dry: true,
    originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    amount: "25000000",
    refundTo: r.sender,
    refundType: "ORIGIN_CHAIN" as const,
  };

  it("tags every 1Click quote with Xebra's referral, in lower case as 1Click requires", () => {
    expect(ONECLICK_REFERRAL).toBe("xebra");
    expect(request(over, r).referral).toBe("xebra");
    expect(request({ ...over, dry: false }, r, { swapType: "FLEX_INPUT" }).referral).toBe("xebra");
  });
});
