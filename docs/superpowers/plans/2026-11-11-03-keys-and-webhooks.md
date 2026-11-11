# API keys, rate limits and webhooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrators get API keys, fair rate limits, idempotent POSTs and signed webhooks that tell them when a transfer is attested, delivered, needs a claim or failed.

**Architecture:** State lives in the Convex deployment the web app already uses (today it holds only `irisBudget`). The Next.js `/v1` handlers call Convex with a server secret, as `irisBudget` does. A Convex cron polls Circle for watched transfers through the existing Iris budget and schedules webhook deliveries with Convex's scheduler. Keys are stored only as SHA-256 hashes.

**Tech Stack:** Convex (`convex@^1.45.0`, already in apps/web), Standard Webhooks signing (HMAC-SHA256), plan 1's service layer and schemas.

**Spec:** [`2026-11-11-developer-platform.md`](./2026-11-11-developer-platform.md); depends on plan 1 tasks 3 to 5.

## Global Constraints

- Plan 1's Global Constraints apply.
- Key format `xk_live_` + 32 chars base62 (`crypto.getRandomValues`); stored: `sha256(key)` hex and the first 12 characters as `prefix`. A key is shown once, at creation.
- Anonymous calls stay allowed for read endpoints and `POST /v1/transfers`/`/v1/claims` (they build, never send): 60 requests per minute per IP. Keyed: 600 per minute per key. Webhooks and idempotency need a key.
- Webhook URLs: `https:` only, port 443, the host must not resolve to a private, loopback, link-local or metadata address (check at registration and again at each delivery, against DNS rebinding). Body cap 64 kB, timeout 10 s, no redirects followed.
- Signing: Standard Webhooks headers `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256(secret, id.timestamp.body)>`; secret `whsec_` + 32 bytes base64.
- Retries: 5 s, 30 s, 2 min, 10 min, 1 h, 6 h, 24 h (8 attempts in all); an endpoint failing 50 deliveries in a row is disabled and the key's owner sees it in `/admin`.
- Events: `transfer.attested`, `transfer.delivered`, `transfer.needs_claim`, `transfer.failed`. Payload `{ id, type, createdAt, data: TransferStatus }` (plan 1's schema).
- New env vars: `XEBRA_API_SECRET` (Convex and Vercel), nothing in `NEXT_PUBLIC_*`.
- Webhook delivery is at-least-once; docs say so and tell receivers to dedupe on `webhook-id`.

## Review Focus

1. **A watched transfer Circle never sees** (wrong tx hash, wrong source chain): it stops being polled after 24 h and emits `transfer.failed` with `reason: "not_found"`, not polled forever. Test in task 4.
2. **The same POST retried with one `Idempotency-Key` but a different body:** 422 `idempotency_mismatch`, not the first response. Test in task 3.
3. **A revoked key in flight:** the next request with it answers 401 within one minute (cache TTL), and its webhooks stop. Test in task 2.
4. **Iris budget exhausted:** the poller backs off and resumes; it never makes a call the budget refused. Test in task 4.
5. **Receiver answers 200 slowly (> 10 s):** counted as a failure and retried; the receiver may get the event twice, which the docs state. Test in task 5.

---

### Task 1: Schema and server secret

**Files:**
- Modify: `apps/web/convex/schema.ts` (and its header comment, which says Convex holds one thing)
- Create: `apps/web/convex/auth.ts` (`requireSecret(secret: string): void`, constant-time compare with `XEBRA_API_SECRET`)

Tables: `apiKeys { hash, prefix, name, owner, createdAt, revokedAt?, integrator? }` index `by_hash`; `rateWindows { key, minute, count }` index `by_key_minute`; `idempotency { keyId, idemKey, requestHash, status, body, createdAt }` index `by_key_idem`; `webhookEndpoints { keyId, url, secret, events, disabledAt?, failures }`; `watches { keyId, chain, tx, state, nextPollAt, createdAt }` indexes `by_next_poll`, `by_key_chain_tx`; `deliveries { endpointId, eventId, type, payload, attempt, nextAttemptAt?, lastStatus?, deliveredAt? }`.

- [ ] **Step 1:** Write the schema; `npx convex codegen`; typecheck passes.
- [ ] **Step 2:** Commit `Add API key and webhook tables`.

### Task 2: Keys: issue, revoke, authenticate, rate limit

**Files:**
- Create: `apps/web/convex/apiKeys.ts` (`create`, `revoke`, `list` (admin), `authenticate(hash)`), `apps/web/convex/rateLimit.ts` (`hit(key, limit): { ok, retryAfter }`), `apps/web/lib/api/auth.ts` (`authorize(req): Promise<{ keyId: string | null; integrator: string | null }>` with a 60 s in-memory cache of hash -> key), `/admin` page section "API keys" (create shows the key once; list shows prefix, name, created, last used; revoke)
- Modify: `apps/web/lib/api/http.ts` (call `authorize` and `hit` before `run`; 401 `unauthorized`, 429 `rate_limited` with `Retry-After`; headers `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`)

- [ ] **Step 1:** Failing tests: unknown key 401; revoked key 401 after cache expiry (fake clock); 61st anonymous call in a minute 429 with `Retry-After`; keyed limit 600; the raw key never appears in Convex (assert stored fields).
- [ ] **Step 2:** Implement; admin UI with `redesign-existing-projects` skill per the user's rule; commit `Issue API keys and rate-limit the API`.

### Task 3: Idempotency for POST

**Files:**
- Create: `apps/web/convex/idempotency.ts`; Modify `lib/api/http.ts`

- [ ] **Step 1:** Failing tests: same key + same body returns the stored response with `Idempotent-Replayed: true`; same key + different body 422 `idempotency_mismatch`; concurrent first use: one runs, the other gets 409 `idempotency_in_progress`; entries expire after 24 h.
- [ ] **Step 2:** Implement; add both codes to `ApiErrorCode`, the schemas, `openapi.json` and the docs error pages; commit `Make POST requests idempotent`.

### Task 4: Watches and the poller

**Files:**
- Create: `apps/web/convex/watches.ts` (`watch`, `poll` internal action, cron every 30 s in `convex/crons.ts`), `apps/web/app/v1/transfers/[chain]/[tx]/watch/route.ts` (POST, key required)
- Reuse: plan 1's `transferStatus` logic, called from Convex through `https://xebra.exchange/v1/transfers/{chain}/{tx}` with the server secret header, so the Iris budget and status rules stay in one place.

- [ ] **Step 1:** Failing tests on the state machine (pure function `nextWatch(prev, status, now)`): pending -> attested -> delivered emits two events; pending for 24 h with Circle 404 -> failed `not_found`; `needs_claim` emits once, not every poll; poll interval 15 s for the first 30 min, then 2 min, then 10 min after 6 h; budget refusal leaves `nextPollAt` +30 s and emits nothing.
- [ ] **Step 2:** Implement; `POST /v1/transfers` with a key and `watch: true` creates the watch when the client later reports the tx (the SDK's `waitForDelivery` reports it automatically); commit `Watch transfers and emit events`.

### Task 5: Webhook endpoints and delivery

**Files:**
- Create: `apps/web/app/v1/webhooks/route.ts` (POST create, GET list), `app/v1/webhooks/[id]/route.ts` (DELETE), `app/v1/webhooks/[id]/test/route.ts` (POST sends a `ping`), `apps/web/convex/webhooks.ts` (`deliver` internal action using the scheduler), `packages/sdk/src/webhooks.ts` (`verifyWebhook(secret, headers, body): XebraEvent`, throws on bad signature or timestamp older than 5 min)

- [ ] **Step 1:** Failing tests: registration refuses `http:`, `https://127.0.0.1`, `https://169.254.169.254`, a host resolving to `10.0.0.5` (fake resolver); signature matches the Standard Webhooks reference vector; retry schedule exactly as in Global Constraints; slow receiver (> 10 s) counts as failure; 50 failures disable; `verifyWebhook` round-trips and rejects a tampered body and a stale timestamp.
- [ ] **Step 2:** Implement; add the endpoints to the schemas and `openapi.json`; fill in `guides/webhooks.mdx` in the docs (plan 2) with a verified receiver example; commit `Deliver signed webhooks`.
- [ ] **Step 3 (user):** set `XEBRA_API_SECRET` in Convex production and Vercel, `npx convex deploy`, redeploy web.
