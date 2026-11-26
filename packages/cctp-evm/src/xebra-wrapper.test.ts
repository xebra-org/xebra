import { decodeFunctionData, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { ZERO_BYTES32 } from "./token-messenger.js";
import { encodeWrapperBridge, xebraWrapperAbi } from "./xebra-wrapper.js";

const RECIPIENT = "0x714dBB9B25feB56d7C570De89b9f8E87249C0155";
const TOKEN_ACCOUNT = `0x${"ab".repeat(32)}` as const;
const OWNER = `0x${"cd".repeat(32)}` as const;

const base = {
  amount: 2_000_000n,
  destinationDomain: 6,
  recipient: RECIPIENT,
  maxFee: 54_099n,
  minFinalityThreshold: 2000 as const,
  maxWrapperFee: 300_000n,
  deadline: 1_800_000_000n,
};

describe("encodeWrapperBridge", () => {
  it("calls the selector the contract's own test pins", () => {
    // contracts/arc-evm/test/XebraCctpWrapper.t.sol asserts the same number.
    expect(
      toFunctionSelector("bridge((uint256,uint32,bytes32,uint256,uint32,bytes32,uint256,uint64))"),
    ).toBe("0x132519fe");
    expect(encodeWrapperBridge(base).slice(0, 10)).toBe("0x132519fe");
  });

  it("sends an EVM recipient left-padded, with no owner", () => {
    const { args } = decodeFunctionData({ abi: xebraWrapperAbi, data: encodeWrapperBridge(base) });
    const [req] = args as unknown as [Record<string, unknown>];
    expect(req.mintRecipient).toBe(`0x${"00".repeat(12)}${RECIPIENT.slice(2).toLowerCase()}`);
    expect(req.recipientOwner).toBe(ZERO_BYTES32);
    expect(req.amount).toBe(2_000_000n);
    expect(req.maxFee).toBe(54_099n);
    expect(req.maxWrapperFee).toBe(300_000n);
    expect(req.deadline).toBe(1_800_000_000n);
  });

  it("names the owner only when Circle is to open the Solana account", () => {
    const opened = decodeFunctionData({
      abi: xebraWrapperAbi,
      data: encodeWrapperBridge({
        ...base,
        destinationDomain: 5,
        recipient: { kind: "solana", tokenAccount: TOKEN_ACCOUNT, createAccountFor: OWNER },
        maxFee: 285_520n,
      }),
    });
    const [req] = opened.args as unknown as [Record<string, unknown>];
    expect(req.mintRecipient).toBe(TOKEN_ACCOUNT);
    expect(req.recipientOwner).toBe(OWNER);

    const existing = decodeFunctionData({
      abi: xebraWrapperAbi,
      data: encodeWrapperBridge({
        ...base,
        destinationDomain: 5,
        recipient: { kind: "solana", tokenAccount: TOKEN_ACCOUNT },
        maxFee: 130_086n,
      }),
    });
    expect((existing.args as unknown as [Record<string, unknown>])[0].recipientOwner).toBe(
      ZERO_BYTES32,
    );
  });

  it("refuses what the contract would refuse, before a wallet is asked", () => {
    expect(() => encodeWrapperBridge({ ...base, maxFee: 0n })).toThrow(/maxFee/);
    expect(() => encodeWrapperBridge({ ...base, maxWrapperFee: 1n })).toThrow(/maxWrapperFee/);
    expect(() =>
      encodeWrapperBridge({ ...base, minFinalityThreshold: 1500 as unknown as 2000 }),
    ).toThrow(/Finality/i);
    expect(() => encodeWrapperBridge({ ...base, destinationDomain: 5 })).toThrow(/Solana/);
  });

  it("refuses Sui: the wrapper always asks Circle to forward, and Circle does not deliver there", () => {
    expect(() =>
      encodeWrapperBridge({
        ...base,
        destinationDomain: 8,
        recipient: { kind: "sui", address: TOKEN_ACCOUNT },
      }),
    ).toThrow(/cannot send to Sui/);
    expect(() => encodeWrapperBridge({ ...base, destinationDomain: 8 })).toThrow(/Sui/);
  });
});
