import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FillResult } from "./fill-loop.js";

/**
 * What the solver has already done, kept across restarts. Without it, a crash between "delivered
 * on Solana" and "claimed on Stellar" makes the next start see an intent that is still Open and
 * deliver it a second time: the first delivery is the solver's loss, the second is a gift.
 *
 * The record is written after the delivery confirms and before the claim is sent, so the worst a
 * crash can do is retry the claim.
 */
export interface JournalEntry {
  destTxRef: string;
  deliveredAmount: bigint;
  claimTxRef?: string;
}

export interface Journal {
  get(intentHash: string): JournalEntry | undefined;
  recordFill(intentHash: string, fill: FillResult): Promise<void>;
  recordClaim(intentHash: string, claimTxRef: string): Promise<void>;
}

interface StoredState {
  cursor?: string;
  entries: Record<string, { destTxRef: string; deliveredAmount: string; claimTxRef?: string }>;
}

/** One JSON file, rewritten whole through a temp file and a rename so a crash never leaves half of it. */
export class FileJournal implements Journal {
  private state: StoredState;

  constructor(private readonly path: string) {
    this.state = load(path);
  }

  getCursor(): string | undefined {
    return this.state.cursor;
  }

  async setCursor(cursor: string): Promise<void> {
    this.state.cursor = cursor;
    this.save();
  }

  get(intentHash: string): JournalEntry | undefined {
    const e = this.state.entries[key(intentHash)];
    if (!e) return undefined;
    return {
      destTxRef: e.destTxRef,
      deliveredAmount: BigInt(e.deliveredAmount),
      ...(e.claimTxRef ? { claimTxRef: e.claimTxRef } : {}),
    };
  }

  async recordFill(intentHash: string, fill: FillResult): Promise<void> {
    this.state.entries[key(intentHash)] = {
      destTxRef: fill.destTxRef,
      deliveredAmount: fill.deliveredAmount.toString(),
    };
    this.save();
  }

  async recordClaim(intentHash: string, claimTxRef: string): Promise<void> {
    const e = this.state.entries[key(intentHash)];
    if (!e) throw new Error(`journal: no fill recorded for ${intentHash}`);
    e.claimTxRef = claimTxRef;
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path);
  }
}

/** For tests and dry runs. */
export class MemoryJournal implements Journal {
  readonly entries = new Map<string, JournalEntry>();

  get(intentHash: string): JournalEntry | undefined {
    return this.entries.get(key(intentHash));
  }

  async recordFill(intentHash: string, fill: FillResult): Promise<void> {
    this.entries.set(key(intentHash), {
      destTxRef: fill.destTxRef,
      deliveredAmount: fill.deliveredAmount,
    });
  }

  async recordClaim(intentHash: string, claimTxRef: string): Promise<void> {
    const e = this.entries.get(key(intentHash));
    if (!e) throw new Error(`journal: no fill recorded for ${intentHash}`);
    e.claimTxRef = claimTxRef;
  }
}

function key(intentHash: string): string {
  return intentHash.toLowerCase().replace(/^0x/, "");
}

function load(path: string): StoredState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: {} };
    throw err;
  }
  // A file that exists but cannot be read back is not "no history": starting empty could
  // re-deliver every intent. Refuse and let the operator look at it.
  const parsed = JSON.parse(raw) as StoredState;
  if (typeof parsed !== "object" || parsed === null || typeof parsed.entries !== "object") {
    throw new Error(`journal: ${path} is not a solver state file`);
  }
  return parsed;
}
