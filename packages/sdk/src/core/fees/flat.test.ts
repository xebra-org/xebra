import { describe, expect, it } from "vitest";
import { CLAIM_ONLY_DOMAINS, XEBRA_FLAT_FEE, flatFeeFor, flatFeeKind } from "./flat.js";

describe("flat fee", () => {
  it("is 0.10 where the transfer arrives by itself, 0.05 where it is claimed", () => {
    expect(XEBRA_FLAT_FEE).toEqual({ deliver: 100_000n, claim: 50_000n });
    for (const delivered of [
      0, 1, 2, 3, 5, 6, 7, 10, 11, 12, 13, 14, 15, 16, 18, 19, 21, 22, 26, 27, 28, 32, 33, 37,
    ]) {
      expect(flatFeeKind(delivered)).toBe("deliver");
      expect(flatFeeFor(delivered)).toBe(100_000n);
    }
    for (const claimed of [8, 9, 25, 29, 30, 31]) {
      expect(flatFeeKind(claimed)).toBe("claim");
      expect(flatFeeFor(claimed)).toBe(50_000n);
    }
  });

  it("lists exactly the domains Circle does not deliver to, Stellar excepted (Xebra relays it)", () => {
    expect([...CLAIM_ONLY_DOMAINS].sort((a, b) => a - b)).toEqual([8, 9, 25, 29, 30, 31]);
    expect(CLAIM_ONLY_DOMAINS).not.toContain(27);
  });
});
