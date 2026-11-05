import { PublicKey } from "@solana/web3.js";
import type { ConfirmedSignatureInfo, ParsedTransactionWithMeta } from "@solana/web3.js";
import { memoTextForIntent } from "@xebra/chain-adapters";
import type { EventProducer } from "@xebra/event-bus";
import bs58 from "bs58";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { SolanaTxSource } from "./watch.js";
import { pollOnce, toChainEvent } from "./watch.js";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").toBase58();
const INTENT_HASH = new Uint8Array(32).fill(7);
const SIG = { signature: "sig1", slot: 42, err: null } as unknown as ConfirmedSignatureInfo;

function deliveryTx(): ParsedTransactionWithMeta {
  return {
    meta: { err: null },
    transaction: {
      message: {
        instructions: [
          {
            programId: MEMO_PROGRAM_ID,
            data: bs58.encode(Buffer.from(memoTextForIntent(INTENT_HASH), "utf8")),
          },
          {
            programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
            parsed: {
              type: "transferChecked",
              info: {
                destination: "recipientAta",
                mint: MINT,
                tokenAmount: { amount: "900000000" },
              },
            },
          },
        ],
      },
    },
  } as unknown as ParsedTransactionWithMeta;
}

function nonDeliveryTx(): ParsedTransactionWithMeta {
  return {
    meta: { err: null },
    transaction: { message: { instructions: [] } },
  } as unknown as ParsedTransactionWithMeta;
}

describe("toChainEvent", () => {
  it("builds a Delivery event from a transaction with a memo", () => {
    const event = toChainEvent(SIG, deliveryTx());
    expect(event?.eventType).toBe("Delivery");
    expect(event?.txRef).toBe("sig1");
    expect(event?.payload.mint).toBe(MINT);
  });

  it("returns null for a transaction with no memo (not a Xebra delivery)", () => {
    expect(toChainEvent(SIG, nonDeliveryTx())).toBeNull();
  });
});

describe("pollOnce", () => {
  it("publishes events for new signatures and returns the newest signature seen", async () => {
    const source: SolanaTxSource = {
      getSignaturesForAddress: vi.fn(async () => [SIG]),
      getParsedTransaction: vi.fn(async () => deliveryTx()),
    };
    const producer: EventProducer = { publish: vi.fn(), disconnect: vi.fn() };

    const newest = await pollOnce(
      source,
      "solverAddr",
      undefined,
      producer,
      pino({ enabled: false }),
    );

    expect(producer.publish).toHaveBeenCalledTimes(1);
    expect(newest).toBe("sig1");
  });

  it("skips a signature whose transaction can't be fetched", async () => {
    const source: SolanaTxSource = {
      getSignaturesForAddress: vi.fn(async () => [SIG]),
      getParsedTransaction: vi.fn(async () => null),
    };
    const producer: EventProducer = { publish: vi.fn(), disconnect: vi.fn() };

    await pollOnce(source, "solverAddr", undefined, producer, pino({ enabled: false }));

    expect(producer.publish).not.toHaveBeenCalled();
  });

  it("passes lastSeenSignature through as the `until` cursor", async () => {
    const source: SolanaTxSource = {
      getSignaturesForAddress: vi.fn(async () => []),
      getParsedTransaction: vi.fn(async () => null),
    };
    const producer: EventProducer = { publish: vi.fn(), disconnect: vi.fn() };

    const result = await pollOnce(
      source,
      "solverAddr",
      "prevSig",
      producer,
      pino({ enabled: false }),
    );

    expect(source.getSignaturesForAddress).toHaveBeenCalledWith("solverAddr", { until: "prevSig" });
    // No new signatures came back, so the cursor doesn't move.
    expect(result).toBe("prevSig");
  });
});
