import type { Database } from "@xebra/db";
import { claims, escrowEvents, intents } from "@xebra/db";
import type { ChainEvent } from "@xebra/event-bus";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Logger } from "pino";
import {
  projectIntentChallenged,
  projectIntentClaimed,
  projectIntentResolved,
} from "./project-claim.js";
import { projectIntentOpened } from "./project-intent-opened.js";

/**
 * Populates packages/db's tables from the event backbone. Idempotent by design:
 * `intents`/`claims` inserts use `onConflictDoNothing` (an event redelivered — Kafka's
 * at-least-once delivery — shouldn't error), and `escrow_events` is a pure append-only audit log
 * keyed by the event's own dedup id, so redelivery there is a harmless duplicate-key no-op too.
 *
 * `claims` is now populated (see project-claim.ts) — this is what unblocks
 * apps/arbiter-service's claim-verification lookup, per that file's own module doc comment.
 *
 * # Out-of-order delivery
 *
 * Kafka partitions by event id, not intent hash (packages/event-bus/src/producer.ts), so
 * `IntentFinalized` can be projected before the `IntentOpened` of the same intent. Two rules keep
 * `intents.status` right whatever the order:
 *
 *  - every event is recorded in `escrow_events` first, even when its `intents` row does not exist
 *    yet (that table has no foreign key to `intents` for this reason), and when `IntentOpened`
 *    creates the row its status is derived from that log;
 *  - status only moves forward. Both escrows (XebraEscrow.sol and the Soroban escrow) go
 *    open -> claimed -> challenged -> finalized | refunded and never back, so a late
 *    `IntentClaimed` must not overwrite `finalized`.
 */

type IntentStatus = (typeof intents.$inferSelect)["status"];

const STATUS_BY_EVENT_TYPE: Partial<Record<ChainEvent["eventType"], IntentStatus>> = {
  IntentClaimed: "claimed",
  IntentChallenged: "challenged",
  IntentFinalized: "finalized",
  IntentRefunded: "refunded",
};

/** How far along the escrow's one-way lifecycle a status is. Finalized and refunded are both terminal. */
const STATUS_RANK: Record<IntentStatus, number> = {
  open: 0,
  claimed: 1,
  challenged: 2,
  finalized: 3,
  refunded: 3,
};

/** The furthest status a set of recorded lifecycle event types reaches, or null for none. */
export function furthestStatus(eventTypes: readonly string[]): IntentStatus | null {
  let best: IntentStatus | null = null;
  for (const type of eventTypes) {
    const status = STATUS_BY_EVENT_TYPE[type as ChainEvent["eventType"]];
    if (status && (best === null || STATUS_RANK[status] > STATUS_RANK[best])) best = status;
  }
  return best;
}

/** `rank(intents.status)` in SQL, from the same table as `STATUS_RANK`. */
const rankOfStatusColumn = sql.raw(
  `CASE "intents"."status" ${Object.entries(STATUS_RANK)
    .map(([status, rank]) => `WHEN '${status}' THEN ${rank}`)
    .join(" ")} END`,
);

/** Moves an intent to `status` unless it is already that far along. A missing row is a no-op. */
async function advanceStatus(db: Database, intentHash: string, status: IntentStatus) {
  await db
    .update(intents)
    .set({ status })
    .where(
      and(eq(intents.intentHash, intentHash), sql`${rankOfStatusColumn} < ${STATUS_RANK[status]}`),
    );
}

/** Applies whatever lifecycle events were recorded for this intent before its row existed. */
async function catchUpFromLog(db: Database, intentHash: string) {
  const recorded = await db
    .select({ eventType: escrowEvents.eventType })
    .from(escrowEvents)
    .where(
      and(
        eq(escrowEvents.intentHash, intentHash),
        inArray(escrowEvents.eventType, Object.keys(STATUS_BY_EVENT_TYPE)),
      ),
    );
  const status = furthestStatus(recorded.map((r) => r.eventType));
  if (status) await advanceStatus(db, intentHash, status);
}

export async function projectEvent(db: Database, event: ChainEvent, logger: Logger): Promise<void> {
  // First, so that an event arriving before its intent's row is not lost (see the module doc).
  if (event.intentHash) {
    try {
      await db
        .insert(escrowEvents)
        .values({
          id: event.id,
          intentHash: event.intentHash,
          chainId: event.chainId,
          eventType: event.eventType,
          txRef: event.txRef,
          blockOrLedgerNumber: event.blockOrLedgerNumber ? BigInt(event.blockOrLedgerNumber) : null,
        })
        .onConflictDoNothing();
    } catch (err) {
      logger.warn({ eventId: event.id, err }, "projector: escrow_events insert failed");
    }
  }

  if (event.eventType === "IntentOpened") {
    const row = projectIntentOpened(event);
    if (!row) {
      logger.warn(
        { eventId: event.id },
        "projector: IntentOpened event didn't match a known payload shape, skipping",
      );
      return;
    }
    await db.insert(intents).values(row).onConflictDoNothing();
    // Lifecycle events that were projected before this row existed. Done after the insert, so an
    // event recorded concurrently with it is seen here or applies to the row itself.
    await catchUpFromLog(db, row.intentHash);
  }

  if (event.eventType === "IntentClaimed") {
    const row = projectIntentClaimed(event);
    if (!row) {
      logger.warn(
        { eventId: event.id },
        "projector: IntentClaimed event didn't match a known payload shape, skipping claims insert",
      );
    } else {
      await db.insert(claims).values(row).onConflictDoNothing();
    }
  }

  const claimUpdate =
    event.eventType === "IntentChallenged"
      ? projectIntentChallenged(event)
      : event.eventType === "IntentResolved"
        ? projectIntentResolved(event)
        : null;
  if (claimUpdate && event.intentHash) {
    try {
      await db.update(claims).set(claimUpdate).where(eq(claims.intentHash, event.intentHash));
    } catch (err) {
      // The claim row may not exist yet if this event was delivered out of order relative to
      // its IntentClaimed event. Unlike the intent status below, this is not caught up later:
      // escrow_events keeps the event type but not the payload a claim update needs.
      logger.warn(
        { eventId: event.id, err },
        "projector: claims update failed, possibly out-of-order delivery",
      );
    }
  }

  const newStatus = STATUS_BY_EVENT_TYPE[event.eventType];
  if (newStatus && event.intentHash) {
    // With no row yet this changes nothing, and the event is already in escrow_events, where
    // IntentOpened's catch-up finds it.
    await advanceStatus(db, event.intentHash, newStatus);
  }
}
