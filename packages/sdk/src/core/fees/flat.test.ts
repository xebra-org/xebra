import { describe, expect, it } from "vitest";
import {
  CLAIM_ONLY_DOMAINS,
  XEBRA_FEE_BPS,
  XEBRA_FLAT_FEE,
  amountForBurn,
  flatFeeFor,
  flatFeeKind,
} from "./flat.js";

describe("flat fee", () => {
  it("is 0.01 USDC plus 0.01% of the amount, wherever the transfer goes", () => {
    expect(XEBRA_FLAT_FEE).toEqual({ deliver: 10_000n, claim: 10_000n });
    expect(XEBRA_FEE_BPS).toBe(1n);
    for (const delivered of [
      0, 1, 2, 3, 5, 6, 7, 10, 11, 12, 13, 14, 15, 16, 18, 19, 21, 22, 26, 27, 28, 32, 33, 37,
    ]) {
      expect(flatFeeKind(delivered)).toBe("deliver");
      expect(flatFeeFor(delivered)).toBe(10_000n);
      // 100 USDC: 0.01 + 0.01.
      expect(flatFeeFor(delivered, 100_000_000n)).toBe(20_000n);
    }
    for (const claimed of [8, 9, 25, 29, 30, 31]) {
      expect(flatFeeKind(claimed)).toBe("claim");
      expect(flatFeeFor(claimed, 100_000_000n)).toBe(20_000n);
    }
  });

  it("rounds the percentage down to a whole unit", () => {
    // 0.01% of 10 USDC is 1,000 units; of 10.009999 it is 1,000.9999, so 1,000.
    expect(flatFeeFor(6, 10_000_000n)).toBe(11_000n);
    expect(flatFeeFor(6, 10_009_999n)).toBe(11_000n);
    // 10,000 USDC: 0.01 + 1.00.
    expect(flatFeeFor(6, 10_000_000_000n)).toBe(1_010_000n);
  });

  it("finds the least amount that leaves a given burn after the fee", () => {
    for (const burn of [1n, 999_999n, 1_000_000n, 1_100_000n, 123_456_789n, 10_000_000_000n]) {
      const a = amountForBurn(27, burn);
      expect(a - flatFeeFor(27, a)).toBeGreaterThanOrEqual(burn);
      expect(a - 1n - flatFeeFor(27, a - 1n)).toBeLessThan(burn);
    }
    // 1 USDC burned into Stellar: 1.010102 leaves 1.000001 after 0.01 + 0.000101.
    expect(amountForBurn(27, 1_000_000n)).toBe(1_010_101n);
  });

  it("lists exactly the domains Circle does not deliver to, Stellar excepted (Xebra relays it)", () => {
    expect([...CLAIM_ONLY_DOMAINS].sort((a, b) => a - b)).toEqual([8, 9, 25, 29, 30, 31]);
    expect(CLAIM_ONLY_DOMAINS).not.toContain(27);
  });
});
