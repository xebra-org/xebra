import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { MEMO_PROGRAM_ID, memoTextForIntent } from "./delivery.js";
import { verifyDelivery } from "./verify.js";

const MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const RECIPIENT = new PublicKey("So11111111111111111111111111111111111111112");
const RECIPIENT_ATA = getAssociatedTokenAddressSync(MINT, RECIPIENT).toBase58();
const INTENT_HASH = new Uint8Array(32).fill(7);

/** Builds a minimal fixture shaped like the fields verifyDelivery actually reads — a full
 *  ParsedTransactionWithMeta has many more fields we don't touch and don't need to fake. */
function fixture(opts: {
  err?: unknown;
  memoHash?: Uint8Array;
  transferDestination?: string;
  transferAmount?: string;
  transferMint?: string;
  omitMemo?: boolean;
  omitTransfer?: boolean;
}): ParsedTransactionWithMeta {
  const instructions: unknown[] = [];

  if (!opts.omitMemo) {
    instructions.push({
      programId: MEMO_PROGRAM_ID,
      data: bs58.encode(Buffer.from(memoTextForIntent(opts.memoHash ?? INTENT_HASH), "utf8")),
    });
  }

  if (!opts.omitTransfer) {
    instructions.push({
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      parsed: {
        type: "transferChecked",
        info: {
          destination: opts.transferDestination ?? RECIPIENT_ATA,
          mint: opts.transferMint ?? MINT.toBase58(),
          tokenAmount: { amount: opts.transferAmount ?? "900000000" },
        },
      },
    });
  }

  return {
    meta: { err: opts.err ?? null },
    transaction: { message: { instructions } },
  } as unknown as ParsedTransactionWithMeta;
}

describe("verifyDelivery", () => {
  const baseInput = {
    intentHash: INTENT_HASH,
    mint: MINT,
    minAmount: 900_000_000n,
    recipient: RECIPIENT,
  };

  it("accepts a well-formed delivery", () => {
    const result = verifyDelivery({ tx: fixture({}), ...baseInput });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.deliveredAmount).toBe(900_000_000n);
  });

  it("rejects a transaction that failed on-chain", () => {
    const result = verifyDelivery({
      tx: fixture({ err: { InstructionError: [0, "Custom"] } }),
      ...baseInput,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/failed on-chain/);
  });

  it("rejects a missing memo instruction", () => {
    const result = verifyDelivery({ tx: fixture({ omitMemo: true }), ...baseInput });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/memo/);
  });

  it("rejects a memo that doesn't match the intent hash", () => {
    const result = verifyDelivery({
      tx: fixture({ memoHash: new Uint8Array(32).fill(9) }),
      ...baseInput,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not match/);
  });

  it("rejects a missing transfer to the recipient's ATA", () => {
    const result = verifyDelivery({ tx: fixture({ omitTransfer: true }), ...baseInput });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no matching transfer/);
  });

  it("rejects a transfer to the wrong destination account", () => {
    const wrongAta = getAssociatedTokenAddressSync(
      MINT,
      new PublicKey("11111111111111111111111111111111"),
    ).toBase58();
    const result = verifyDelivery({ tx: fixture({ transferDestination: wrongAta }), ...baseInput });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no matching transfer/);
  });

  it("rejects a delivered amount below minDestAmount", () => {
    const result = verifyDelivery({ tx: fixture({ transferAmount: "1" }), ...baseInput });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/below the required minimum/);
  });

  it("rejects a transfer of the wrong mint", () => {
    const wrongMint = "So11111111111111111111111111111111111111112";
    const result = verifyDelivery({ tx: fixture({ transferMint: wrongMint }), ...baseInput });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/expected/);
  });
});
