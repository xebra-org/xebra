import { cronJobs } from "convex/server";
import { v } from "convex/values";
import { type MutationCtx, mutation } from "./_generated/server";
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
 * Scheduled cleanup: drop rateWindows older than `PRUNE_OLDER_THAN_MINUTES` minutes. Runs on a
 * Convex cron so the table stays small even when buckets are idle and never receive another hit.
 *
 * See `convex/README.md` and the deployment's cron schedule for how this is registered.
 */
export const pruneOld = mutation({
  args: { nowMs: v.optional(v.number()) },
  handler: async (ctx, { nowMs }) => {
    requireSecret(process.env.XEBRA_API_SECRET ?? "");
    const now = nowMs ?? Date.now();
    const cutoff = Math.floor(now / 60_000) - PRUNE_OLDER_THAN_MINUTES;
    let cursor = undefined as unknown as { _id: string } | undefined;
    while (true) {
      const batch = await ctx.db
        .query("rateWindows")
        .withIndex("by_key_minute", (q) => q.lt("minute", cutoff))
        .take(PRUNE_LIMIT, cursor ? { cursor } : {});
      if (batch.length === 0) break;
      for (const row of batch) await ctx.db.delete(row._id);
      cursor = batch[batch.length - 1];
    }
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

export const crons = cronJobs();
crons.interval("prune old rate windows", { minutes: 1 }, pruneOld, {});
