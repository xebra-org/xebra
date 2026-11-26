import { DEFAULT_FEE_RULE_ID, FEE_TABLE, priceFee } from "@xebra/sdk/core";
import { describe, expect, it } from "vitest";
import { feeTableFrom, rebalanceKeyIds } from "./fee-table";

describe("the server's fee table", () => {
  it("reads the market-maker key ids from a comma-separated list", () => {
    expect(rebalanceKeyIds(undefined)).toEqual([]);
    expect(rebalanceKeyIds("")).toEqual([]);
    expect(rebalanceKeyIds(" key_a , ,key_b,")).toEqual(["key_a", "key_b"]);
  });

  it("names nobody when the variable is unset, so every rebalance pays the default", () => {
    expect(feeTableFrom(undefined)).toBe(FEE_TABLE);
    expect(
      priceFee(100_000_000_000n, { product: "rebalance", partner: "key_a" }, feeTableFrom("")).rule,
    ).toBe(DEFAULT_FEE_RULE_ID);
  });

  it("gives the capped price only to the keys it names", () => {
    const table = feeTableFrom("key_a,key_b");
    const price = (partner: string | null) =>
      priceFee(100_000_000_000n, { product: "rebalance", partner }, table);
    expect(price("key_a")).toEqual({ fee: 2_010_000n, rule: "rebalance-capped" });
    expect(price("key_b").fee).toBe(2_010_000n);
    expect(price("key_c")).toEqual({ fee: 10_010_000n, rule: "default" });
    expect(price(null).rule).toBe("default");
  });
});
