import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Convex holds the state that must be shared between Vercel instances and must not live in one:
 *
 * - `irisBudget`: the counter that keeps our calls to Circle's Iris API under its rate limit
 *   (`irisBudget.ts`).
 * - `apiKeys`: issued API keys, stored only as SHA-256 hashes (`apiKeys.ts`).
 * - `rateWindows`: per-key and per-IP request counts, in fixed minute windows (`rateLimit.ts`).
 *
 * There used to be relay state in this file — jobs, retry schedules, a burn-watcher cursor. The
 * relay is gone: Circle's Forwarding Service mints on the destination, and a transfer whose
 * forward fails is claimed by its owner at `/claim`. None of it holds funds, a private key or
 * anyone's transfer, so losing this database costs a few seconds of rate-limit memory, and the API
 * keys, which can be issued again.
 */

export default defineSchema({
  irisBudget: defineTable({
    /** A single row, addressed by name so a second budget (a different Circle host) needs no
     *  schema change. */
    key: v.string(),
    /** The whole second (`floor(ms / 1000)`) `count` belongs to. */
    second: v.number(),
    count: v.number(),
    /** Calls made in the second before `second`. */
    prevCount: v.number(),
    /** Epoch ms until which we stay off Iris after a 429; 0 when not blocked. */
    blockedUntil: v.number(),
  }).index("by_key", ["key"]),

  /**
   * One row per issued key. `hash` is `sha256(key)` hex and the only form of the key stored
   * anywhere; `prefix` is the key's first 12 characters, shown in listings so a person can tell
   * keys apart. Revoking sets `revokedAt`, which the guard sees within a minute.
   */
  apiKeys: defineTable({
    hash: v.string(),
    prefix: v.string(),
    /** A label for the key, chosen when it is issued. */
    name: v.string(),
    /** Who to contact about this key, such as an email address. */
    owner: v.string(),
    integrator: v.optional(v.string()),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  }).index("by_hash", ["hash"]),

  /**
   * Request counts per minute window. `key` is `key:<id>` or `ip:<address>`, so a key's traffic and
   * an address's traffic never share a counter. Old windows are pruned as new ones are written.
   */
  rateWindows: defineTable({
    key: v.string(),
    /** The whole minute (`floor(ms / 60000)`) `count` belongs to. */
    minute: v.number(),
    count: v.number(),
  })
    .index("by_key_minute", ["key", "minute"])
    .index("by_minute", ["minute"]),
});
