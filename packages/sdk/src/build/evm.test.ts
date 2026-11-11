import {
  FINALITY,
  encodeApprove,
  encodeDepositForBurnWithHook,
  encodeWrapperBridge,
} from "@xebra/cctp-evm";
import { describe, expect, it } from "vitest";
import { EVM_CHAINS } from "../core/chains/evm.js";
import { buildEvmBridge, evmBurnCall } from "./evm.js";

const base = EVM_CHAINS.base;
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const WRAPPER = "0x2222222222222222222222222222222222222222";
const INPUT = {
  source: base,
  from: "0x3333333333333333333333333333333333333333",
  destination: { cctpDomainId: 26 },
  recipient: RECIPIENT,
  amount: 10_000_000n,
  maxFee: 50_000n,
  finality: FINALITY.standard,
  via: null,
  deadline: 1_800_000_000n,
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
});
