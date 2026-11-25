# convex/

What must be shared between Vercel instances:

- `irisBudget`: the counter that keeps our calls to Circle's Iris API under its rate limit.
- `apiKeys`: issued API keys, only ever as SHA-256 hashes. See `apiKeys.ts`.
- `rateWindows`: per-key and per-IP request counts in fixed minute windows. See `rateLimit.ts`.
- A cron that drops rateWindows older than 2 minutes, so idle buckets do not leave rows behind.

There used to be a relay here (jobs, retries, a burn watcher, a hot wallet). It is gone. Circle's
Forwarding Service mints on the destination, and a transfer whose forward fails is claimed by its
owner at `/claim`. Nothing in this directory holds a key, funds or anyone's transfer.

## Before anything typechecks here

`_generated/` is checked in, but Convex regenerates it from `schema.ts` and the function
signatures against your own deployment:

```bash
cd apps/web
npx convex dev        # first run: logs in, creates the project, rewrites _generated/
```

`apps/web/tsconfig.json` excludes this directory: the Next.js build must not depend on files a
contributor has not generated. The Next.js routes reach these functions by name through
`makeFunctionReference` (see `lib/server/iris.ts`), which needs no codegen.

## What is public

`irisBudget.acquire`, `irisBudget.rateLimited`, `irisBudget.current`, `apiKeys.create`,
`apiKeys.revoke`, `apiKeys.list`, `apiKeys.authenticate` and `rateLimit.hit`. They are public
because the Next.js server calls them over HTTP, and each takes `secret`, checked against the
appropriate secret on this deployment (`IRIS_BUDGET_SECRET` for `irisBudget`, `XEBRA_API_SECRET`
for `apiKeys` and `rateLimit`). Unguarded, anyone could call `rateLimited` and blind our
delivery status and health check for five and a half minutes, mint themselves an API key, or spend
another integrator's minute. None of it moves money. An unset secret refuses everything.

## Issuing API keys

From `apps/web`, with `CONVEX_URL` (or `NEXT_PUBLIC_CONVEX_URL`) and `XEBRA_API_SECRET` set to this
deployment's values:

```bash
node ../../scripts/with-env.mjs .env.production node scripts/api-keys.mjs new \
  --name "Acme" --owner ops@acme.com [--integrator acme]
node scripts/api-keys.mjs list
node scripts/api-keys.mjs revoke <id>
```

The key is generated in the script, shown once, and never written here: Convex stores its hash and
a 12-character prefix. A revoked key answers 401 within a minute (the guard's cache TTL).

## Scheduled cleanup

`rateLimit.pruneOld` runs every minute via Convex's cron scheduler. It deletes any rateWindows
whose minute is more than 2 minutes old. Each bucket keeps at most its current and previous
minute in normal operation, but buckets that go idle for a while otherwise leave their old rows
behind forever; the cron reclaims that space.

To register the cron on a deployment, run `npx convex dev` or `npx convex deploy` after this file
is in place. Convex reads the exported `crons` object and schedules the job.

## Bundling

`irisBudget.ts` imports `@xebra/cctp-client`, a `workspace:*` package that does not exist on npm, so
Convex bundles it inline from `dist/`. **Build it before `npx convex dev` or `npx convex deploy`:**

```bash
pnpm --filter @xebra/cctp-client build
```

## Environment variables

Set on the Convex deployment (`npx convex env set NAME value`) **and** in the web app's server
environment:

| | |
|---|---|
| `IRIS_BUDGET_SECRET` | Required, the same value in both places. Any long random string |
| `XEBRA_API_SECRET` | Required, the same value in both places, for `apiKeys` and `rateLimit` |

The web app also reads `CONVEX_URL` (or `NEXT_PUBLIC_CONVEX_URL`). If either is missing, the app
counts Iris calls per instance instead of shared, and logs it once.

## Removing the old relay tables

Done for production at the cutover to wrapper v2 ([`docs/cutover-v2.md`](../../../docs/cutover-v2.md)).
For any other deployment created for the relay: it has `relayJobs` and `watcherCursors` tables, and
Convex will not deploy a schema that omits a table which still holds documents, so clear them first
(dashboard → Data → each table → delete all), then `npx convex deploy`. They hold public transaction
hashes and Circle's public attestations; nothing in them is secret or unrecoverable.
