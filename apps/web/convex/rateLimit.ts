import { v } from "convex/values";
import { type MutationCtx, internalMutation, mutation } from "./_generated/server";
import { requireSecret } from "./auth";

/**
 * The counter behind `/v1`'s per-key and per-IP limits.
 *
 * Vercel runs many short-lived instances, so an in-memory counter would see a fraction of the
 * traffic. A Convex mutation is serializable: read, increment and write are one atomic step, and
 * two instances asking at the same instant cannot both be told there is room for the last request.
 *
 * Windows are fixed minutes, because that is what `Retry-After` can explain simply. `bucket` is
 * `key:<id>` or `ip:<address>`; the web app decides which, and this file only counts.
 */

/** How many old windows to clear per hit; a bucket normally has one or two. */
const PRUNE_LIMIT = 20;

/**
 * How old a window must be before the scheduled cleanup will delete it. Two minutes gives every
 * caller time to hit the Retry-After value and a little more, and keeps the table small.
 */
export const PRUNE_OLDER_THAN_MINUTES = 2;

/**
 * Most windows one cleanup run deletes. It runs every minute, so a backlog clears over a few runs
 * while each run stays well inside a mutation's write limits.
 */
const PRUNE_BATCH = 500;

/**
 * Scheduled cleanup (`convex/crons.ts`): drop rateWindows older than `PRUNE_OLDER_THAN_MINUTES`,
 * for every bucket, so the table stays small even for buckets that never receive another hit.
 *
 * An internal mutation: only the cron scheduler can call it, so it needs no secret. The cutoff is
 * computed from the server's clock, never passed in.
 */
export const pruneOld = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Math.floor(Date.now() / 60_000) - PRUNE_OLDER_THAN_MINUTES;
    const old = await ctx.db
      .query("rateWindows")
      .withIndex("by_minute", (q) => q.lt("minute", cutoff))
      .take(PRUNE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
  },
});

export const hit = mutation({
  args: { secret: v.string(), bucket: v.string(), minute: v.number() },
  handler: async (ctx, { secret, bucket, minute }) => {
    requireSecret(secret);
    const row = await ctx.db
      .query("rateWindows")
      .withIndex("by_key_minute", (q) => q.eq("key", bucket).eq("minute", minute))
      .unique();

    if (row) {
      await ctx.db.patch(row._id, { count: row.count + 1 });
      await prune(ctx, bucket, minute);
      return row.count + 1;
    }

    await ctx.db.insert("rateWindows", { key: bucket, minute, count: 1 });
    await prune(ctx, bucket, minute);
    return 1;
  },
});

/** Drop windows for this bucket that can no longer be asked about, so the table stays small. */
async function prune(ctx: MutationCtx, bucket: string, minute: number): Promise<void> {
  const old = await ctx.db
    .query("rateWindows")
    .withIndex("by_key_minute", (q) => q.eq("key", bucket).lt("minute", minute - 1))
    .take(PRUNE_LIMIT);
  for (const row of old) await ctx.db.delete(row._id);
}
