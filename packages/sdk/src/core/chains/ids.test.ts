import { describe, expect, it } from "vitest";
import { EVM_CHAIN_IDS } from "./evm.js";
import { CHAIN_IDS, isChainId } from "./ids.js";

describe("isChainId", () => {
  it("accepts the non-EVM chains and every EVM chain", () => {
    for (const id of ["stellar", "solana", "sui", "base", "arc", "monad"]) {
      expect(isChainId(id)).toBe(true);
    }
    for (const id of EVM_CHAIN_IDS) expect(isChainId(id)).toBe(true);
  });

  it("refuses anything else, including near misses and prototype keys", () => {
    for (const id of ["Base", " base", "ethereum2", "", "__proto__", "toString", "constructor"]) {
      expect(isChainId(id)).toBe(false);
    }
  });

  it("lists each chain once", () => {
    expect(new Set(CHAIN_IDS).size).toBe(CHAIN_IDS.length);
    expect(CHAIN_IDS).toEqual(
      expect.arrayContaining(["stellar", "solana", "sui", ...EVM_CHAIN_IDS]),
    );
  });
});
