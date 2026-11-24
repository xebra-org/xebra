#!/usr/bin/env node
/**
 * Issues, lists and revokes Xebra API keys.
 *
 *   node scripts/api-keys.mjs new --name "Acme" --owner ops@acme.com [--integrator acme]
 *   node scripts/api-keys.mjs list
 *   node scripts/api-keys.mjs revoke <id>
 *
 * Run it from `apps/web`, with `CONVEX_URL` (or `NEXT_PUBLIC_CONVEX_URL`) and `XEBRA_API_SECRET`
 * set to the deployment's values:
 *
 *   node ../../scripts/with-env.mjs .env.production node scripts/api-keys.mjs new --name Acme \
 *     --owner ops@acme.com
 *
 * The key is generated here and never leaves this process: Convex stores only its SHA-256 hash and
 * a short prefix. It is printed once, at creation, and cannot be shown again.
 */

import { createHash, randomBytes } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function key() {
  // 32 base62 characters from rejection-free random bytes (248 is 4 * 62).
  let out = "";
  while (out.length < 32) {
    for (const byte of randomBytes(64)) {
      if (byte >= 248) continue;
      out += BASE62[byte % 62];
      if (out.length === 32) break;
    }
  }
  return `xk_live_${out}`;
}

function usage() {
  console.error(`usage:
  node scripts/api-keys.mjs new --name <label> --owner <who to contact> [--integrator <id>]
  node scripts/api-keys.mjs list
  node scripts/api-keys.mjs revoke <id>`);
  process.exit(2);
}

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const convexUrl = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
const secret = process.env.XEBRA_API_SECRET;
if (!convexUrl || !secret) {
  console.error("FAIL: set CONVEX_URL (or NEXT_PUBLIC_CONVEX_URL) and XEBRA_API_SECRET.");
  process.exit(1);
}

const client = new ConvexHttpClient(convexUrl);
const [command, arg] = process.argv.slice(2);

if (command === "new") {
  const name = flag("name");
  const owner = flag("owner");
  if (!name || !owner) usage();
  const raw = key();
  const id = await client.mutation("apiKeys:create", {
    secret,
    hash: createHash("sha256").update(raw).digest("hex"),
    prefix: raw.slice(0, 12),
    name,
    owner,
    ...(flag("integrator") ? { integrator: flag("integrator") } : {}),
    nowMs: Date.now(),
  });
  console.log(`Created ${name} (${id}).`);
  console.log(`\n  ${raw}\n`);
  console.log("This key is shown once. It is stored only as a hash after this.");
} else if (command === "list") {
  const keys = await client.query("apiKeys:list", { secret });
  if (keys.length === 0) console.log("No keys.");
  for (const k of keys) {
    const state = k.revokedAt ? "revoked" : "live";
    const integ = k.integrator ? ` integrator=${k.integrator}` : "";
    console.log(
      `${k.id}  ${k.prefix}…  ${state}  ${new Date(k.createdAt).toISOString()}  ${k.name}  ${k.owner}${integ}`,
    );
  }
} else if (command === "revoke") {
  if (!arg) usage();
  await client.mutation("apiKeys:revoke", { secret, id: arg, nowMs: Date.now() });
  console.log(`Revoked ${arg}. Requests with it answer 401 within a minute.`);
} else {
  usage();
}
