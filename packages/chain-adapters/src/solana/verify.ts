import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type {
  ParsedInstruction,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
  PublicKey,
} from "@solana/web3.js";
import { MEMO_PROGRAM_ID, intentHashFromMemoIx } from "./delivery.js";

/**
 * Verifies a solver's delivery claim against an already-fetched, parsed Solana transaction —
 * the Solana-side analog of checking a Stellar fulfillment payment against Horizon (spec
 * "Fulfillment, Stellar side"). Anyone can run this: fetch the tx from any Solana RPC's
 * `getParsedTransaction`, then check the memo, the transfer, the mint, the amount, and the
 * recipient. A handful of lines, same shape as the Stellar-side verification story.
 */

export interface VerifyDeliveryInput {
  tx: ParsedTransactionWithMeta;
  intentHash: Uint8Array;
  mint: PublicKey;
  minAmount: bigint;
  recipient: PublicKey;
}

export type VerifyDeliveryResult =
  | { ok: true; deliveredAmount: bigint }
  | { ok: false; reason: string };

export function verifyDelivery(input: VerifyDeliveryInput): VerifyDeliveryResult {
  if (input.tx.meta?.err) {
    return { ok: false, reason: "transaction failed on-chain" };
  }

  const instructions = input.tx.transaction.message.instructions;

  const memoIx = instructions.find((ix) => ix.programId.toBase58() === MEMO_PROGRAM_ID.toBase58());
  if (!memoIx) {
    return { ok: false, reason: "no memo instruction found" };
  }

  const memoBytes = intentHashFromMemoIx(memoIx);
  if (!memoBytes || !bytesEqual(memoBytes, input.intentHash)) {
    return { ok: false, reason: "memo does not match intent hash" };
  }

  const recipientAta = getAssociatedTokenAddressSync(input.mint, input.recipient).toBase58();

  const transferIx = instructions.find(isParsedTransferTo(recipientAta));
  if (!transferIx) {
    return { ok: false, reason: "no matching transfer instruction to the recipient's ATA found" };
  }

  const info = transferIx.parsed.info as {
    mint?: string;
    tokenAmount?: { amount: string };
    amount?: string;
  };

  if (info.mint && info.mint !== input.mint.toBase58()) {
    return {
      ok: false,
      reason: `transfer is for mint ${info.mint}, expected ${input.mint.toBase58()}`,
    };
  }

  const deliveredAmount = BigInt(info.tokenAmount?.amount ?? info.amount ?? "0");
  if (deliveredAmount < input.minAmount) {
    return {
      ok: false,
      reason: `delivered amount ${deliveredAmount} is below the required minimum ${input.minAmount}`,
    };
  }

  return { ok: true, deliveredAmount };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function isParsedTransferTo(
  destinationAta: string,
): (ix: ParsedInstruction | PartiallyDecodedInstruction) => ix is ParsedInstruction {
  return (ix): ix is ParsedInstruction =>
    "parsed" in ix &&
    (ix.parsed?.type === "transferChecked" || ix.parsed?.type === "transfer") &&
    ix.parsed?.info?.destination === destinationAta;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
