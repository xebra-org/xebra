import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Postgres schema (docs/architecture.md §10): a queryable mirror of on-chain state. Chain state
 * stays canonical — every row here is a projection populated by apps/indexer-* watchers, never
 * the source of truth for fund custody. This is what lets apps/api answer status/verification
 * queries without the frontend hitting three different RPC/Horizon/Solana endpoints directly.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const chainKindEnum = pgEnum("chain_kind", ["evm", "stellar", "solana"]);
export const assetKindEnum = pgEnum("asset_kind", [
  "native",
  "evm_erc20",
  "stellar_classic_asset",
  "stellar_soroban_token",
  "spl_token",
]);
export const intentStatusEnum = pgEnum("intent_status", [
  "open",
  "claimed",
  "challenged",
  "finalized",
  "refunded",
]);
export const attestationStatusEnum = pgEnum("attestation_status", [
  "pending",
  "attested",
  "failed",
]);
export const relayJobStatusEnum = pgEnum("relay_job_status", [
  "queued",
  "waiting_attestation",
  "submitted",
  "confirmed",
  "failed",
]);
export const challengeStatusEnum = pgEnum("challenge_status", [
  "none",
  "challenged",
  "resolved_valid",
  "resolved_invalid",
]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** One row per chain xebra knows about. `id` matches `ChainId` from @xebra/intent-schema
 *  (1 = Arc, 2 = Stellar, 3 = Solana) so every FK below lines up with that enum directly. */
export const chains = pgTable("chains", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  kind: chainKindEnum("kind").notNull(),
  rpcConfigRef: text("rpc_config_ref"),
});

/** `assetId` is the canonical `AssetRef.assetId` hex32 from @xebra/intent-schema. `isNativeUsdc`
 *  is what packages/router-core's `StaticUsdcRegistry` is seeded from. */
export const assets = pgTable(
  "assets",
  {
    chainId: integer("chain_id")
      .notNull()
      .references(() => chains.id),
    assetKind: assetKindEnum("asset_kind").notNull(),
    assetId: text("asset_id").notNull(),
    symbol: text("symbol").notNull(),
    decimals: integer("decimals").notNull(),
    isNativeUsdc: boolean("is_native_usdc").notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.chainId, table.assetId] })],
);

/** One row per (sourceChain, destChain) pair. `escrowContractAddress` is null for a CCTP-only
 *  corridor with no intent/swap rail — packages/router-core's `resolveRoute` reads exactly this
 *  shape (see CorridorConfig there). */
export const corridors = pgTable("corridors", {
  id: text("id").primaryKey(), // e.g. "stellar->solana"
  sourceChainId: integer("source_chain_id")
    .notNull()
    .references(() => chains.id),
  destChainId: integer("dest_chain_id")
    .notNull()
    .references(() => chains.id),
  escrowContractAddress: text("escrow_contract_address"),
  challengeWindowSeconds: integer("challenge_window_seconds").notNull(),
  bondBps: integer("bond_bps").notNull().default(1000),
  active: boolean("active").notNull().default(true),
});

/** Mirrors @xebra/intent-schema's `IntentV2` — `user`/`destAddress` stored as the same
 *  `ChainAddress` JSON shape so the API can round-trip a row straight back into that type. */
export const intents = pgTable("intents", {
  intentHash: text("intent_hash").primaryKey(),
  corridorId: text("corridor_id")
    .notNull()
    .references(() => corridors.id),
  user: jsonb("user").notNull(), // ChainAddress
  sourceAssetId: text("source_asset_id").notNull(),
  sourceAmount: numeric("source_amount", { precision: 38, scale: 0 }).notNull(),
  destAssetId: text("dest_asset_id").notNull(),
  minDestAmount: numeric("min_dest_amount", { precision: 38, scale: 0 }).notNull(),
  destAddress: jsonb("dest_address").notNull(), // ChainAddress
  expiry: timestamp("expiry", { withTimezone: true }).notNull(),
  nonce: numeric("nonce", { precision: 38, scale: 0 }).notNull(),
  status: intentStatusEnum("status").notNull().default("open"),
  rawIntent: jsonb("raw_intent").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only mirror of on-chain events — Postgres is a projection, chain state stays
 *  canonical (see module doc comment). Never updated, only inserted.
 *
 *  `intent_hash` deliberately has no foreign key to `intents`: the event bus does not order
 *  events per intent, so a lifecycle event can arrive before its `IntentOpened`. It is recorded
 *  here anyway, and the projector derives the intent's status from this log when the
 *  `intents` row is created (apps/projector/src/projector.ts). */
export const escrowEvents = pgTable(
  "escrow_events",
  {
    id: text("id").primaryKey(), // e.g. `${chainId}:${txRef}:${logIndex}`
    intentHash: text("intent_hash").notNull(),
    chainId: integer("chain_id")
      .notNull()
      .references(() => chains.id),
    eventType: text("event_type").notNull(), // "Opened" | "Claimed" | "Challenged" | "Resolved" | "Finalized" | "Refunded"
    txRef: text("tx_ref").notNull(),
    blockOrLedgerNumber: bigint("block_or_ledger_number", { mode: "bigint" }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byIntent: index("escrow_events_intent_hash_idx").on(table.intentHash),
  }),
);

export const claims = pgTable("claims", {
  intentHash: text("intent_hash")
    .primaryKey()
    .references(() => intents.intentHash),
  solverAddress: text("solver_address").notNull(),
  destTxRef: text("dest_tx_ref").notNull(),
  deliveredAmount: numeric("delivered_amount", { precision: 38, scale: 0 }).notNull(),
  bondAmount: numeric("bond_amount", { precision: 38, scale: 0 }).notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
  challengeStatus: challengeStatusEnum("challenge_status").notNull().default("none"),
  challengerAddress: text("challenger_address"),
  challengedAt: timestamp("challenged_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

/** One row per CCTP-direct-rail transfer (docs/architecture.md §5) — distinct from `intents`,
 *  since a pure USDC->USDC move never touches an escrow contract at all. */
export const cctpTransfers = pgTable("cctp_transfers", {
  id: text("id").primaryKey(),
  sourceChainId: integer("source_chain_id")
    .notNull()
    .references(() => chains.id),
  destChainId: integer("dest_chain_id")
    .notNull()
    .references(() => chains.id),
  initiatorAddress: text("initiator_address").notNull(),
  burnTxRef: text("burn_tx_ref").notNull(),
  messageHash: text("message_hash").notNull(),
  amount: numeric("amount", { precision: 38, scale: 0 }).notNull(),
  attestationStatus: attestationStatusEnum("attestation_status").notNull().default("pending"),
  mintTxRef: text("mint_tx_ref"),
  // No forward FK to relay_jobs here on purpose: relay_jobs.cctp_transfer_id already provides
  // the relationship (a transfer has at most one active relay job), and a second FK pointing
  // the other way would make the two tables mutually referential — a real circular dependency,
  // not just a TypeScript inference annoyance. Look up a transfer's job with
  // `WHERE relay_jobs.cctp_transfer_id = cctp_transfers.id`.
});

/** The relay's job queue. The relay was removed on 2026-09-24 (apps/cctp-relay,
 *  packages/relay-core and cctp-client's `relay-job.ts` with it); this table and its migrations
 *  are kept so the schema still matches databases already migrated. Nothing reads or writes it
 *  now, and the notes below describe how the relay used it. */
export const relayJobs = pgTable(
  "relay_jobs",
  {
    id: text("id").primaryKey(),
    /** The burn that started this. `(source_domain_id, source_tx_hash)` is the natural key:
     *  one burn transaction produces exactly one mint, so the unique index below is what makes
     *  re-enqueueing after a crash or a duplicate watcher tick idempotent. `relay-job.ts`
     *  claimed idempotency "at the caller's job-store layer" — this was that layer. */
    sourceDomainId: integer("source_domain_id").notNull(),
    sourceTxHash: text("source_tx_hash").notNull(),
    /** Optional: the richer projected record, written by apps/projector from the event bus.
     *  Nullable because the relay had to be able to work from a burn alone — requiring a
     *  projected row first would have made minting depend on the projector being healthy. */
    cctpTransferId: text("cctp_transfer_id").references(() => cctpTransfers.id),
    status: relayJobStatusEnum("status").notNull().default("queued"),
    /** Circle's attested message and signature. Stored so a restarted relay could resume without
     *  re-querying Iris, and so the pair stayed available for the permissionless manual claim
     *  path (docs/architecture.md §5) if the relay was unavailable. */
    message: text("message"),
    attestation: text("attestation"),
    destTxSignature: text("dest_tx_signature"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    solGasSpentLamports: numeric("sol_gas_spent_lamports", { precision: 38, scale: 0 }),
    /** When this job may next be attempted, and by whom.
     *
     *  These two columns were the queue. The relay originally used BullMQ, whose delayed-job
     *  support needs Redis and a process that stays alive to consume it — neither exists in a
     *  serverless deployment. A cron-invoked function instead claimed rows whose
     *  `next_attempt_at` had passed, so the backoff policy that used to be a BullMQ delay became
     *  a timestamp.
     *
     *  `leased_until` is what made a claim safe when two invocations overlapped: a claimed row
     *  was invisible to other workers until its lease expired, so the same burn was not minted
     *  twice by a cron tick racing an inline drain. A crashed invocation's rows simply became
     *  claimable again when the lease lapsed, with no cleanup step. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leasedUntil: timestamp("leased_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** Two watcher ticks, or a watcher restarting mid-batch, must not create two jobs for the
     *  same burn — that would attempt the mint twice and waste a transaction fee on the second
     *  (the on-chain `used_nonce` makes it harmless, but not free). */
    bySourceTx: uniqueIndex("relay_jobs_source_tx_idx").on(
      table.sourceDomainId,
      table.sourceTxHash,
    ),
    /** The relay's claim query's access path: due, unfinished jobs in `next_attempt_at` order.
     *  Without it every cron tick sequentially scanned a table that only ever grows. */
    byDue: index("relay_jobs_due_idx").on(table.status, table.nextAttemptAt),
  }),
);

/** Feeds the low-inventory alerting in docs/architecture.md §11 (Grafana alert on a solver
 *  running low on a given chain/asset). Written periodically by apps/solver, not per-fill. */
export const solverInventorySnapshots = pgTable("solver_inventory_snapshots", {
  id: text("id").primaryKey(),
  chainId: integer("chain_id")
    .notNull()
    .references(() => chains.id),
  assetId: text("asset_id").notNull(),
  balance: numeric("balance", { precision: 38, scale: 0 }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Pagination cursors for chain watchers, one row per (service, stream). Its only writer was the
 * relay's Stellar burn watcher, removed with the relay on 2026-09-24; kept, like `relay_jobs`,
 * so the schema still matches databases already migrated.
 *
 * Soroban RPC's `getEvents` is cursor-paginated and its cursors are opaque strings, not ledger
 * numbers. Keeping the cursor in Postgres rather than in memory is what made a relay restart
 * resume where it stopped: an in-memory cursor restarts from `startLedger` on every deploy,
 * which either re-scans days of history or — once the RPC's retention window has passed the
 * start ledger — silently skips every burn in between.
 *
 * Duplicate scans were harmless (`relay_jobs_source_tx_idx` made a repeat a no-op); gaps were
 * not, so the cursor was only ever advanced after a batch was fully durable.
 */
export const watcherCursors = pgTable("watcher_cursors", {
  /** `<service>:<stream>`, e.g. `cctp-relay:stellar-burns`. */
  id: text("id").primaryKey(),
  cursor: text("cursor").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
