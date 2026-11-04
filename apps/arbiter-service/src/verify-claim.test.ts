import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Connection, ParsedTransactionWithMeta } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { MEMO_PROGRAM_ID, memoTextForIntent } from "@xebra/chain-adapters";
import type { claims, intents } from "@xebra/db";
import {
  AddrEncoding,
  AssetKind,
  ChainId,
  assetRefToSplMint,
  chainAddressToSolanaAddress,
} from "@xebra/intent-schema";
import bs58 from "bs58";
import { describe, expect, it, vi } from "vitest";
import type { ClaimLookup } from "./lookup-claim.js";
import { verifyClaimAgainstDestinationChain } from "./verify-claim.js";
import type { StellarFulfillmentSource } from "./verify-stellar-fulfillment.js";

const unusedStellarSource: StellarFulfillmentSource = {
  getTransaction: vi.fn(),
  getPaymentsForTransaction: vi.fn(),
};

const INTENT_HASH = `0x${"66".repeat(32)}` as const;
const DEST_ASSET_ID = `0x${"55".repeat(32)}` as const;
const DEST_ADDRESS_RAW = `0x${"11".repeat(32)}` as const;

const MINT = new PublicKey(
  assetRefToSplMint({ chainId: ChainId.Solana, kind: AssetKind.SplToken, assetId: DEST_ASSET_ID }),
);
const RECIPIENT = new PublicKey(
  chainAddressToSolanaAddress({
    chainId: ChainId.Solana,
    encoding: AddrEncoding.SolanaEd25519_32,
    raw: DEST_ADDRESS_RAW,
  }),
);

function claimLookup(overrides: { destChain?: ChainId } = {}): ClaimLookup {
  const destChain = overrides.destChain ?? ChainId.Solana;
  const intent = {
    intentHash: INTENT_HASH,
    destAssetId: DEST_ASSET_ID,
    minDestAmount: "900000000",
    destAddress: {
      chainId: destChain,
      // Only Solana's encoding matters for the fixtures that actually reach chain-specific
      // address decoding in this file's tests (the Stellar-dispatch test below fakes out the
      // Stellar side entirely) — real encoding/chainId pairing is exercised in
      // verify-stellar-fulfillment.test.ts.
      encoding:
        destChain === ChainId.Stellar
          ? AddrEncoding.StellarEd25519_32
          : AddrEncoding.SolanaEd25519_32,
      raw: DEST_ADDRESS_RAW,
    },
  } as unknown as typeof intents.$inferSelect;

  const claim = {
    intentHash: INTENT_HASH,
    destTxRef: "real-tx-signature",
    deliveredAmount: "900000000",
  } as unknown as typeof claims.$inferSelect;

  return { intent, claim };
}

function fixtureTx(): ParsedTransactionWithMeta {
  const intentHashBytes = new Uint8Array(32).fill(0x66);
  return {
    meta: { err: null },
    transaction: {
      message: {
        instructions: [
          {
            programId: MEMO_PROGRAM_ID,
            data: bs58.encode(Buffer.from(memoTextForIntent(intentHashBytes), "utf8")),
          },
          {
            programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
            parsed: {
              type: "transferChecked",
              info: {
                destination: getAssociatedTokenAddressSync(MINT, RECIPIENT).toBase58(),
                mint: MINT.toBase58(),
                tokenAmount: { amount: "900000000" },
              },
            },
          },
        ],
      },
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe("verifyClaimAgainstDestinationChain", () => {
  it("verifies a well-formed Solana delivery", async () => {
    const connection = {
      getParsedTransaction: vi.fn(async () => fixtureTx()),
    } as unknown as Connection;

    const result = await verifyClaimAgainstDestinationChain(
      connection,
      unusedStellarSource,
      claimLookup(),
    );
    expect(result).toEqual({ ok: true, verified: true });
  });

  it("reports verified=false (not an error) when the tx doesn't satisfy the claim", async () => {
    const connection = {
      getParsedTransaction: vi.fn(async () => ({
        ...fixtureTx(),
        meta: { err: { InstructionError: [0, "Custom"] } },
      })),
    } as unknown as Connection;

    const result = await verifyClaimAgainstDestinationChain(
      connection,
      unusedStellarSource,
      claimLookup(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verified).toBe(false);
  });

  it("returns ok=false (can't verify yet) for a destination chain with no verifier", async () => {
    const connection = { getParsedTransaction: vi.fn() } as unknown as Connection;

    // Arc is only ever a source chain on the intent rail, never an intent's destination — stands
    // in for "some chain nobody has wired verification for."
    const result = await verifyClaimAgainstDestinationChain(
      connection,
      unusedStellarSource,
      claimLookup({ destChain: ChainId.ArcEvm }),
    );
    expect(result.ok).toBe(false);
    expect(connection.getParsedTransaction).not.toHaveBeenCalled();
  });

  it("dispatches to the Stellar fulfillment source for a Stellar destination", async () => {
    const connection = { getParsedTransaction: vi.fn() } as unknown as Connection;
    const stellarSource: StellarFulfillmentSource = {
      getTransaction: vi.fn(async () => ({ memo_type: "none" }) as never),
      getPaymentsForTransaction: vi.fn(async () => []),
    };

    await verifyClaimAgainstDestinationChain(
      connection,
      stellarSource,
      claimLookup({ destChain: ChainId.Stellar }),
    );
    expect(stellarSource.getTransaction).toHaveBeenCalled();
    expect(connection.getParsedTransaction).not.toHaveBeenCalled();
  });

  it("reports verified=false when the destination tx can't be found", async () => {
    const connection = {
      getParsedTransaction: vi.fn(async () => null),
    } as unknown as Connection;

    const result = await verifyClaimAgainstDestinationChain(
      connection,
      unusedStellarSource,
      claimLookup(),
    );
    expect(result).toEqual({ ok: true, verified: false, reason: "destination tx not found" });
  });
});
