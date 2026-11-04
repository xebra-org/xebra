import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { XEBRA_WRAPPERS } from "../evm-chains";
import { CONTRACTS, FEES, RECORDED_STELLAR_CAPS, usdc } from "./facts";

const record = JSON.parse(
  readFileSync(new URL("../../../../deployments/mainnet.json", import.meta.url), "utf8"),
) as {
  cctpWrapperV2: {
    contractId: string;
    params: Record<string, string | number>;
    domains: Array<{
      domain: number;
      max_forward_fee: string;
      max_forward_fee_new_account: string;
      account_creation: boolean;
    }>;
  };
  arcWrapper: { address: string; params: string };
};

describe("what the pages say about fees and contracts", () => {
  it("states the Stellar wrapper's deployed parameters", () => {
    const p = record.cctpWrapperV2.params;
    expect(Number(p.fee_bps)).toBe(FEES.bps);
    // 7-decimal stroops on Stellar.
    expect(usdc(Number(p.min_fee) / 10)).toBe(FEES.minFeeUsdc);
    expect(usdc(Number(p.min_transfer) / 10)).toBe(FEES.minTransferUsdc);
    expect(usdc(Number(p.max_transfer) / 10)).toBe(FEES.maxTransferUsdc);
  });

  it("states the Arc wrapper's deployed parameters, the same schedule", () => {
    // (feeBps, minFee, minTransfer, maxTransfer, maxFastFeeBps) in 6-decimal units.
    const [bps, minFee, minTransfer, maxTransfer] = record.arcWrapper.params
      .replace(/[()]/g, "")
      .split(",")
      .map(Number);
    expect(bps).toBe(FEES.bps);
    expect(usdc(minFee as number)).toBe(FEES.minFeeUsdc);
    expect(usdc(minTransfer as number)).toBe(FEES.minTransferUsdc);
    expect(usdc(maxTransfer as number)).toBe(FEES.maxTransferUsdc);
  });

  it("names the deployed contracts", () => {
    expect(CONTRACTS.stellarWrapper.address).toBe(record.cctpWrapperV2.contractId);
    expect(CONTRACTS.arcWrapper.address).toBe(record.arcWrapper.address);
    expect(CONTRACTS.arcWrapper.address).toBe(XEBRA_WRAPPERS.arc);
  });

  it("falls back to the caps Solana and Arc were committed with", () => {
    for (const d of record.cctpWrapperV2.domains) {
      expect(RECORDED_STELLAR_CAPS[d.domain]).toEqual({
        cap: Number(d.max_forward_fee) / 10,
        newAccount: d.account_creation ? Number(d.max_forward_fee_new_account) / 10 : null,
      });
    }
  });

  it("writes amounts the way a sentence wants them", () => {
    expect(usdc(250_000)).toBe("0.25");
    expect(usdc(300_000)).toBe("0.30");
    expect(usdc(1_000_000)).toBe("1");
    expect(usdc(54_099)).toBe("0.054099");
  });
});
