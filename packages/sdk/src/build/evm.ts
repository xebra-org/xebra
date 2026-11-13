import { encodeApprove, encodeDepositForBurnWithHook, encodeWrapperBridge } from "@xebra/cctp-evm";
import type { EvmChain } from "../core/chains/evm.js";
import type { TransferStep } from "./types.js";

type Hex = `0x${string}`;

/**
 * `@xebra/cctp-evm`'s `BurnRecipient` and `Finality`, restated here: the declaration bundler does
 * not inline type-only imports from that private package, so the published `.d.ts` would point at
 * a file npm users never get. The encoders below take these values, so a drift fails to compile.
 */
export type BurnRecipient =
  | string
  | { kind: "solana"; tokenAccount: Hex; createAccountFor?: Hex | undefined }
  /** Stellar: build it with `stellarBurnRecipient("G...")`, never by hand. */
  | { kind: "stellar"; forwarder: Hex; hookData: Hex };
/** Circle's two speeds, as the finality a burn asks for: 1000 Fast, 2000 Standard. */
export type Finality = 1000 | 2000;

/** A burn from an EVM chain, straight to Circle or through Xebra's wrapper (`via`). */
export interface EvmBurnInput {
  source: EvmChain;
  destination: { cctpDomainId: number };
  /** A validated address on the destination chain, or for Solana the resolved token account. */
  recipient: BurnRecipient;
  /** 6-decimal units. */
  amount: bigint;
  /** What Circle may keep. */
  maxFee: bigint;
  finality: Finality;
  /** Send through the wrapper at this address, paying at most `maxWrapperFee` in all. */
  via: { address: string; maxWrapperFee: bigint } | null;
}

/** Who takes the USDC and is called: the wrapper, or Circle's messenger. */
export function evmBurnTarget(p: EvmBurnInput): Hex {
  return (p.via?.address ?? p.source.tokenMessengerAddress) as Hex;
}

/**
 * The burn call. Through the wrapper it carries a deadline, which callers set from the chain's
 * latest block just before asking for the signature; direct to Circle the deadline is ignored.
 * Throws for anything the contract would revert, so no wallet is asked to sign it.
 */
export function evmBurnCall(p: EvmBurnInput, deadline: bigint): { to: Hex; data: Hex } {
  const data = p.via
    ? encodeWrapperBridge({
        amount: p.amount,
        destinationDomain: p.destination.cctpDomainId,
        recipient: p.recipient,
        maxFee: p.maxFee,
        minFinalityThreshold: p.finality,
        maxWrapperFee: p.via.maxWrapperFee,
        deadline,
      })
    : encodeDepositForBurnWithHook({
        amount: p.amount,
        destinationDomain: p.destination.cctpDomainId,
        recipient: p.recipient,
        burnToken: p.source.usdcAddress,
        maxFee: p.maxFee,
        minFinalityThreshold: p.finality,
      });
  return { to: evmBurnTarget(p), data };
}

/** The allowance the burn needs: exactly the amount, to whoever `evmBurnTarget` names. */
export function evmApproveCall(p: EvmBurnInput): { to: Hex; data: Hex } {
  return { to: p.source.usdcAddress as Hex, data: encodeApprove(evmBurnTarget(p), p.amount) };
}

/**
 * The signatures an EVM transfer needs: an approval when the current allowance is short, then the
 * burn. Pure: the caller reads the allowance and picks the deadline.
 */
export function buildEvmBridge(
  p: EvmBurnInput & { from: string; allowance: bigint; deadline: bigint },
): TransferStep[] {
  const steps: TransferStep[] = [];
  const evm = (call: { to: Hex; data: Hex }) =>
    ({ kind: "evm", chainId: p.source.chainId, ...call, value: "0" }) as const;
  if (p.allowance < p.amount) {
    steps.push({
      id: "approve",
      chain: p.source.id,
      description: `Allow ${p.via ? "Xebra's wrapper" : "Circle"} to take exactly this amount of USDC on ${p.source.name}.`,
      tx: evm(evmApproveCall(p)),
      expiresAt: null,
    });
  }
  steps.push({
    id: "burn",
    chain: p.source.id,
    description: `Burn the USDC on ${p.source.name}; Circle mints it on the destination.`,
    tx: evm(evmBurnCall(p, p.deadline)),
    expiresAt: p.via ? new Date(Number(p.deadline) * 1000).toISOString() : null,
  });
  return steps;
}
