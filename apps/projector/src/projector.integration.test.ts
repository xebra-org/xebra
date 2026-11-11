import {
  type Database,
  chains,
  claims,
  corridors,
  createDb,
  escrowEvents,
  intents,
} from "@xebra/db";
import type { ChainEvent } from "@xebra/event-bus";
import { ChainId } from "@xebra/intent-schema";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { corridorId } from "./corridor-id.js";
import { projectEvent } from "./projector.js";

/** Runs against a real Postgres — see packages/db/README.md for the same pattern. Skipped
 *  automatically without TEST_DATABASE_URL. */
const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;
const logger = pino({ enabled: false });

const INTENT_HASH = `0x${"cc".repeat(32)}`;
const OPENED_EVENT: ChainEvent = {
  id: "2:tx1:0",
  chainId: ChainId.Stellar,
  intentHash: INTENT_HASH,
  eventType: "IntentOpened",
  txRef: "tx1",
  blockOrLedgerNumber: "100",
  observedAt: new Date().toISOString(),
  payload: {
    user: `0x${"11".repeat(32)}`,
    source_token: `0x${"0".repeat(64)}`,
    source_amount: "1000000000",
    dest_chain: ChainId.Solana,
    dest_asset: `0x${"22".repeat(32)}`,
    min_dest_amount: "900000000",
    dest_address: `0x${"33".repeat(32)}`,
    expiry: "2000000000",
    nonce: "1",
  },
};

describeIfDb("projectEvent (integration)", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(connectionString as string);
    await db.insert(chains).values([
      { id: ChainId.Stellar, name: "Stellar", kind: "stellar" },
      { id: ChainId.Solana, name: "Solana", kind: "solana" },
    ]);
    await db.insert(corridors).values({
      id: corridorId(ChainId.Stellar, ChainId.Solana),
      sourceChainId: ChainId.Stellar,
      destChainId: ChainId.Solana,
      challengeWindowSeconds: 1800,
      active: true,
    });
  });

  afterAll(async () => {
    await db.delete(escrowEvents);
    await db.delete(claims);
    await db.delete(intents);
    await db.delete(corridors);
    await db.delete(chains);
  });

  it("projects an IntentOpened event into a real intents row", async () => {
    await projectEvent(db, OPENED_EVENT, logger);

    const [row] = await db.select().from(intents).where(eq(intents.intentHash, INTENT_HASH));
    expect(row?.status).toBe("open");
    expect(row?.sourceAmount).toBe("1000000000");
    expect(row?.corridorId).toBe(corridorId(ChainId.Stellar, ChainId.Solana));
  });

  it("is idempotent: redelivering the same IntentOpened event doesn't error or duplicate", async () => {
    await projectEvent(db, OPENED_EVENT, logger);
    await projectEvent(db, OPENED_EVENT, logger);

    const rows = await db.select().from(intents).where(eq(intents.intentHash, INTENT_HASH));
    expect(rows).toHaveLength(1);
  });

  it("advances status on a later event and appends to escrow_events", async () => {
    const claimedEvent: ChainEvent = {
      ...OPENED_EVENT,
      id: "2:tx2:0",
      eventType: "IntentClaimed",
      txRef: "tx2",
    };

    await projectEvent(db, claimedEvent, logger);

    const [row] = await db.select().from(intents).where(eq(intents.intentHash, INTENT_HASH));
    expect(row?.status).toBe("claimed");

    const events = await db
      .select()
      .from(escrowEvents)
      .where(eq(escrowEvents.intentHash, INTENT_HASH));
    expect(events.map((e) => e.eventType).sort()).toEqual(["IntentClaimed", "IntentOpened"]);
  });

  it("projects a real claim through claimed -> challenged -> resolved", async () => {
    // Field shapes here match real events observed against a live testnet deployment (see
    // decode-soroban-events.ts's module doc comment) — snake_case struct field names.
    const claimedEvent: ChainEvent = {
      id: "2:tx3:0",
      chainId: ChainId.Stellar,
      intentHash: INTENT_HASH,
      eventType: "IntentClaimed",
      txRef: "tx3",
      blockOrLedgerNumber: "101",
      observedAt: new Date().toISOString(),
      payload: {
        solver: "GAUOB3MN5QAJV75G7ID253KYOWCRYB7U6BQ4WOVPXJAGVRNGRI7NJVTT",
        dest_tx_ref: "0x64656d6f",
        delivered_amount: "1000000",
        solver_bond: "250000000",
        challenge_deadline: "2000000000",
      },
    };
    await projectEvent(db, claimedEvent, logger);

    const [claimedRow] = await db.select().from(claims).where(eq(claims.intentHash, INTENT_HASH));
    expect(claimedRow?.solverAddress).toBe(
      "GAUOB3MN5QAJV75G7ID253KYOWCRYB7U6BQ4WOVPXJAGVRNGRI7NJVTT",
    );
    expect(claimedRow?.bondAmount).toBe("250000000");
    expect(claimedRow?.challengeStatus).toBe("none");

    const challengedEvent: ChainEvent = {
      ...claimedEvent,
      id: "2:tx4:0",
      txRef: "tx4",
      eventType: "IntentChallenged",
      payload: {
        challenger: "GBK6PMDBP4JSAYMIVWOXE5ESIY5F6U6JVEXRNO22J7WHGAB4H46ACMDQ",
        challenger_bond: "250000000",
      },
    };
    await projectEvent(db, challengedEvent, logger);

    const [challengedRow] = await db
      .select()
      .from(claims)
      .where(eq(claims.intentHash, INTENT_HASH));
    expect(challengedRow?.challengeStatus).toBe("challenged");
    expect(challengedRow?.challengerAddress).toBe(
      "GBK6PMDBP4JSAYMIVWOXE5ESIY5F6U6JVEXRNO22J7WHGAB4H46ACMDQ",
    );

    const resolvedEvent: ChainEvent = {
      ...claimedEvent,
      id: "2:tx5:0",
      txRef: "tx5",
      eventType: "IntentResolved",
      payload: { claim_valid: false },
    };
    await projectEvent(db, resolvedEvent, logger);

    const [resolvedRow] = await db.select().from(claims).where(eq(claims.intentHash, INTENT_HASH));
    expect(resolvedRow?.challengeStatus).toBe("resolved_invalid");
    expect(resolvedRow?.resolvedAt).not.toBeNull();
  });

  describe("out-of-order delivery (issue #1)", () => {
    const event = (hash: string, n: number, eventType: ChainEvent["eventType"]): ChainEvent => ({
      ...OPENED_EVENT,
      id: `2:ooo-${hash.slice(2, 6)}-${n}:0`,
      txRef: `ooo-${n}`,
      intentHash: hash,
      eventType,
    });
    const statusOf = async (hash: string) =>
      (await db.select().from(intents).where(eq(intents.intentHash, hash)))[0]?.status;

    it("keeps a finalized status when IntentFinalized arrives before IntentOpened", async () => {
      const hash = `0x${"d1".repeat(32)}`;
      await projectEvent(db, event(hash, 1, "IntentFinalized"), logger);
      expect(await statusOf(hash)).toBeUndefined();

      await projectEvent(db, event(hash, 0, "IntentOpened"), logger);
      expect(await statusOf(hash)).toBe("finalized");

      const logged = await db.select().from(escrowEvents).where(eq(escrowEvents.intentHash, hash));
      expect(logged.map((e) => e.eventType).sort()).toEqual(["IntentFinalized", "IntentOpened"]);
    });

    it("keeps a refunded status when IntentRefunded arrives before IntentOpened", async () => {
      const hash = `0x${"d2".repeat(32)}`;
      await projectEvent(db, event(hash, 1, "IntentRefunded"), logger);
      await projectEvent(db, event(hash, 0, "IntentOpened"), logger);
      expect(await statusOf(hash)).toBe("refunded");
    });

    it("takes the furthest status when several lifecycle events precede IntentOpened", async () => {
      const hash = `0x${"d3".repeat(32)}`;
      await projectEvent(db, event(hash, 3, "IntentFinalized"), logger);
      await projectEvent(db, event(hash, 1, "IntentClaimed"), logger);
      await projectEvent(db, event(hash, 0, "IntentOpened"), logger);
      expect(await statusOf(hash)).toBe("finalized");
    });

    it("never moves a status backwards when an earlier event arrives late", async () => {
      const hash = `0x${"d4".repeat(32)}`;
      await projectEvent(db, event(hash, 0, "IntentOpened"), logger);
      await projectEvent(db, event(hash, 2, "IntentChallenged"), logger);
      expect(await statusOf(hash)).toBe("challenged");

      await projectEvent(db, event(hash, 1, "IntentClaimed"), logger);
      expect(await statusOf(hash)).toBe("challenged");

      await projectEvent(db, event(hash, 3, "IntentRefunded"), logger);
      expect(await statusOf(hash)).toBe("refunded");
    });

    it("leaves an intent with no lifecycle events open", async () => {
      const hash = `0x${"d5".repeat(32)}`;
      await projectEvent(db, event(hash, 0, "IntentOpened"), logger);
      expect(await statusOf(hash)).toBe("open");
    });
  });
});
