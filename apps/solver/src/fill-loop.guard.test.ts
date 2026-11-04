import { AddrEncoding, AssetKind, ChainId, type IntentV2 } from "@xebra/intent-schema";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { ClaimAdapter, EscrowGate, FillAdapter } from "./fill-loop.js";
import { processOpenedIntent } from "./fill-loop.js";
import { MemoryJournal } from "./journal.js";

const LOGGER = pino({ enabled: false });
const NOW = 1_800_000_000;
const HASH = `0x${"ab".repeat(32)}`;

const INTENT: IntentV2 = {
  version: 2,
  user: {
    chainId: ChainId.Stellar,
    encoding: AddrEncoding.StellarEd25519_32,
    raw: `0x${"1".repeat(64)}`,
  },
  sourceChain: ChainId.Stellar,
  sourceAsset: { chainId: ChainId.Stellar, kind: AssetKind.Native, assetId: `0x${"0".repeat(64)}` },
  sourceAmount: 100_0000000n,
  destChain: ChainId.Solana,
  destAsset: { chainId: ChainId.Solana, kind: AssetKind.SplToken, assetId: `0x${"2".repeat(64)}` },
  minDestAmount: 900_000_000n,
  destAddress: {
    chainId: ChainId.Solana,
    encoding: AddrEncoding.SolanaEd25519_32,
    raw: `0x${"3".repeat(64)}`,
  },
  expiry: 2_000_000_000n,
  nonce: 1n,
};

function adapters() {
  const fill: FillAdapter = {
    quote: vi.fn(async () => ({ canFill: true, deliveredAmount: 900_000_000n })),
    fill: vi.fn(async () => ({ destTxRef: "5Gy3sig", deliveredAmount: 900_000_000n })),
  };
  const claim: ClaimAdapter = { claim: vi.fn(async () => ({ claimTxRef: "claim-tx" })) };
  return { fill, claim };
}

const gate = (view: Awaited<ReturnType<EscrowGate["read"]>>): EscrowGate => ({
  read: vi.fn(async () => view),
});
const open = (expiry: number) => gate({ status: "Open", expiry: BigInt(expiry) });
const base = { logger: LOGGER, now: () => NOW };

describe("processOpenedIntent: the chain decides", () => {
  it("fills an escrow that is Open with time left", async () => {
    const { fill, claim } = adapters();
    const outcome = await processOpenedIntent(HASH, INTENT, {
      ...base,
      fill,
      claim,
      escrow: open(NOW + 3600),
    });
    expect(outcome.status).toBe("filled");
    expect(fill.fill).toHaveBeenCalledOnce();
  });

  it.each(["Claimed", "Challenged", "Finalized", "Refunded"])(
    "does not touch an escrow that is %s",
    async (status) => {
      const { fill, claim } = adapters();
      const outcome = await processOpenedIntent(HASH, INTENT, {
        ...base,
        fill,
        claim,
        escrow: gate({ status, expiry: BigInt(NOW + 3600) }),
      });
      expect(outcome).toEqual({ status: "skipped", reason: `escrow is ${status}, not Open` });
      expect(fill.quote).not.toHaveBeenCalled();
      expect(fill.fill).not.toHaveBeenCalled();
    },
  );

  it("skips an escrow that expires before a delivery and a claim could finish", async () => {
    const { fill, claim } = adapters();
    const outcome = await processOpenedIntent(HASH, INTENT, {
      ...base,
      fill,
      claim,
      escrow: open(NOW + 60),
    });
    expect(outcome).toEqual({ status: "skipped", reason: "expires too soon to deliver and claim" });
    expect(fill.fill).not.toHaveBeenCalled();
  });

  it("skips an event whose escrow is not on chain", async () => {
    const { fill, claim } = adapters();
    const outcome = await processOpenedIntent(HASH, INTENT, {
      ...base,
      fill,
      claim,
      escrow: gate(null),
    });
    expect(outcome).toEqual({ status: "skipped", reason: "no such escrow on chain" });
    expect(fill.fill).not.toHaveBeenCalled();
  });

  it("does not fill when the chain cannot be read", async () => {
    const { fill, claim } = adapters();
    const escrow: EscrowGate = {
      read: async () => {
        throw new Error("rpc down");
      },
    };
    const outcome = await processOpenedIntent(HASH, INTENT, { ...base, fill, claim, escrow });
    expect(outcome).toEqual({ status: "failed", stage: "check", error: "rpc down" });
    expect(fill.fill).not.toHaveBeenCalled();
  });
});

describe("processOpenedIntent: the journal prevents a second delivery", () => {
  it("records the delivery before the claim and the claim after it", async () => {
    const { fill, claim } = adapters();
    const journal = new MemoryJournal();
    claim.claim = vi.fn(async () => {
      expect(journal.get(HASH)?.destTxRef).toBe("5Gy3sig"); // already on disk when the claim goes out
      return { claimTxRef: "claim-tx" };
    });
    await processOpenedIntent(HASH, INTENT, {
      ...base,
      fill,
      claim,
      escrow: open(NOW + 3600),
      journal,
    });
    expect(journal.get(HASH)?.claimTxRef).toBe("claim-tx");
  });

  it("after a crash between delivery and claim, retries only the claim", async () => {
    const { fill, claim } = adapters();
    const journal = new MemoryJournal();
    await journal.recordFill(HASH, { destTxRef: "5Gy3sig", deliveredAmount: 900_000_000n });

    const outcome = await processOpenedIntent(HASH, INTENT, {
      ...base,
      fill,
      claim,
      escrow: open(NOW + 3600),
      journal,
    });

    expect(outcome.status).toBe("filled");
    expect(fill.fill).not.toHaveBeenCalled();
    expect(claim.claim).toHaveBeenCalledWith(HASH, {
      destTxRef: "5Gy3sig",
      deliveredAmount: 900_000_000n,
    });
  });

  it("does nothing for an intent it already filled and claimed", async () => {
    const { fill, claim } = adapters();
    const journal = new MemoryJournal();
    await journal.recordFill(HASH, { destTxRef: "5Gy3sig", deliveredAmount: 1n });
    await journal.recordClaim(HASH, "claim-tx");

    const outcome = await processOpenedIntent(HASH, INTENT, { ...base, fill, claim, journal });
    expect(outcome.status).toBe("skipped");
    expect(fill.fill).not.toHaveBeenCalled();
    expect(claim.claim).not.toHaveBeenCalled();
  });

  it("still claims when the journal write fails after a delivery", async () => {
    const { fill, claim } = adapters();
    const journal = new MemoryJournal();
    journal.recordFill = async () => {
      throw new Error("disk full");
    };
    const outcome = await processOpenedIntent(HASH, INTENT, { ...base, fill, claim, journal });
    expect(outcome.status).toBe("filled");
    expect(claim.claim).toHaveBeenCalledOnce();
  });
});
