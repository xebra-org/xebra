import { describe, expect, it } from "vitest";
import { decodeUint256, encodeApprove } from "./erc20.js";
import { CctpEvmError } from "./errors.js";
import {
  FINALITY,
  ZERO_BYTES32,
  encodeDepositForBurnWithHook,
  forwardHookWithAccount,
} from "./token-messenger.js";
import { encodeWrapperBridge } from "./xebra-wrapper.js";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const ATA = `0x${"ab".repeat(32)}` as const;

/** The code of the error `fn` throws, or `undefined` if it throws nothing. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

const burn = (over: Partial<Parameters<typeof encodeDepositForBurnWithHook>[0]> = {}) =>
  encodeDepositForBurnWithHook({
    amount: 5_000_000n,
    destinationDomain: 26,
    recipient: RECIPIENT,
    burnToken: BASE_USDC,
    maxFee: 16_778n,
    minFinalityThreshold: FINALITY.standard,
    ...over,
  });

const bridge = (over: Partial<Parameters<typeof encodeWrapperBridge>[0]> = {}) =>
  encodeWrapperBridge({
    amount: 2_000_000n,
    destinationDomain: 6,
    recipient: RECIPIENT,
    maxFee: 54_099n,
    minFinalityThreshold: 2000,
    maxWrapperFee: 300_000n,
    deadline: 1_800_000_000n,
    ...over,
  });

describe("CctpEvmError", () => {
  it("is an Error with a name and a code a caller can branch on", () => {
    const error = new CctpEvmError("invalid_amount", "amount must be positive");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CctpEvmError);
    expect(error.name).toBe("CctpEvmError");
    expect(error.code).toBe("invalid_amount");
    expect(error.message).toBe("amount must be positive");
    expect(error.retryable).toBe(false);
  });
});

describe("error codes", () => {
  it("labels a bad amount or fee invalid_amount", () => {
    expect(codeOf(() => burn({ amount: 0n }))).toBe("invalid_amount");
    expect(codeOf(() => burn({ maxFee: 5_000_000n }))).toBe("invalid_amount");
    expect(codeOf(() => bridge({ amount: 0n }))).toBe("invalid_amount");
    expect(codeOf(() => bridge({ maxFee: 0n }))).toBe("invalid_amount");
    expect(codeOf(() => bridge({ maxWrapperFee: 1n }))).toBe("invalid_amount");
    expect(codeOf(() => encodeApprove(RECIPIENT, 0n))).toBe("invalid_amount");
  });

  it("labels a bad recipient, owner or hook invalid_recipient", () => {
    expect(codeOf(() => burn({ recipient: "0x1234" }))).toBe("invalid_recipient");
    expect(codeOf(() => burn({ recipient: `0x${"00".repeat(20)}` }))).toBe("invalid_recipient");
    expect(codeOf(() => burn({ destinationDomain: 5 }))).toBe("invalid_recipient");
    expect(codeOf(() => burn({ destinationDomain: 27 }))).toBe("invalid_recipient");
    expect(
      codeOf(() =>
        burn({ destinationDomain: 5, recipient: { kind: "solana", tokenAccount: ZERO_BYTES32 } }),
      ),
    ).toBe("invalid_recipient");
    expect(
      codeOf(() =>
        burn({
          destinationDomain: 5,
          recipient: { kind: "solana", tokenAccount: ATA, createAccountFor: ATA },
        }),
      ),
    ).toBe("invalid_recipient");
    expect(codeOf(() => forwardHookWithAccount("0x1234"))).toBe("invalid_recipient");
    expect(codeOf(() => forwardHookWithAccount(ZERO_BYTES32))).toBe("invalid_recipient");
    expect(
      codeOf(() =>
        bridge({
          destinationDomain: 27,
          recipient: { kind: "stellar", forwarder: ATA, hookData: "0x00" },
        }),
      ),
    ).toBe("invalid_recipient");
  });

  it("labels any other rejected argument invalid_request", () => {
    expect(codeOf(() => burn({ minFinalityThreshold: 1500 as never }))).toBe("invalid_request");
    expect(codeOf(() => burn({ burnToken: "USDC" }))).toBe("invalid_request");
    expect(codeOf(() => bridge({ minFinalityThreshold: 1500 as never }))).toBe("invalid_request");
    expect(codeOf(() => decodeUint256("0x"))).toBe("invalid_request");
  });
});
