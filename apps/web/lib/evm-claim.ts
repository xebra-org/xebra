import { decodeUint256, encodeReceiveMessage, messageTransmitterAbi } from "@xebra/cctp-evm";
import { encodeFunctionData } from "viem";
import {
  type ChainTarget,
  ensureChain,
  ethCall,
  sendTransaction,
  waitForReceipt,
  walletErrorCode,
} from "./evm-rpc";
import { formatError } from "./format-error";
import type { Eip1193Provider } from "./wallets/types";

/**
 * Completing a transfer to an EVM chain from the browser, without us.
 *
 * The EVM half of `lib/claim.ts`, and the same promise: Circle's `(message, attestation)` pair is
 * public, `destination_caller` is zero, so any wallet may submit `receiveMessage` and the mint
 * lands on whoever the burn named. Circle's forwarding service pays the gas as a convenience; this
 * is the version where you pay it. It began as the Arc claim and is the same four calls on every
 * EVM chain, because Circle's transmitter is the same contract on each.
 *
 * # It sends the calldata the forwarder would
 *
 * `encodeReceiveMessage` from `@xebra/cctp-evm`, unchanged. A browser-only encoding is how the two
 * quietly diverge.
 *
 * # No wagmi, no connector library
 *
 * This talks to the injected EIP-1193 provider directly. The app used to carry wagmi and shed it
 * (see `next.config.ts`) because a bridge that needed an EVM connector to *build* was not worth
 * its dependency tree; a claim page needs four JSON-RPC helpers, and they are in `lib/evm-rpc.ts`,
 * which the EVM transfer shares.
 *
 * # The order matters
 *
 * The wallet is put on the destination chain *first*. Circle's transmitter has the same address on
 * every chain, so asking "is this nonce used?" on the wrong one does not fail: another chain's
 * transmitter answers, truthfully, that it has never seen it.
 *
 * # Who pays
 *
 * The connected wallet, in the destination chain's gas. The payer need not be the recipient: the
 * mint goes to the address the burn named, whoever submits it.
 */

/** Where and how to submit a mint by hand. Served by `/api/attestation` from the pinned table. */
export interface EvmClaimTarget extends ChainTarget {
  messageTransmitter: string;
  /** What the gas costs here, said plainly. */
  claimCost: string;
}

/** Switches the wallet to the destination, adding the network first if it has never seen it. */
export function ensureClaimNetwork(
  provider: Eip1193Provider,
  target: EvmClaimTarget,
): Promise<void> {
  return ensureChain(provider, target);
}

/**
 * Whether Circle's transmitter has already consumed this message's nonce.
 *
 * Worth asking before a wallet prompt because the likeliest reason to be on this page with a
 * working attestation is that Circle's forwarding got there first — and "already minted, nothing to do" is
 * a much better thing to be told than a wallet's opaque "transaction will fail" warning.
 *
 * The nonce is bytes 12..44 of the V2 message header (`version | source | destination | nonce`).
 *
 * Only meaningful once the wallet is on the destination chain (`ensureClaimNetwork`).
 */
export async function isAlreadyMinted(
  provider: Eip1193Provider,
  target: { messageTransmitter: string },
  message: `0x${string}`,
): Promise<boolean> {
  const nonce = `0x${message.slice(2 + 12 * 2, 2 + 44 * 2)}`;
  const data = encodeFunctionData({
    abi: messageTransmitterAbi,
    functionName: "usedNonces",
    args: [nonce as `0x${string}`],
  });
  return decodeUint256(await ethCall(provider, target.messageTransmitter, data)) !== 0n;
}

export type ClaimCheck =
  | { ok: true }
  /** A Fast burn's attestation has run out. Circle signs a fresh one on request. */
  | { ok: false; expired: true }
  | { ok: false; expired: false; reason: string };

/** Circle's `MessageTransmitterV2` revert for a Fast attestation past its `expirationBlock`. */
const CIRCLE_EXPIRED = "Message expired and must be re-signed";

/**
 * Whether the chain refused the call, as opposed to the wallet or its node failing to ask. Code 3
 * is the JSON-RPC answer for a revert; not every node uses it, but every one says "revert".
 */
function isRevert(err: unknown, reason: string): boolean {
  return walletErrorCode(err) === 3 || /\brevert/i.test(reason);
}

/**
 * Runs the mint as the paying wallet without sending it, to learn whether it would succeed.
 *
 * This is how an expired attestation is recognised: by the chain saying so. Reading the message's
 * `expirationBlock` and comparing block numbers would be less work and wrong on a rollup, where
 * the block number a contract sees is not the one the RPC reports.
 *
 * Only a revert is an answer. When the call itself fails (no network, a node error) this throws
 * "Could not check", because nothing was learned about the mint.
 */
export async function checkClaim(
  provider: Eip1193Provider,
  target: { messageTransmitter: string },
  from: string,
  message: `0x${string}`,
  attestation: `0x${string}`,
): Promise<ClaimCheck> {
  try {
    await ethCall(
      provider,
      target.messageTransmitter,
      encodeReceiveMessage(message, attestation),
      from,
    );
    return { ok: true };
  } catch (err) {
    const reason = formatError(err);
    if (reason.includes(CIRCLE_EXPIRED)) return { ok: false, expired: true };
    if (isRevert(err, reason)) return { ok: false, expired: false, reason };
    // A dropped connection or a node error says nothing about the mint, so it is not "would fail".
    throw new Error(
      `Could not check the mint: ${reason.replace(/\.$/, "")}. Nothing was sent; try again.`,
      {
        cause: err,
      },
    );
  }
}

export async function sendClaim(
  provider: Eip1193Provider,
  target: { messageTransmitter: string; chainId?: number },
  from: string,
  message: `0x${string}`,
  attestation: `0x${string}`,
): Promise<string> {
  return sendTransaction(provider, {
    from,
    to: target.messageTransmitter,
    data: encodeReceiveMessage(message, attestation),
    ...(target.chainId === undefined ? {} : { chainId: target.chainId }),
  });
}

/**
 * Polls the wallet's own node. Arc finalises in under a second and a busy chain can take minutes at
 * a low fee, so the ceiling is generous; it is for a bad RPC, not for the chain.
 */
export async function waitForClaim(
  provider: Eip1193Provider,
  hash: string,
  timeoutMs = 5 * 60_000,
): Promise<"success" | "reverted"> {
  return waitForReceipt(provider, hash, { timeoutMs });
}
