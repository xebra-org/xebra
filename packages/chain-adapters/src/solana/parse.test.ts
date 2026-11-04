import { PublicKey } from "@solana/web3.js";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { MEMO_PROGRAM_ID, memoTextForIntent } from "./delivery.js";
import { parseDeliveryTx } from "./parse.js";

const MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").toBase58();
const RECIPIENT_ATA = new PublicKey("So11111111111111111111111111111111111111112").toBase58();
const INTENT_HASH = new Uint8Array(32).fill(7);

function fixture(
  opts: { err?: unknown; omitMemo?: boolean; omitTransfer?: boolean } = {},
): ParsedTransactionWithMeta {
  const instructions: unknown[] = [];
  if (!opts.omitMemo) {
    instructions.push({
      programId: MEMO_PROGRAM_ID,
      data: bs58.encode(Buffer.from(memoTextForIntent(INTENT_HASH), "utf8")),
    });
  }
  if (!opts.omitTransfer) {
    instructions.push({
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      parsed: {
        type: "transferChecked",
        info: { destination: RECIPIENT_ATA, mint: MINT, tokenAmount: { amount: "900000000" } },
      },
    });
  }
  return {
    meta: { err: opts.err ?? null },
    transaction: { message: { instructions } },
  } as unknown as ParsedTransactionWithMeta;
}

describe("parseDeliveryTx", () => {
  it("extracts memo intent hash, mint, amount, and recipient from a well-formed delivery", () => {
    const result = parseDeliveryTx(fixture());
    expect(result.intentHashHex).toBe(`0x${"07".repeat(32)}`);
    expect(result.mint).toBe(MINT);
    expect(result.amount).toBe(900_000_000n);
    expect(result.recipientTokenAccount).toBe(RECIPIENT_ATA);
  });

  it("returns all-null fields for a failed transaction", () => {
    const result = parseDeliveryTx(fixture({ err: { InstructionError: [0, "Custom"] } }));
    expect(result).toEqual({
      intentHashHex: null,
      mint: null,
      amount: null,
      recipientTokenAccount: null,
    });
  });

  it("returns a null intent hash when there's no memo (not every Solana tx is a Xebra delivery)", () => {
    const result = parseDeliveryTx(fixture({ omitMemo: true }));
    expect(result.intentHashHex).toBeNull();
    expect(result.mint).toBe(MINT);
  });

  it("returns null transfer fields when there's no transfer instruction", () => {
    const result = parseDeliveryTx(fixture({ omitTransfer: true }));
    expect(result.intentHashHex).not.toBeNull();
    expect(result.mint).toBeNull();
    expect(result.amount).toBeNull();
  });
});
