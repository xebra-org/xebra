import {
  FINALITY,
  encodeApprove,
  encodeDepositForBurnWithHook,
  encodeWrapperBridge,
} from "@xebra/cctp-evm";
import { describe, expect, it } from "vitest";
import { EVM_CHAINS } from "../core/chains/evm.js";
import { XebraError } from "../errors.js";
import { EvmBuildError, buildEvmBridge, evmBurnCall } from "./evm.js";

const base = EVM_CHAINS.base;
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const WRAPPER = "0x2222222222222222222222222222222222222222";
const NOW = 1_800_000_000;
const INPUT = {
  source: base,
  from: "0x3333333333333333333333333333333333333333",
  destination: { cctpDomainId: 26 },
  recipient: RECIPIENT,
  amount: 10_000_000n,
  maxFee: 50_000n,
  finality: FINALITY.standard,
  via: null,
  deadline: BigInt(NOW + 1800),
  now: NOW,
} as const;

describe("buildEvmBridge", () => {
  it("is only the burn when the allowance already covers the amount", () => {
    const steps = buildEvmBridge({ ...INPUT, allowance: 10_000_000n });
    expect(steps.map((s) => s.id)).toEqual(["burn"]);
    const [burn] = steps;
    expect(burn?.chain).toBe("base");
    expect(burn?.tx).toEqual({
      kind: "evm",
      chainId: base.chainId,
      to: base.tokenMessengerAddress,
      data: encodeDepositForBurnWithHook({
        amount: INPUT.amount,
        destinationDomain: 26,
        recipient: RECIPIENT,
        burnToken: base.usdcAddress,
        maxFee: INPUT.maxFee,
        minFinalityThreshold: FINALITY.standard,
      }),
      value: "0",
    });
  });

  it("approves Circle's messenger for exactly the amount first when the allowance is short", () => {
    const steps = buildEvmBridge({ ...INPUT, allowance: 9_999_999n });
    expect(steps.map((s) => s.id)).toEqual(["approve", "burn"]);
    expect(steps[0]?.tx).toEqual({
      kind: "evm",
      chainId: base.chainId,
      to: base.usdcAddress,
      data: encodeApprove(base.tokenMessengerAddress, INPUT.amount),
      value: "0",
    });
  });

  it("targets the wrapper, for approval and burn, when sending through it", () => {
    const via = { address: WRAPPER, maxWrapperFee: 400_000n };
    const steps = buildEvmBridge({ ...INPUT, via, allowance: 0n });
    expect(steps[0]?.tx).toMatchObject({ data: encodeApprove(WRAPPER, INPUT.amount) });
    expect(steps[1]?.tx).toMatchObject({
      to: WRAPPER,
      data: encodeWrapperBridge({
        amount: INPUT.amount,
        destinationDomain: 26,
        recipient: RECIPIENT,
        maxFee: INPUT.maxFee,
        minFinalityThreshold: FINALITY.standard,
        maxWrapperFee: via.maxWrapperFee,
        deadline: INPUT.deadline,
      }),
    });
  });

  it("dates the wrapper burn by its deadline and leaves a direct burn undated", () => {
    const via = { address: WRAPPER, maxWrapperFee: 400_000n };
    const wrapped = buildEvmBridge({ ...INPUT, via, allowance: INPUT.amount });
    expect(wrapped[0]?.expiresAt).toBe(new Date(Number(INPUT.deadline) * 1000).toISOString());
    expect(buildEvmBridge({ ...INPUT, allowance: INPUT.amount })[0]?.expiresAt).toBeNull();
  });

  it("refuses an encoding the contract would revert, before anything is signed", () => {
    expect(() => evmBurnCall({ ...INPUT, maxFee: INPUT.amount }, 0n)).toThrow(/maxFee/);
  });

  describe("wrapper deadline validation", () => {
    const via = { address: WRAPPER, maxWrapperFee: 400_000n };

    it("accepts a valid deadline within the next hour", () => {
      const now = 1_000_000;
      const deadline = BigInt(now + 1800);
      expect(() => evmBurnCall({ ...INPUT, via }, deadline, { now })).not.toThrow();
      const steps = buildEvmBridge({ ...INPUT, via, allowance: INPUT.amount, deadline, now });
      expect(steps[0]?.expiresAt).toBe(new Date(Number(deadline) * 1000).toISOString());
    });

    it("rejects a deadline in the past or at now", () => {
      const now = 1_000_000;
      expect(() => evmBurnCall({ ...INPUT, via }, BigInt(now), { now })).toThrow(
        "deadline must be in seconds, between now and one hour from now",
      );
      expect(() => evmBurnCall({ ...INPUT, via }, BigInt(now - 1), { now })).toThrow(
        "deadline must be in seconds, between now and one hour from now",
      );
      expect(() =>
        buildEvmBridge({ ...INPUT, via, allowance: INPUT.amount, deadline: BigInt(now - 10), now }),
      ).toThrow(
        expect.objectContaining({
          code: "invalid_request",
          message: "deadline must be in seconds, between now and one hour from now",
        }),
      );
    });

    it("rejects a deadline more than one hour ahead", () => {
      const now = 1_000_000;
      const deadline = BigInt(now + 3601);
      expect(() => evmBurnCall({ ...INPUT, via }, deadline, { now })).toThrow(
        "deadline must be in seconds, between now and one hour from now",
      );
      expect(() =>
        buildEvmBridge({ ...INPUT, via, allowance: INPUT.amount, deadline, now }),
      ).toThrow(
        expect.objectContaining({
          code: "invalid_request",
          message: "deadline must be in seconds, between now and one hour from now",
        }),
      );
    });

    it("rejects a deadline passed in milliseconds", () => {
      const now = 1_000_000;
      const deadline = BigInt(now * 1000);
      expect(() => evmBurnCall({ ...INPUT, via }, deadline, { now })).toThrow(
        "deadline must be in seconds, between now and one hour from now",
      );
      expect(() =>
        buildEvmBridge({ ...INPUT, via, allowance: INPUT.amount, deadline, now }),
      ).toThrow(
        expect.objectContaining({
          code: "invalid_request",
          message: "deadline must be in seconds, between now and one hour from now",
        }),
      );
    });

    it("throws an EvmBuildError, a XebraError naming the deadline field", () => {
      const now = 1_000_000;
      let caught: unknown;
      try {
        evmBurnCall({ ...INPUT, via }, BigInt(now - 1), { now });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EvmBuildError);
      expect(caught).toBeInstanceOf(XebraError);
      expect(caught).toMatchObject({
        code: "invalid_request",
        field: "deadline",
        retryable: false,
      });
    });

    it("takes the chain's timestamp as now, not this machine's clock", () => {
      // A chain block far from Date.now(): the deadline is judged against the chain.
      const chainNow = 1_800_000_000n;
      expect(() =>
        evmBurnCall({ ...INPUT, via }, chainNow + 600n, { now: chainNow }),
      ).not.toThrow();
      expect(() =>
        evmBurnCall({ ...INPUT, via }, chainNow + 3600n, { now: chainNow }),
      ).not.toThrow();
      expect(() => evmBurnCall({ ...INPUT, via }, chainNow + 3601n, { now: chainNow })).toThrow(
        EvmBuildError,
      );
    });

    it("defaults now to this machine's clock", () => {
      const current = BigInt(Math.floor(Date.now() / 1000));
      expect(() => evmBurnCall({ ...INPUT, via }, current + 600n)).not.toThrow();
      expect(() => evmBurnCall({ ...INPUT, via }, current - 1n)).toThrow(EvmBuildError);
    });

    it("skips only the deadline check for a dry-run encode", () => {
      expect(() => evmBurnCall({ ...INPUT, via }, 0n, { checkDeadline: false })).not.toThrow();
      // Every other argument is still checked.
      expect(() =>
        evmBurnCall({ ...INPUT, via, maxFee: INPUT.amount }, 0n, { checkDeadline: false }),
      ).toThrow(/maxFee/);
    });

    it("never checks the deadline straight to Circle", () => {
      expect(() => evmBurnCall({ ...INPUT, via: null }, 0n, { now: 1_000_000 })).not.toThrow();
    });
  });
});
