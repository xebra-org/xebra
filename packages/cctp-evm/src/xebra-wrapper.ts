import { type Hex, encodeFunctionData, parseAbi } from "viem";
import {
  type BurnRecipient,
  type Finality,
  ZERO_BYTES32,
  recipientAndHook,
} from "./token-messenger.js";

/**
 * Xebra's own wrapper around Circle's messenger on an EVM chain (`contracts/arc-evm`,
 * `XebraCctpWrapper`). The sender approves the wrapper and calls `bridge`; the wrapper takes Xebra's
 * fee and burns the rest through Circle with the forward hook it builds itself.
 *
 * `bridge` is selector 0x132519fe; the contract's own test pins the same number, so a change on
 * either side fails a test before it fails a transfer.
 */
export const xebraWrapperAbi = parseAbi([
  "struct BridgeRequest { uint256 amount; uint32 destinationDomain; bytes32 mintRecipient; uint256 maxFee; uint32 minFinalityThreshold; bytes32 recipientOwner; uint256 maxWrapperFee; uint64 deadline; }",
  "struct Quote { uint256 amount; uint256 fee; uint256 netBurned; uint256 forwardFee; uint256 wrapperTake; bool accountCreated; }",
  "struct Params { uint16 feeBps; uint256 minFee; uint256 minTransfer; uint256 maxTransfer; uint16 maxFastFeeBps; }",
  "struct DomainCfg { uint32 domain; bool evmStyle; uint256 maxForwardFee; bool accountCreation; uint256 maxForwardFeeNewAccount; }",
  "function bridge(BridgeRequest req) returns (Quote)",
  "function getParams() view returns (Params)",
  "function getDomains() view returns (DomainCfg[])",
  "function paused() view returns (bool)",
  "function usdc() view returns (address)",
  "function tokenMessenger() view returns (address)",
  "function localDomain() view returns (uint32)",
]);

export interface WrapperBridgeArgs {
  /** Everything the sender spends, in 6-decimal units; the recipient gets this minus the fee. */
  amount: bigint;
  destinationDomain: number;
  recipient: BurnRecipient;
  /** What Circle may keep, delivery and speed together. Paid out of Xebra's fee, not on top. */
  maxFee: bigint;
  minFinalityThreshold: Finality;
  /** The most the sender agrees to pay in all: the wrapper refuses to charge more. */
  maxWrapperFee: bigint;
  /** Unix seconds; the wrapper refuses a request at or past it, or more than an hour ahead. */
  deadline: bigint;
}

export function encodeWrapperBridge(args: WrapperBridgeArgs): Hex {
  if (args.amount <= 0n) throw new Error("amount must be positive");
  if (args.maxFee <= 0n || args.maxFee >= args.amount) {
    throw new Error("maxFee must be positive and less than the amount");
  }
  if (args.maxWrapperFee < args.maxFee || args.maxWrapperFee >= args.amount) {
    throw new Error("maxWrapperFee must cover maxFee and be less than the amount");
  }
  if (args.minFinalityThreshold !== 1000 && args.minFinalityThreshold !== 2000) {
    throw new Error("minFinalityThreshold must be 1000 (Fast) or 2000 (Standard)");
  }
  // The wrapper always asks Circle to forward, and Circle does not forward to Stellar.
  if (typeof args.recipient !== "string" && args.recipient.kind === "stellar") {
    throw new Error("Xebra's wrapper cannot send to Stellar; burn to Circle directly");
  }
  // The same recipient rules as a direct burn; the wrapper builds the hook from the owner itself.
  const { mintRecipient } = recipientAndHook(args.recipient, args.destinationDomain);
  const owner = typeof args.recipient === "string" ? undefined : args.recipient.createAccountFor;
  return encodeFunctionData({
    abi: xebraWrapperAbi,
    functionName: "bridge",
    args: [
      {
        amount: args.amount,
        destinationDomain: args.destinationDomain,
        mintRecipient,
        maxFee: args.maxFee,
        minFinalityThreshold: args.minFinalityThreshold,
        recipientOwner: (owner?.toLowerCase() as Hex | undefined) ?? ZERO_BYTES32,
        maxWrapperFee: args.maxWrapperFee,
        deadline: args.deadline,
      },
    ],
  });
}
