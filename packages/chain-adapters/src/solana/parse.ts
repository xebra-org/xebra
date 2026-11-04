import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { ParsedInstruction, ParsedTransactionWithMeta } from "@solana/web3.js";
import { intentHashFromMemoIx } from "./delivery.js";

/**
 * Parses a delivery transaction's memo + transfer fields *without* checking them against any
 * expected intent (unlike `verifyDelivery`, which does) — this is what apps/indexer-solana uses
 * to turn an observed transaction into a normalized event; `verifyDelivery`'s job (comparing
 * the parsed fields against a specific intent's escrow-asserted values) happens downstream,
 * once the corresponding intent is known. Any field that can't be found comes back `null`
 * rather than throwing — a transaction that isn't a Xebra delivery at all is a normal, expected
 * input here (the indexer is scanning solver wallets' activity broadly, not pre-filtered).
 */
export interface ParsedDelivery {
  intentHashHex: `0x${string}` | null;
  mint: string | null;
  amount: bigint | null;
  recipientTokenAccount: string | null;
}

export function parseDeliveryTx(tx: ParsedTransactionWithMeta): ParsedDelivery {
  if (tx.meta?.err) {
    return { intentHashHex: null, mint: null, amount: null, recipientTokenAccount: null };
  }

  const instructions = tx.transaction.message.instructions;

  let intentHashHex: `0x${string}` | null = null;
  for (const ix of instructions) {
    const hash = intentHashFromMemoIx(ix);
    if (hash) {
      intentHashHex = bytesToHex32OrNull(hash);
      break;
    }
  }

  const transferIx = instructions.find(
    (ix): ix is ParsedInstruction =>
      "parsed" in ix && (ix.parsed?.type === "transferChecked" || ix.parsed?.type === "transfer"),
  );

  if (!transferIx) {
    return { intentHashHex, mint: null, amount: null, recipientTokenAccount: null };
  }

  const info = transferIx.parsed.info as {
    mint?: string;
    destination?: string;
    tokenAmount?: { amount: string };
    amount?: string;
  };

  return {
    intentHashHex,
    mint: info.mint ?? null,
    amount:
      info.tokenAmount?.amount != null
        ? BigInt(info.tokenAmount.amount)
        : info.amount != null
          ? BigInt(info.amount)
          : null,
    recipientTokenAccount: info.destination ?? null,
  };
}

/** Re-derives the recipient's ATA the same way delivery.ts builds it, so callers can match a
 *  parsed delivery's `recipientTokenAccount` against a known (mint, recipient) pair. */
export { getAssociatedTokenAddressSync };

function bytesToHex32OrNull(bytes: Uint8Array): `0x${string}` | null {
  if (bytes.length !== 32) return null;
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `0x${hex}`;
}
