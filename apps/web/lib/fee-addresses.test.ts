import { describe, expect, it } from "vitest";
import { DEFAULT_EVM_FEE_ADDRESS, parseFeeAddresses } from "./fee-addresses";

describe("parseFeeAddresses", () => {
  it("defaults EVM to the Arc wrapper's fee recipient and leaves the rest off", () => {
    expect(parseFeeAddresses({})).toEqual({
      evm: DEFAULT_EVM_FEE_ADDRESS,
      solana: null,
      sui: null,
      aptos: null,
    });
  });

  it("takes valid addresses for every family", () => {
    const sui = `0x${"a".repeat(64)}`;
    expect(
      parseFeeAddresses({
        evm: "0x0000000000000000000000000000000000000001",
        solana: "2GiJjxVmqSSTL2yfUbVnBBDkTeXEn1DM8QM2ZrRGumte",
        sui,
        aptos: sui,
      }),
    ).toEqual({
      evm: "0x0000000000000000000000000000000000000001",
      solana: "2GiJjxVmqSSTL2yfUbVnBBDkTeXEn1DM8QM2ZrRGumte",
      sui,
      aptos: sui,
    });
  });

  it("fails loudly on a malformed address instead of charging nowhere", () => {
    expect(() => parseFeeAddresses({ evm: "0x123" })).toThrow(/EVM/);
    expect(() => parseFeeAddresses({ solana: "not-base58!" })).toThrow(/SOLANA/);
    expect(() => parseFeeAddresses({ sui: "0x12" })).toThrow(/SUI/);
    expect(() => parseFeeAddresses({ aptos: "abc" })).toThrow(/APTOS/);
  });
});
