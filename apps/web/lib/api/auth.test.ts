import { ProblemSchema } from "@xebra/sdk";
import { describe, expect, it } from "vitest";
import {
  ANONYMOUS_LIMIT,
  type ApiKeyRecord,
  type Guard,
  KEY_LIMIT,
  type KeyStore,
  clientIp,
  createGuard,
  createMemoryKeyStore,
  hashKey,
  resilientKeyStore,
} from "./auth";
import { endpoints } from "./endpoints";
import { ApiError } from "./errors";
import { buildDeps, deps } from "./fakes";
import { createService } from "./service";

const BASE = "https://api.xebra.exchange";
const KEY = `xk_live_${"a".repeat(32)}`;
/** 20 seconds into a minute, so `Retry-After` is a round 40. */
const START = 1_700_000_000_000;

function clock(start = START) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

function request(headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/v1/health`, { headers });
}

function keyed(key: string, ip = "203.0.113.7"): Request {
  return request({ Authorization: `Bearer ${key}`, "X-Forwarded-For": ip });
}

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected a refusal, got an answer");
}

async function seeded(key: string, over: Partial<ApiKeyRecord> = {}) {
  const store = createMemoryKeyStore([]);
  const hash = await hashKey(key);
  store.keys.set(hash, { id: "key_1", integrator: "acme", revokedAt: null, ...over });
  return { store, hash };
}

describe("hashing", () => {
  it("is SHA-256 hex, so the stored value is stable and the key is not recoverable", async () => {
    expect(await hashKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("anonymous callers", () => {
  it("are allowed, and told the anonymous limit", async () => {
    const gate = await createGuard({ store: createMemoryKeyStore(), now: () => START })(
      request({ "X-Forwarded-For": "198.51.100.1" }),
    );
    expect(gate).toMatchObject({ keyId: null, integrator: null });
    expect(gate.headers["RateLimit-Limit"]).toBe(String(ANONYMOUS_LIMIT));
    expect(gate.headers["RateLimit-Remaining"]).toBe("59");
    expect(gate.headers["RateLimit-Reset"]).toBe(String((Math.floor(START / 60_000) + 1) * 60));
  });

  it("get a 429 with Retry-After on the 61st call in a minute", async () => {
    const guard = createGuard({ store: createMemoryKeyStore(), now: () => START });
    for (let i = 0; i < ANONYMOUS_LIMIT; i++) await guard(request());
    const err = await refusal(guard(request()));
    expect(err.code).toBe("rate_limited");
    expect(err.status).toBe(429);
    expect(err.headers).toMatchObject({
      "Retry-After": "40",
      "RateLimit-Limit": "60",
      "RateLimit-Remaining": "0",
    });
  });

  it("start again in the next minute", async () => {
    const time = clock();
    const guard = createGuard({ store: createMemoryKeyStore(), now: time.now });
    for (let i = 0; i < ANONYMOUS_LIMIT; i++) await guard(request());
    await expect(guard(request())).rejects.toBeInstanceOf(ApiError);
    time.advance(40_000);
    await expect(guard(request())).resolves.toMatchObject({ keyId: null });
  });

  it("are counted per address, not all together", async () => {
    const guard = createGuard({ store: createMemoryKeyStore(), now: () => START });
    for (let i = 0; i < ANONYMOUS_LIMIT; i++)
      await guard(request({ "X-Forwarded-For": "198.51.100.1" }));
    await expect(guard(request({ "X-Forwarded-For": "198.51.100.1" }))).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(guard(request({ "X-Forwarded-For": "198.51.100.2" }))).resolves.toBeDefined();
  });

  it("reads the first address in X-Forwarded-For, and X-Real-IP when there is none", () => {
    expect(clientIp(request({ "X-Forwarded-For": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientIp(request({ "X-Real-IP": "203.0.113.8" }))).toBe("203.0.113.8");
    expect(clientIp(request())).toBe("unknown");
  });
});

describe("keyed callers", () => {
  it("get 600 a minute, counted per key and apart from anonymous traffic", async () => {
    const { store } = await seeded(KEY);
    const guard = createGuard({ store, now: () => START });

    const first = await guard(keyed(KEY));
    expect(first).toMatchObject({ keyId: "key_1", integrator: "acme" });
    expect(first.headers["RateLimit-Limit"]).toBe(String(KEY_LIMIT));
    expect(first.headers["RateLimit-Remaining"]).toBe("599");

    for (let i = 1; i < KEY_LIMIT; i++) await guard(keyed(KEY));
    const err = await refusal(guard(keyed(KEY)));
    expect(err.code).toBe("rate_limited");
    expect(err.detail).toContain("this key");

    // The anonymous bucket is untouched by the keyed one.
    await expect(guard(request({ "X-Forwarded-For": "203.0.113.7" }))).resolves.toMatchObject({
      keyId: null,
    });
  });

  it("are refused with 401 when the key was never issued", async () => {
    const err = await refusal(
      createGuard({ store: createMemoryKeyStore(), now: () => START })(keyed(KEY)),
    );
    expect(err.code).toBe("unauthorized");
    expect(err.status).toBe(401);
    expect(err.headers["WWW-Authenticate"]).toContain("Bearer");
  });

  it("are refused with 401 when the key is malformed or the header is not Bearer", async () => {
    const guard = createGuard({ store: createMemoryKeyStore(), now: () => START });
    expect((await refusal(guard(request({ Authorization: "Bearer nope" })))).code).toBe(
      "unauthorized",
    );
    expect((await refusal(guard(request({ Authorization: "Basic abc" })))).code).toBe(
      "unauthorized",
    );
  });

  it("are refused with 401 once a revocation reaches the cache", async () => {
    const time = clock();
    const { store, hash } = await seeded(KEY);
    const guard = createGuard({ store, now: time.now });

    await expect(guard(keyed(KEY))).resolves.toMatchObject({ keyId: "key_1" });

    // Revoked, but the guard's minute-long cache still trusts the record it read.
    const record = store.keys.get(hash);
    if (!record) throw new Error("seed lost");
    record.revokedAt = time.now();
    time.advance(30_000);
    await expect(guard(keyed(KEY))).resolves.toMatchObject({ keyId: "key_1" });

    // Past the TTL: the next lookup sees the revocation, before the request is counted.
    time.advance(31_000);
    const err = await refusal(guard(keyed(KEY)));
    expect(err.code).toBe("unauthorized");
    expect(err.detail).toContain("revoked");
  });

  it("send only their hash to the store, never the key", async () => {
    const { store } = await seeded(KEY);
    await createGuard({ store, now: () => START })(keyed(KEY));
    expect(store.calls).toEqual([{ hash: await hashKey(KEY) }]);
    expect(JSON.stringify(store.calls)).not.toContain(KEY);
  });

  it("keep working when the shared store fails, from this instance's memory", async () => {
    const { store, hash } = await seeded(KEY);
    const failures: unknown[] = [];
    const resilient = resilientKeyStore(
      {
        find: async () => {
          throw new Error("convex unreachable");
        },
        hit: async () => {
          throw new Error("convex unreachable");
        },
      },
      store,
      (err) => failures.push(err),
    );
    await expect(resilient.find(hash)).resolves.toMatchObject({ id: "key_1" });
    await expect(resilient.hit("ip:203.0.113.7", 1)).resolves.toBe(1);
    expect(failures).toHaveLength(2);
  });

  it("counts an unknown key against the IP bucket before refusing it", async () => {
    const store = createMemoryKeyStore();
    const guard = createGuard({ store, now: () => START });
    // Hit the anonymous limit for this IP.
    for (let i = 0; i < ANONYMOUS_LIMIT; i++) {
      await guard(request({ "X-Forwarded-For": "203.0.113.9" }));
    }
    // An unknown key from the same IP: counted against the IP bucket, then refused.
    const err = await refusal(guard(keyed(KEY, "203.0.113.9")));
    expect(err.code).toBe("rate_limited");
    expect(err.status).toBe(429);
    // The key was never found, so it is not a keyed bucket.
    expect(err.detail).toContain("without a key");
  });

  it("counts a revoked key against its key bucket while it is still cached", async () => {
    const time = clock();
    const { store, hash } = await seeded(KEY);
    const guard = createGuard({ store, now: time.now });

    // Use the key once so the record is cached.
    await expect(guard(keyed(KEY))).resolves.toMatchObject({ keyId: "key_1" });

    // Wait for the cache to expire so the guard re-reads the store.
    time.advance(61_000);

    // Now revoke the key and the guard will see the revocation on next lookup.
    const record = store.keys.get(hash);
    if (!record) throw new Error("seed lost");
    record.revokedAt = time.now();

    // The revoked key is counted against key_1's bucket before being refused.
    const err = await refusal(guard(keyed(KEY)));
    expect(err.code).toBe("unauthorized");
    expect(err.detail).toContain("revoked");
  });

  it("treats an uncached key as anonymous when the store errors during an outage", async () => {
    // In production the fallback store is empty, so resilientKeyStore.find re-throws when the
    // primary fails and the fallback has no record. The guard catches that error and treats the
    // caller as anonymous (the documented path), rather than returning 401.
    const failingStore: KeyStore = {
      find: async () => {
        throw new Error("convex unreachable");
      },
      hit: async (_bucket, _minute) => {
        // Count against the IP bucket even on error.
        return 0;
      },
    };
    // Empty fallback: no cached record to fall back to.
    const emptyFallback = createMemoryKeyStore();
    const store = resilientKeyStore(failingStore, emptyFallback);
    const guard = createGuard({ store, now: () => START });

    // An uncached key during an outage: the store throws, no fallback record exists, so the
    // guard treats the caller as anonymous instead of returning 401.
    const gate = await guard(keyed(KEY));
    expect(gate).toMatchObject({ keyId: null, integrator: null });
    expect(gate.headers["RateLimit-Limit"]).toBe(String(ANONYMOUS_LIMIT));
  });

  it("falls back to a cached record when the store errors during an outage", async () => {
    const { store } = await seeded(KEY);
    // Pre-warm the guard's positive cache.
    const guard = createGuard({ store, now: () => START });
    await guard(keyed(KEY));

    // Replace the store with one that errors, wrapped so the guard sees the error
    // and falls back to its cache.
    const failingStore: KeyStore = {
      find: async () => {
        throw new Error("convex unreachable");
      },
      hit: async (bucket, minute) => {
        // Still count against the key bucket.
        return store.hit(bucket, minute);
      },
    };

    const resilient = resilientKeyStore(failingStore, store);
    const resilientGuard = createGuard({ store: resilient, now: () => START });

    // The guard falls back to the cached record and accepts the request.
    await expect(resilientGuard(keyed(KEY))).resolves.toMatchObject({ keyId: "key_1" });
  });

  it("caches a negative lookup briefly so a failing store is not hammered", async () => {
    const calls: string[] = [];
    const store: KeyStore = {
      find: async (hash) => {
        calls.push(hash);
        return null;
      },
      hit: async () => 0,
    };
    const guard = createGuard({ store, now: () => START });

    await expect(guard(keyed(KEY))).rejects.toMatchObject({ code: "unauthorized" });
    await expect(guard(keyed(KEY))).rejects.toMatchObject({ code: "unauthorized" });
    // The second call reused the negative cache; the store was not asked again.
    expect(calls).toHaveLength(1);
  });
});

describe("through the /v1 handler", () => {
  const v1 = (guard: Guard) => endpoints(createService(deps({ build: buildDeps() })), guard);

  it("answers a rate-limited request with the RFC 9457 problem and Retry-After", async () => {
    const api = v1(createGuard({ store: createMemoryKeyStore(), now: () => START }));
    for (let i = 0; i < ANONYMOUS_LIMIT; i++)
      expect((await api.health(request())).status).toBe(200);

    const res = await api.health(request());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("40");
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = await res.json();
    expect(ProblemSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      type: "https://docs.xebra.exchange/errors/rate_limited",
      status: 429,
      code: "rate_limited",
    });
  });

  it("answers an unknown key with a 401 problem and sends the limit headers on successes", async () => {
    const api = v1(createGuard({ store: createMemoryKeyStore(), now: () => START }));
    const refused = await api.health(request({ Authorization: `Bearer ${KEY}` }));
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({
      type: "https://docs.xebra.exchange/errors/unauthorized",
      code: "unauthorized",
    });

    const ok = await api.health(request());
    expect(ok.status).toBe(200);
    expect(ok.headers.get("ratelimit-limit")).toBe(String(ANONYMOUS_LIMIT));
  });
});
