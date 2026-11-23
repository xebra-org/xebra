import { ApiError } from "./errors";

/**
 * API keys and rate limits for `/v1`.
 *
 * A key identifies an integrator, so their traffic can be counted — and counted higher than
 * anonymous traffic. Requests without a key keep working at a lower limit, so nothing that works
 * today stops working. A key never authorises moving funds: the API is non-custodial and never
 * takes a private key. It only says who is asking.
 *
 * The key itself is never stored. It arrives as `Authorization: Bearer xk_live_...`, is hashed
 * with SHA-256 here, and only the hash goes to the store (`convex/apiKeys.ts`). The store lives in
 * Convex because Vercel runs many short-lived instances that must share one counter; when Convex
 * cannot be reached, `resilientKeyStore` counts per instance instead of failing requests.
 */

export const KEY_PREFIX = "xk_live_";
export const KEY_DOCS = "https://docs.xebra.exchange/guides/api-keys";
/** 32 base62 characters after the prefix. */
const KEY_PATTERN = /^xk_live_[0-9A-Za-z]{32}$/;

/** Per IP, per minute, without a key. */
export const ANONYMOUS_LIMIT = 60;
/** Per key, per minute. */
export const KEY_LIMIT = 600;
/** How long a key's record is trusted, so revocation takes effect within a minute. */
export const KEY_CACHE_MS = 60_000;

export interface ApiKeyRecord {
  id: string;
  integrator: string | null;
  /** Epoch ms, or null while the key is live. */
  revokedAt: number | null;
}

/** What `createGuard` needs from a shared store: key lookups by hash, and a counter per bucket. */
export interface KeyStore {
  find(hash: string): Promise<ApiKeyRecord | null>;
  /** Count this call in `bucket`'s window `minute`, and return the count after it. */
  hit(bucket: string, minute: number): Promise<number>;
}

/** What a guard decided about one request, and the headers that say so. */
export interface Gate {
  keyId: string | null;
  integrator: string | null;
  headers: Record<string, string>;
}

export type Guard = (req: Request) => Promise<Gate>;

/** For surfaces where another layer has already counted and identified the caller. */
export const OPEN_GUARD: Guard = async () => ({ keyId: null, integrator: null, headers: {} });

/** SHA-256 of a key, lowercase hex. The only form of the key that leaves this process. */
export async function hashKey(key: string): Promise<string> {
  // Web Crypto, available in Node 20+ and in a Worker; no dependency, and not a Node-only module.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A `KeyStore` in this instance's memory: for tests, for `next dev` without Convex, and as the
 * fallback when Convex is unreachable. A restart forgets every key.
 */
export interface MemoryKeyStore extends KeyStore {
  keys: Map<string, ApiKeyRecord>;
  windows: Map<string, { minute: number; count: number }>;
  calls: Array<{ hash: string }>;
}

export function createMemoryKeyStore(
  seed: Array<{ hash: string; record: ApiKeyRecord }> = [],
): MemoryKeyStore {
  const keys = new Map(seed.map(({ hash, record }) => [hash, record]));
  const windows = new Map<string, { minute: number; count: number }>();
  const calls: Array<{ hash: string }> = [];
  return {
    keys,
    windows,
    calls,
    async find(hash) {
      // Recorded so a test can assert the raw key never reaches the store.
      calls.push({ hash });
      const record = keys.get(hash);
      // A copy: the guard's cache must not see a revocation until its own TTL expires.
      return record ? { ...record } : null;
    },
    async hit(bucket, minute) {
      const window = windows.get(bucket);
      if (!window || window.minute !== minute) {
        windows.set(bucket, { minute, count: 1 });
        return 1;
      }
      window.count += 1;
      return window.count;
    },
  };
}

/**
 * The shared store, with this instance's memory behind it. A Convex outage must not take the API
 * with it: calls keep a per-instance limit, and a key we cannot check is never trusted.
 *
 * When the primary store throws and the fallback has no record (the common production case: an
 * empty in-memory fallback), `find` re-throws, and the guard counts the caller as anonymous
 * (neither trusted with the key's limit nor refused with a 401). When the
 * fallback does have a record (a seeded test or a recently-cached key), that record is returned
 * so a brief outage does not turn a valid key into a 401.
 */
export function resilientKeyStore(
  primary: KeyStore,
  fallback: KeyStore,
  onError?: (err: unknown) => void,
): KeyStore {
  return {
    async find(hash) {
      try {
        return await primary.find(hash);
      } catch (err) {
        onError?.(err);
        const fallbackRecord = await fallback.find(hash);
        if (fallbackRecord === null) throw err;
        return fallbackRecord;
      }
    },
    async hit(bucket, minute) {
      try {
        return await primary.hit(bucket, minute);
      } catch (err) {
        onError?.(err);
        return fallback.hit(bucket, minute);
      }
    },
  };
}

/** The caller's address as the proxy reports it; all unknown callers share one bucket. */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip")?.trim() || "unknown";
}

function unauthorized(detail: string): ApiError {
  return new ApiError(
    "unauthorized",
    detail,
    {},
    {
      "WWW-Authenticate": 'Bearer realm="xebra", error="invalid_token"',
    },
  );
}

/**
 * The `/v1` gate: identify the caller, then count them. A key that is unknown or revoked is a 401
 * before it costs anything; a caller over its limit is a 429 with `Retry-After`, in the same
 * RFC 9457 shape as every other failure.
 *
 * An unknown-but-well-formed key is counted against the caller's IP before the 401, so a bad actor
 * cannot burn an integrator's limit by sending random keys and bypassing the rate limit. Revoked
 * keys are counted too, while they are still inside the guard's positive cache.
 *
 * When the store itself is unreachable, the guard does not turn a previously valid key into a 401:
 * it reuses the record still in its positive cache, and when there is none it treats the caller as
 * anonymous instead of refusing them. That keeps keys alive briefly during a Convex outage rather
 * than failing every keyed request.
 */
export function createGuard(opts: {
  store: KeyStore;
  now?: () => number;
  anonymousLimit?: number;
  keyLimit?: number;
  cacheMs?: number;
}): Guard {
  const now = opts.now ?? Date.now;
  const anonymousLimit = opts.anonymousLimit ?? ANONYMOUS_LIMIT;
  const keyLimit = opts.keyLimit ?? KEY_LIMIT;
  const cacheMs = opts.cacheMs ?? KEY_CACHE_MS;
  const cached = new Map<string, { at: number; record: ApiKeyRecord }>();
  const MAX_CACHED = 1_000;

  /** Hashes that returned null in the last `cacheMs`. Avoids re-driving a failing store per request. */
  const negative = new Map<string, { at: number }>();
  const NEGATIVE_MS = 1_000;

  async function lookup(hash: string): Promise<ApiKeyRecord | null> {
    const hit = cached.get(hash);
    if (hit && now() - hit.at < cacheMs) return hit.record;

    const neg = negative.get(hash);
    if (neg && now() - neg.at < NEGATIVE_MS) return null;

    const record = await opts.store.find(hash);
    if (!record) {
      negative.set(hash, { at: now() });
      return null;
    }

    if (cached.size >= MAX_CACHED) {
      const oldest = cached.keys().next().value;
      if (oldest !== undefined) cached.delete(oldest);
    }
    // Re-inserted so the map's order stays least-recently-used first.
    cached.delete(hash);
    cached.set(hash, { at: now(), record });
    return record;
  }

  /** Count against the IP bucket even for keys that will be refused. */
  async function countForUnknownIp(req: Request): Promise<number> {
    const bucket = `ip:${clientIp(req)}`;
    const minute = Math.floor(now() / 60_000);
    return opts.store.hit(bucket, minute);
  }

  return async (req) => {
    const header = req.headers.get("authorization");
    let keyId: string | null = null;
    let integrator: string | null = null;

    if (header !== null) {
      const bearer = /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1];
      if (!bearer) {
        throw unauthorized(
          `The Authorization header must be \`Authorization: Bearer ${KEY_PREFIX}...\`. See ${KEY_DOCS}.`,
        );
      }
      if (!KEY_PATTERN.test(bearer)) {
        throw unauthorized(
          `That does not look like a Xebra key: they start with ${KEY_PREFIX} and have 32 characters after it. See ${KEY_DOCS}.`,
        );
      }
      const hash = await hashKey(bearer);
      let record: ApiKeyRecord | null;
      let storeErrored = false;
      try {
        record = await lookup(hash);
      } catch (_err) {
        // Store error: fall back to a cached record, else treat as anonymous (item 3).
        const cachedRecord = cached.get(hash);
        if (cachedRecord) {
          record = cachedRecord.record;
        } else {
          record = null;
          storeErrored = true;
        }
      }

      if (!record) {
        if (storeErrored) {
          // Store error with no cached record: treat as anonymous, not 401.
          keyId = null;
          integrator = null;
        } else {
          // Unknown key: count it against the IP bucket before refusing (item 1).
          const ipCount = await countForUnknownIp(req);
          const minute = Math.floor(now() / 60_000);
          const anonLimit = anonymousLimit;
          // Still refuse, but report the IP limit state in the headers.
          const headers: Record<string, string> = {
            "RateLimit-Limit": String(anonLimit),
            "RateLimit-Remaining": String(Math.max(0, anonLimit - ipCount)),
            "RateLimit-Reset": String((minute + 1) * 60),
          };
          if (ipCount > anonLimit) {
            const retryAfter = Math.max(1, Math.ceil(((minute + 1) * 60_000 - now()) / 1000));
            throw new ApiError(
              "rate_limited",
              `Too many requests: ${anonLimit} a minute without a key. Send an API key for ${keyLimit} a minute, or try again in ${retryAfter} seconds.`,
              {},
              { ...headers, "Retry-After": String(retryAfter) },
            );
          }
          throw unauthorized(`That API key is not one we issued. See ${KEY_DOCS}.`);
        }
      } else if (record.revokedAt !== null) {
        // Revoked key: count against the key bucket while it is still cached.
        const bucket = `key:${record.id}`;
        const minute = Math.floor(now() / 60_000);
        await opts.store.hit(bucket, minute);
        throw unauthorized(`That API key was revoked. See ${KEY_DOCS}.`);
      } else {
        keyId = record.id;
        integrator = record.integrator;
      }
    }

    const limit = keyId ? keyLimit : anonymousLimit;
    const bucket = keyId ? `key:${keyId}` : `ip:${clientIp(req)}`;
    const minute = Math.floor(now() / 60_000);
    const count = await opts.store.hit(bucket, minute);
    const headers: Record<string, string> = {
      "RateLimit-Limit": String(limit),
      "RateLimit-Remaining": String(Math.max(0, limit - count)),
      // Epoch seconds, as `RateLimit-Reset` is specified.
      "RateLimit-Reset": String((minute + 1) * 60),
    };

    if (count > limit) {
      const retryAfter = Math.max(1, Math.ceil(((minute + 1) * 60_000 - now()) / 1000));
      throw new ApiError(
        "rate_limited",
        keyId
          ? `Too many requests: this key is limited to ${limit} a minute. Try again in ${retryAfter} seconds.`
          : `Too many requests: ${limit} a minute without a key. Send an API key for ${keyLimit} a minute, or try again in ${retryAfter} seconds.`,
        {},
        { ...headers, "Retry-After": String(retryAfter) },
      );
    }

    return { keyId, integrator, headers };
  };
}
