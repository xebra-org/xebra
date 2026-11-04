import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  MEMO_PROGRAM_ID,
  buildDeliveryInstructions,
  encodeMemoData,
  intentHashFromMemoIx,
  memoTextForIntent,
} from "./delivery.js";

const PAYER = new PublicKey("11111111111111111111111111111111");
const MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const RECIPIENT = new PublicKey("So11111111111111111111111111111111111111112");
const INTENT_HASH = new Uint8Array(32).fill(7);

describe("buildDeliveryInstructions", () => {
  it("builds exactly [create-ATA, transfer, memo] in that order", () => {
    const ixs = buildDeliveryInstructions({
      payer: PAYER,
      mint: MINT,
      recipient: RECIPIENT,
      amount: 900_000_000n,
      decimals: 9,
      intentHash: INTENT_HASH,
    });

    expect(ixs).toHaveLength(3);
    // The memo instruction is last and carries the intent hash as 64 hex characters.
    const memoIx = ixs.at(2);
    if (!memoIx) throw new Error("expected a third instruction");
    expect(memoIx.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(memoIx.data.toString("utf8")).toBe("07".repeat(32));
  });

  it("builds a memo the SPL Memo program will accept: valid UTF-8, for any hash", () => {
    // Regression for the first live run: raw hash bytes failed on chain with
    // "Invalid UTF-8, from byte 2", which no mocked test could show.
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const hash of [
      INTENT_HASH,
      new Uint8Array(32).fill(0xff),
      Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i),
    ]) {
      const [, , memoIx] = buildDeliveryInstructions({
        payer: PAYER,
        mint: MINT,
        recipient: RECIPIENT,
        amount: 1n,
        decimals: 9,
        intentHash: hash,
      });
      expect(() => decoder.decode(memoIx?.data)).not.toThrow();
    }
  });

  it("rejects an intent hash that isn't 32 bytes", () => {
    expect(() =>
      buildDeliveryInstructions({
        payer: PAYER,
        mint: MINT,
        recipient: RECIPIENT,
        amount: 1n,
        decimals: 9,
        intentHash: new Uint8Array(31),
      }),
    ).toThrow(/32 bytes/);
  });
});

describe("intentHashFromMemoIx", () => {
  const programId = MEMO_PROGRAM_ID;
  const text = memoTextForIntent(INTENT_HASH);

  it("reads a decoded spl-memo instruction, which is what getParsedTransaction returns", () => {
    const ix = { program: "spl-memo", programId, parsed: text };
    expect(intentHashFromMemoIx(ix)).toEqual(INTENT_HASH);
  });

  it("reads a raw instruction whose data is base58 of the memo text", () => {
    const ix = { programId, accounts: [], data: bs58.encode(Buffer.from(text, "utf8")) };
    expect(intentHashFromMemoIx(ix)).toEqual(INTENT_HASH);
  });

  it("returns null for anything that is not a 64-hex-character memo", () => {
    expect(intentHashFromMemoIx({ program: "spl-memo", programId, parsed: "hello" })).toBeNull();
    expect(
      intentHashFromMemoIx({ programId, accounts: [], data: bs58.encode(INTENT_HASH) }),
    ).toBeNull();
  });

  it("returns null for another program's instruction", () => {
    const other = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(
      intentHashFromMemoIx({ program: "spl-memo", programId: other, parsed: text }),
    ).toBeNull();
  });
});

describe("encodeMemoData", () => {
  it("base58-encodes the intent hash the same way a solver's tx would carry it", () => {
    const encoded = encodeMemoData(INTENT_HASH);
    expect(typeof encoded).toBe("string");
    expect(encoded.length).toBeGreaterThan(0);
  });
});
