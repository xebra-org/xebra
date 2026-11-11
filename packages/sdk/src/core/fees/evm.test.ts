import { describe, expect, it } from "vitest";
import {
  type FeeTier,
  type WrapperTerms,
  minimumEvmAmount,
  planEvmFee,
  planWrapperFee,
  speedFeeFor,
  suggestedEvmMinimum,
  wrapperSplit,
} from "./evm.js";

const ARC = { name: "Arc", maxForwardFeeUnits: 100_000 };
/** A destination where delivery is dear, to exercise a higher ceiling. */
const COSTLY = { name: "Costly Chain", maxForwardFeeUnits: 5_000_000 };
// Iris, Base to Arc, 2026-10-09.
const STANDARD: FeeTier = { finalityThreshold: 2000, high: 16_778, minimumFeePpb: 0 };
const FAST: FeeTier = { finalityThreshold: 1000, high: 16_778, minimumFeePpb: 32_500 };

describe("speedFeeFor", () => {
  it("is zero for Standard", () => {
    expect(speedFeeFor(1_000_000_000n, 0)).toBe(0n);
  });

  it("is the quoted fraction of the amount", () => {
    // 0.325 bps of 1,000 USDC is 0.0325 USDC.
    expect(speedFeeFor(1_000_000_000n, 32_500)).toBe(32_500n);
  });

  it("rounds up, so the fee signed is never a unit short of the fee owed", () => {
    // 0.325 bps of 10 USDC is 325 units exactly; of 10.000001 it is 325.0000325.
    expect(speedFeeFor(10_000_000n, 32_500)).toBe(325n);
    expect(speedFeeFor(10_000_001n, 32_500)).toBe(326n);
    expect(speedFeeFor(1n, 32_500)).toBe(1n);
  });
});

describe("planEvmFee", () => {
  it("signs Circle's high delivery fee at 1.0x for Standard, and mints the rest", () => {
    expect(planEvmFee({ amount: 5_000_000n, tier: STANDARD, destination: ARC })).toEqual({
      ok: true,
      maxFee: 16_778n,
      deliveryFee: 16_778n,
      speedFee: 0n,
      // No contract of ours on a direct route: Circle's fee is the whole fee.
      xebraFee: 0n,
      fee: 16_778n,
      received: 4_983_222n,
    });
  });

  it("adds the speed fee for Fast", () => {
    const plan = planEvmFee({ amount: 1_000_000_000n, tier: FAST, destination: ARC });
    expect(plan).toMatchObject({ ok: true, deliveryFee: 16_778n, speedFee: 32_500n });
    if (plan.ok) {
      expect(plan.maxFee).toBe(49_278n);
      expect(plan.received).toBe(1_000_000_000n - 49_278n);
    }
  });

  it("allows a delivery fee exactly at the destination's limit and refuses one unit over", () => {
    const at = { ...STANDARD, high: 100_000 };
    expect(planEvmFee({ amount: 50_000_000n, tier: at, destination: ARC }).ok).toBe(true);
    const over = planEvmFee({
      amount: 50_000_000n,
      tier: { ...STANDARD, high: 100_001 },
      destination: ARC,
    });
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.kind).toBe("cap");
      expect(over.reason).toBe(
        "Circle's delivery fee (0.100001 USDC) is above the limit we allow for Arc right now (0.10 USDC). Try again shortly.",
      );
    }
  });

  it("gives a costlier destination its own, higher limit", () => {
    // About what Iris quoted for Arc to Ethereum on 2026-10-09: 1.38 USDC.
    const tier = { ...STANDARD, high: 1_376_978 };
    expect(planEvmFee({ amount: 50_000_000n, tier, destination: COSTLY }).ok).toBe(true);
    expect(planEvmFee({ amount: 50_000_000n, tier, destination: ARC }).ok).toBe(false);
  });

  it("refuses a transfer the fees would take more than a tenth of, and says how much to send", () => {
    const tiny = planEvmFee({ amount: 100_000n, tier: STANDARD, destination: ARC });
    expect(tiny.ok).toBe(false);
    if (!tiny.ok) {
      expect(tiny.kind).toBe("minimum");
      expect(tiny.reason).toBe(
        "Fees would take more than a tenth of this transfer. Send at least 0.18 USDC to Arc.",
      );
    }
  });

  it("applies the tenth rule exactly at the boundary", () => {
    // Fees of 16,778 are a tenth of 167,780.
    expect(planEvmFee({ amount: 167_780n, tier: STANDARD, destination: ARC }).ok).toBe(true);
    expect(planEvmFee({ amount: 167_779n, tier: STANDARD, destination: ARC }).ok).toBe(false);
  });

  it("refuses nothing-to-send and an unreadable quote in a sentence", () => {
    expect(planEvmFee({ amount: 0n, tier: STANDARD, destination: ARC })).toEqual({
      ok: false,
      kind: "amount",
      reason: "Enter an amount to send.",
    });
    const bad = planEvmFee({
      amount: 5_000_000n,
      tier: { ...STANDARD, high: 0 },
      destination: ARC,
    });
    expect(bad.ok).toBe(false);
  });
});

describe("minimumEvmAmount", () => {
  it("is the smallest amount the rule accepts, for either speed", () => {
    for (const tier of [STANDARD, FAST]) {
      const min = minimumEvmAmount(tier);
      expect(planEvmFee({ amount: min, tier, destination: ARC }).ok).toBe(true);
      expect(planEvmFee({ amount: min - 1n, tier, destination: ARC }).ok).toBe(false);
    }
    expect(minimumEvmAmount(STANDARD)).toBe(167_780n);
  });

  it("is about fourteen dollars when delivery costs 1.38 USDC", () => {
    const min = minimumEvmAmount({ ...STANDARD, high: 1_376_978 });
    expect(min).toBe(13_769_780n);
    expect(suggestedEvmMinimum(min)).toBe(14_460_000n);
  });
});

describe("planWrapperFee", () => {
  const toBaseCaps = {
    maxForwardFee: 500_000n,
    accountCreation: false,
    maxForwardFeeNewAccount: 0n,
  };
  /** The wrapper's mainnet settings: Stellar's fee, at most 100 USDC per transfer. */
  const terms: WrapperTerms = {
    paused: false,
    feeBps: 10,
    minFee: 300_000n,
    minTransfer: 1_000_000n,
    maxTransfer: 100_000_000n,
    maxFastFeeBps: 5,
    domain: toBaseCaps,
  };
  const toBase = { name: "Base", maxForwardFeeUnits: 500_000 };
  const standard = (high: number): FeeTier => ({ finalityThreshold: 2000, high, minimumFeePpb: 0 });
  const plan = (
    amount: bigint,
    high: number,
    over: Partial<WrapperTerms> = {},
    opensAccount = false,
  ) =>
    planWrapperFee({
      amount,
      tier: standard(high),
      destination: toBase,
      terms: { ...terms, ...over },
      opensAccount,
      sourceName: "Arc",
    });

  it("prices what the contract charged on Arc testnet, to the unit", () => {
    // 2026-10-14, Arc testnet -> Base Sepolia: Circle quoted 0.054099, the wrapper kept 0.245901
    // and the recipient was minted exactly 1.70.
    expect(plan(2_000_000n, 54_099)).toEqual({
      ok: true,
      maxFee: 54_099n,
      deliveryFee: 54_099n,
      speedFee: 0n,
      xebraFee: 245_901n,
      fee: 300_000n,
      received: 1_700_000n,
    });
  });

  it("charges Circle's fee alone, and keeps nothing, when it is above Xebra's", () => {
    const opening = { ...toBaseCaps, accountCreation: true, maxForwardFeeNewAccount: 1_000_000n };
    const p = plan(10_000_000n, 450_000, { domain: opening }, true);
    expect(p.ok && [p.fee, p.xebraFee, p.received]).toEqual([450_000n, 0n, 9_550_000n]);
  });

  it("refuses what the contract refuses, and says why", () => {
    expect(plan(2_000_000n, 54_099, { paused: true })).toMatchObject({ ok: false, kind: "cap" });
    expect(plan(2_000_000n, 54_099, { domain: null })).toMatchObject({ ok: false, kind: "cap" });
    expect(plan(2_000_000n, 54_099, {}, true)).toMatchObject({ ok: false, kind: "cap" });
    expect(
      plan(2_000_000n, 54_099, { domain: { ...toBaseCaps, maxForwardFee: 50_000n } }),
    ).toMatchObject({
      ok: false,
      kind: "cap",
    });
    expect(plan(100_000_001n, 54_099)).toMatchObject({ ok: false, kind: "maximum" });
  });

  it("names a minimum the contract would accept", () => {
    const below = plan(500_000n, 54_099);
    expect(below).toMatchObject({ ok: false, kind: "minimum" });
    const figure = (below as { reason: string }).reason.match(/least ([\d.]+)/)?.[1] ?? "0";
    const named = BigInt(Math.round(Number(figure) * 1e6));
    expect(named).toBeGreaterThan(0n);
    expect(plan(named, 54_099).ok).toBe(true);
  });

  it("allows Fast its speed fee on top of the destination's cap", () => {
    const capped = { domain: { ...toBaseCaps, maxForwardFee: 290_000n } };
    const fast: FeeTier = { finalityThreshold: 1000, high: 280_000, minimumFeePpb: 100_000 };
    const p = planWrapperFee({
      amount: 100_000_000n,
      tier: fast,
      destination: toBase,
      terms: { ...terms, ...capped },
      opensAccount: false,
      sourceName: "Arc",
    });
    // 0.28 delivery + 0.01 speed = 0.29: over the 0.29 cap by nothing, and within the 5 bps allowance.
    expect(p.ok).toBe(true);
  });

  it("agrees with the contract's split on every amount", () => {
    for (const [amount, maxFee] of [
      [1_000_000n, 1n],
      [3_000_000n, 285_520n],
      [100_000_000n, 2_000_000n],
      [400_000_000n, 60_000n],
    ] as const) {
      const s = wrapperSplit(amount, maxFee, terms);
      if (!s) continue;
      expect(s.xebraFee + s.netBurned).toBe(amount);
      expect(s.netBurned - maxFee).toBe(amount - s.fee);
    }
  });
});
