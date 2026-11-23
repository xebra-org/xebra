import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireSecret } from "./auth";

/**
 * Issued API keys. Only `sha256(key)` is stored, never the key: `scripts/api-keys.mjs` generates
 * the key, shows it once, and sends the hash here. A key identifies an integrator for rate limits;
 * it authorises nothing else, and this table holds no funds and no addresses.
 *
 * Every function takes `secret`, checked against `XEBRA_API_SECRET` (`convex/auth.ts`).
 */

export const create = mutation({
  args: {
    secret: v.string(),
    hash: v.string(),
    prefix: v.string(),
    name: v.string(),
    owner: v.string(),
    integrator: v.optional(v.string()),
    nowMs: v.number(),
  },
  handler: async (ctx, a) => {
    requireSecret(a.secret);
    const existing = await ctx.db
      .query("apiKeys")
      .withIndex("by_hash", (q) => q.eq("hash", a.hash))
      .unique();
    if (existing) throw new Error("that key already exists");
    return await ctx.db.insert("apiKeys", {
      hash: a.hash,
      prefix: a.prefix,
      name: a.name,
      owner: a.owner,
      createdAt: a.nowMs,
      ...(a.integrator !== undefined ? { integrator: a.integrator } : {}),
    });
  },
});

export const revoke = mutation({
  args: { secret: v.string(), id: v.id("apiKeys"), nowMs: v.number() },
  handler: async (ctx, { secret, id, nowMs }) => {
    requireSecret(secret);
    const doc = await ctx.db.get(id);
    if (!doc) throw new Error("no such key");
    if (doc.revokedAt === undefined) await ctx.db.patch(id, { revokedAt: nowMs });
  },
});

/** The fields the `/v1` guard needs, or null when no such key was issued. */
export const authenticate = query({
  args: { secret: v.string(), hash: v.string() },
  handler: async (ctx, { secret, hash }) => {
    requireSecret(secret);
    const doc = await ctx.db
      .query("apiKeys")
      .withIndex("by_hash", (q) => q.eq("hash", hash))
      .unique();
    if (!doc) return null;
    return {
      id: doc._id as string,
      integrator: doc.integrator ?? null,
      revokedAt: doc.revokedAt ?? null,
    };
  },
});

/** For operators: prefix, label and dates, never the hash. Newest first. */
export const list = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireSecret(secret);
    const docs = await ctx.db.query("apiKeys").collect();
    return docs
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((doc) => ({
        id: doc._id as string,
        prefix: doc.prefix,
        name: doc.name,
        owner: doc.owner,
        integrator: doc.integrator ?? null,
        createdAt: doc.createdAt,
        revokedAt: doc.revokedAt ?? null,
      }));
  },
});
