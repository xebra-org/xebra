import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  type ApiKeyRecord,
  type Guard,
  type KeyStore,
  createGuard,
  createMemoryKeyStore,
  resilientKeyStore,
} from "../api/auth";

/**
 * Where API keys and rate-limit windows actually live: the Convex deployment the web app already
 * uses for the Iris budget. See `convex/apiKeys.ts`, `convex/rateLimit.ts` and
 * `convex/README.md`.
 *
 * `authenticate` returns only the fields the guard needs — never the hash, and never the key,
 * which Convex never sees. `rateLimit.hit` is a mutation, so read-count-write is one atomic step
 * across every Vercel instance.
 *
 * Convex calls are raced against a clock because a hung connection would otherwise block every
 * keyed request. When the clock wins, the call is treated as a store failure (item 2).
 *
 * With `CONVEX_URL` or `XEBRA_API_SECRET` unset, this counts per instance and recognises no keys:
 * anonymous traffic still works, and keys are refused as unknown. The warning is logged once.
 */

const authenticate = makeFunctionReference<"query">("apiKeys:authenticate");
const hit = makeFunctionReference<"mutation">("rateLimit:hit");

/** How long a Convex call is allowed to run before the store falls back to its resilience path. */
export const CONVEX_CALL_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`convex call ${label} timed out after ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]) as Promise<T>;
}

export function convexKeyStore(convexUrl: string, secret: string): KeyStore {
  const client = new ConvexHttpClient(convexUrl);
  return {
    async find(hash) {
      return (await withTimeout(
        client.query(authenticate, { secret, hash }),
        CONVEX_CALL_MS,
        "authenticate",
      )) as ApiKeyRecord | null;
    },
    async hit(bucket, minute) {
      return (await withTimeout(
        client.mutation(hit, { secret, bucket, minute }),
        CONVEX_CALL_MS,
        "rateLimit:hit",
      )) as number;
    },
  };
}

function liveStore(): KeyStore {
  const convexUrl = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  const secret = process.env.XEBRA_API_SECRET;
  if (!convexUrl || !secret) {
    console.warn(
      "api keys: CONVEX_URL or XEBRA_API_SECRET unset, so no key can be checked and limits count per instance",
    );
    return createMemoryKeyStore();
  }
  let warned = false;
  return resilientKeyStore(convexKeyStore(convexUrl, secret), createMemoryKeyStore(), (err) => {
    if (warned) return;
    warned = true;
    console.warn(
      `api keys: the shared store failed, counting per instance (${err instanceof Error ? err.message : err})`,
    );
  });
}

type Shared = { store: KeyStore };
const SLOT = Symbol.for("xebra.apiKeys");

/** One store per server instance; module state would be rebuilt on every hot reload in dev. */
function shared(): Shared {
  const g = globalThis as unknown as Record<symbol, Shared | undefined>;
  const existing = g[SLOT];
  if (existing) return existing;
  const value = { store: liveStore() };
  g[SLOT] = value;
  return value;
}

export function apiGuard(): Guard {
  return createGuard({ store: shared().store });
}
