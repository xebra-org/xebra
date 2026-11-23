/**
 * Starts the Sui to Stellar relayer for a burn seen through `GET /v1/transfers/sui/{tx}`, without
 * holding that request open for the minute a mint and its confirmation can take.
 *
 * The first poll that sees an attested, unminted burn starts one relay and answers `scheduled`.
 * Polls while it runs answer `pending`. Once it finishes, its answer is kept for `cooldownMs`, so
 * an integrator polling every few seconds hears the relayer's word (`submitted`, or `refused` with
 * the reason) instead of starting it again; after that a poll starts a fresh relay, which re-reads
 * the mint and is a no-op if the USDC has arrived. All of this is per instance: two instances may
 * each start one, which `completeBurn` already makes safe (the loser's transaction reverts, and it
 * reports `delivered`).
 */

export type RelayAnswer = Record<string, unknown>;

export interface RelayKickOptions {
  /** Runs the relay: the `/api/sui-stellar/complete` handler, answering its JSON. */
  run(digest: string): Promise<RelayAnswer | null>;
  /**
   * Runs `task` after the response is sent (Next's `after()`). Throws when there is no request to
   * attach it to; the relay then runs without being awaited.
   */
  schedule(task: () => Promise<void>): void;
  cooldownMs?: number;
  /** Most digests remembered; the oldest is forgotten first. */
  maxEntries?: number;
  now?(): number;
}

interface Entry {
  at: number;
  /** Absent while the relay runs. */
  answer?: RelayAnswer | null;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 500;

export function createRelayKick(opts: RelayKickOptions): (digest: string) => Promise<RelayAnswer> {
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();

  function remember(digest: string, entry: Entry) {
    entries.delete(digest);
    entries.set(digest, entry);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return async (digest) => {
    const seen = entries.get(digest);
    if (seen && !("answer" in seen))
      return { status: "pending", reason: "already being completed" };
    if (seen && now() - seen.at < cooldownMs && seen.answer) return seen.answer;

    remember(digest, { at: now() });
    const task = async () => {
      let answer: RelayAnswer | null = null;
      try {
        answer = await opts.run(digest);
      } catch (err) {
        console.error("sui-stellar relay kick failed", err);
      }
      remember(digest, { at: now(), answer });
    };
    try {
      opts.schedule(task);
    } catch {
      void task();
    }
    return { status: "scheduled" };
  };
}
