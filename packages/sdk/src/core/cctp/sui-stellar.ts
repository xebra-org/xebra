import { StrKey } from "@stellar/stellar-base";

/**
 * Sui to Stellar over CCTP V2, the parts that are pure functions: the burn's hook data, and the
 * checks a completion makes on Circle's attested message before any XLM is spent on it.
 *
 * The flow, end to end:
 *
 *  1. The Sui wallet burns USDC with `mintRecipient` set to Circle's `CctpForwarder` on Stellar and
 *     the real recipient in the hook data (`stellarForwardHook`). `destinationCaller` is the
 *     forwarder too (`burnDestinationCaller`), as Circle requires: with a zero caller anyone could call
 *     `receive_message` directly, minting into the forwarder without paying the recipient, and the USDC
 *     would be stuck for good. Anyone may still finish the transfer, because `mint_and_forward` is public.
 *  2. Circle attests the burn.
 *  3. Someone calls `mint_and_forward(message, attestation)` on the forwarder and pays the XLM fee.
 *     The forwarder mints, then pays the recipient named in the hook. Who submits does not matter.
 *
 * Everything the completion needs to trust is read out of the message, because the message is the
 * copy Circle's contracts enforce. `verifyMessage` is the "say no before pay" gate.
 */

export const SUI_DOMAIN = 8;
export const STELLAR_DOMAIN = 27;

/** Circle's CctpForwarder on Stellar mainnet (the `mintRecipient` of every burn). */
export const STELLAR_CCTP_FORWARDER = "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T";

const HOOK_HEADER = 32;

/** The forwarder's contract id as the 32 bytes a Sui `address` argument carries. */
export function forwarderAsSuiAddress(forwarder: string = STELLAR_CCTP_FORWARDER): string {
  return `0x${Buffer.from(StrKey.decodeContract(forwarder)).toString("hex")}`;
}

/**
 * The `destinationCaller` every burn to Stellar carries: the forwarder itself, so only
 * `mint_and_forward` can complete the mint. Never zero (see the flow note at the top of this file).
 */
export function burnDestinationCaller(): string {
  return forwarderAsSuiAddress();
}

/**
 * The recipient an EVM burn to Stellar names: Circle's `CctpForwarder` as the mint recipient and
 * the only caller, and the hook naming the Stellar account it pays. Pass it as `recipient` to the
 * EVM burn builders. Throws on anything but a G... account or C... contract.
 */
export function stellarBurnRecipient(recipient: string): {
  kind: "stellar";
  forwarder: `0x${string}`;
  hookData: `0x${string}`;
} {
  return {
    kind: "stellar",
    forwarder: forwarderAsSuiAddress() as `0x${string}`,
    hookData: `0x${Buffer.from(stellarForwardHook(recipient)).toString("hex")}`,
  };
}

export function isStellarRecipient(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value);
}

/**
 * Hook data the forwarder reads: a 32-byte header (version 0 at bytes 24..27, big-endian u32 length
 * at 28..31) followed by the recipient's StrKey as UTF-8 text. Byte-for-byte what
 * `@asctp/parabola`'s `encodeStellarForwardHook` produces.
 */
export function stellarForwardHook(recipient: string): Uint8Array {
  if (!isStellarRecipient(recipient)) throw new Error(`Invalid Stellar address: ${recipient}`);
  const body = Buffer.from(recipient, "utf8");
  const hook = Buffer.alloc(HOOK_HEADER + body.length);
  hook.writeUInt32BE(0, 24);
  hook.writeUInt32BE(body.length, 28);
  body.copy(hook, HOOK_HEADER);
  return hook;
}

export interface ParsedMessage {
  sourceDomain: number;
  destinationDomain: number;
  /** The destination chain's TokenMessenger, as the 32 bytes the message carries. */
  destinationTokenMessenger: Buffer;
  destinationCaller: Buffer;
  mintRecipient: Buffer;
  /** Base units, 6 decimals. */
  amount: bigint;
  hookData: Buffer;
}

// CCTP V2 message layout (Circle's `MessageV2` and `BurnMessageV2`).
const HEADER_LENGTH = 148;
const BODY_FIXED_LENGTH = 228;

/** Reads the fields a completion cares about. Throws on anything that is not a V2 burn message. */
export function parseMessage(message: Uint8Array): ParsedMessage {
  const m = Buffer.from(message);
  if (m.length < HEADER_LENGTH + BODY_FIXED_LENGTH) throw new Error("message is too short");
  if (m.readUInt32BE(0) !== 1) throw new Error("not a CCTP V2 message");
  const body = m.subarray(HEADER_LENGTH);
  if (body.readUInt32BE(0) !== 1) throw new Error("not a CCTP V2 burn message");
  const amount = BigInt(`0x${body.subarray(68, 100).toString("hex")}`);
  return {
    sourceDomain: m.readUInt32BE(4),
    destinationDomain: m.readUInt32BE(8),
    destinationTokenMessenger: Buffer.from(m.subarray(76, 108)),
    destinationCaller: Buffer.from(m.subarray(108, 140)),
    mintRecipient: Buffer.from(body.subarray(36, 68)),
    amount,
    hookData: Buffer.from(body.subarray(BODY_FIXED_LENGTH)),
  };
}

export interface VerifiedBurn {
  amount: bigint;
  /** The chain the USDC was burned on, as Circle's domain. */
  sourceDomain: number;
  /** The Stellar address the forwarder will pay, read from the hook data and nowhere else. */
  recipient: string;
}

/**
 * Refuses anything that is not a USDC burn from an allowed chain (`sources`, Sui unless told
 * otherwise), aimed at Stellar's token messenger, minting to our forwarder, with a well-formed hook.
 * Returns the recipient the forwarder will actually pay.
 */
export function verifyMessage(
  message: Uint8Array,
  opts: { tokenMessenger: string; forwarder?: string; sources?: readonly number[] },
): VerifiedBurn {
  const p = parseMessage(message);
  const forwarder = opts.forwarder ?? STELLAR_CCTP_FORWARDER;
  const sources = opts.sources ?? [SUI_DOMAIN];

  if (!sources.includes(p.sourceDomain)) {
    throw new Error(
      sources.length === 1 && sources[0] === SUI_DOMAIN
        ? "not a burn from Sui"
        : "not a burn from an allowed chain",
    );
  }
  if (p.destinationDomain !== STELLAR_DOMAIN) throw new Error("not a burn to Stellar");
  if (
    !p.destinationTokenMessenger.equals(Buffer.from(StrKey.decodeContract(opts.tokenMessenger)))
  ) {
    throw new Error("addressed to a different token messenger");
  }
  if (!p.mintRecipient.equals(Buffer.from(StrKey.decodeContract(forwarder)))) {
    throw new Error("does not mint to the CctpForwarder");
  }
  // The forwarder (every burn since the fix) or, from Sui only, zero (burns made before the fix,
  // still finishable). Anything else and mint_and_forward would fail after we had paid for it.
  const forwarderCaller = Buffer.from(StrKey.decodeContract(forwarder));
  const openAllowed = p.sourceDomain === SUI_DOMAIN;
  if (
    !p.destinationCaller.equals(forwarderCaller) &&
    !(openAllowed && p.destinationCaller.equals(Buffer.alloc(32)))
  ) {
    throw new Error("destinationCaller is neither the CctpForwarder nor open");
  }
  if (p.amount <= 0n) throw new Error("zero amount");

  const hook = p.hookData;
  if (hook.length <= HOOK_HEADER) throw new Error("missing forwarding hook");
  const declared = hook.readUInt32BE(28);
  if (declared !== hook.length - HOOK_HEADER) throw new Error("hook length does not match");
  const recipient = hook.subarray(HOOK_HEADER).toString("utf8");
  if (!isStellarRecipient(recipient)) throw new Error("hook does not name a Stellar address");

  return { amount: p.amount, recipient, sourceDomain: p.sourceDomain };
}
