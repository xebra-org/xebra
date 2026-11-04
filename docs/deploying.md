# Deploying

Two services, both with free tiers: **Vercel** serves the UI and its server routes, **Convex** holds
one counter. There is no AWS, no Docker, no Redis, no Kafka and no Postgres in this deployment.

## What runs where

Nothing of ours mints. Circle's Forwarding Service mints on the destination and pays the gas
([`forwarding-wrapper.md`](./forwarding-wrapper.md)), and a transfer whose forward fails is claimed by
its owner at `/claim`. The relay that used to mint from a Convex cron and a Solana hot wallet was
removed ([`relay-removal.md`](./relay-removal.md)), so there is no key or gas float to keep funded.

| | |
|---|---|
| Vercel | The pages, and the server routes the browser cannot do itself: `/api/circle-health` (pre-flight), `/api/delivery` (Circle's forward state for a burn), `/api/attestation`, `/api/reattest`, `/api/recipient`, `/api/solana-rpc` |
| Convex | `irisBudget`: one counter that keeps every instance's calls to Circle's Iris API under its rate limit. No cron, no keys, no funds |

### Why the counter is shared

Iris allows 40 requests per second and blocks a caller for five minutes above it. Vercel runs many
instances, so a count kept in one instance's memory does not bound the total. The counter lives in
Convex because its mutations are serializable: a read and a write in one transaction. If Convex is
unreachable, or `CONVEX_URL` or `IRIS_BUDGET_SECRET` is unset, each instance counts alone and the app
keeps working (`apps/web/lib/server/iris.ts`).

## Setup

### 1. Convex

```bash
pnpm --filter @xebra/cctp-client build   # convex bundles it from dist/
cd apps/web
npx convex dev                           # logs in, creates the project, rewrites convex/_generated/
```

`_generated/` is committed, and Convex rewrites it against your own deployment. `apps/web`'s
tsconfig excludes `convex/`, and the route handlers reach Convex by name through
`makeFunctionReference` (`lib/server/iris.ts`), so the Next.js build does not depend on having run
this.

Then set the one secret, the same value on the Convex deployment and in Vercel:

```bash
npx convex env set IRIS_BUDGET_SECRET "<long random string>"
```

`npx convex deploy` pushes to production. See [`apps/web/convex/README.md`](../apps/web/convex/README.md).

### 2. Vercel

Import the repo and set **Root Directory to `apps/web`**, with "include files outside the root
directory" enabled so the workspace packages resolve.

`vercel.json` deliberately sets no `outputDirectory`. Every path in it resolves *relative to the
root directory*, so naming `apps/web/.next` there produces `apps/web/apps/web/.next` and the
deploy fails after a completely successful build — the build log shows every route compiled and
then an error about a missing output directory. Vercel's Next.js preset already knows the default
is `.next` under the root.

Public variables, inlined into the browser bundle at build time — so they must be set **before**
the first build, not after. Copy them from `.env.production`:

```
NEXT_PUBLIC_NETWORK
NEXT_PUBLIC_SOROBAN_RPC_URL
NEXT_PUBLIC_HORIZON_URL
NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE
NEXT_PUBLIC_STELLAR_USDC_SAC_ADDRESS
NEXT_PUBLIC_STELLAR_TOKEN_MESSENGER_ADDRESS
NEXT_PUBLIC_SOLANA_CCTP_DOMAIN_ID
NEXT_PUBLIC_SOLANA_RPC_URL
NEXT_PUBLIC_SOLANA_USDC_MINT
NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID          # v2, `cctpWrapperV2` in deployments/mainnet.json
NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_LEGACY_CONTRACT_ID   # optional: v1, read by /admin for its rent only
NEXT_PUBLIC_ARC_ENABLED                               # `1` offers Arc as a destination from Stellar
NEXT_PUBLIC_ARC_SENDS_TO                              # optional: where Arc may send, or `all`
NEXT_PUBLIC_ARC_RECEIVES_FROM                         # optional: EVM chains that may send into Arc
NEXT_PUBLIC_STELLAR_SENDS_TO                          # optional: EVM chains Stellar may send to, or `all`;
                                                      # each is offered once the wrapper commits its domain
NEXT_PUBLIC_ARC_USE_WRAPPER                           # optional: `1` sends through the pinned EVM wrapper
```

Server-side only:

| | |
|---|---|
| `CONVEX_URL` | The deployment URL from `npx convex deploy` |
| `IRIS_BUDGET_SECRET` | The same value as on Convex; a mismatch makes each instance count alone |
| `ADMIN_PASSWORD` | Gates `/admin`; unset or under 16 characters, `/admin` is a 404 ([`admin-panel.md`](./admin-panel.md)) |
| `ADMIN_ALLOWED_IPS` | Optional IP allowlist for `/admin` |

### 3. Check it

```bash
BASE_URL=https://<your deployment> ./scripts/smoke-prod.sh
```

Read-only. Every line must be `ok`; the exit status is the number of failures. `the shared counter is
in use` proves Convex and Vercel agree on `IRIS_BUDGET_SECRET`. A `down` in the Circle lines is
Circle being unhealthy at that moment, not the app.

## What each plan costs

**Convex free:** 1M function calls and 20 GB-hours of action compute per month, 0.5 GB storage.
There is no cron; Convex is called once per Iris call our servers make, and the pre-flight and
delivery routes cache Circle's answers for seconds at a time.

**Vercel Pro, $20/month — for the terms, not the features.** Vercel's fair-use guidelines restrict
Hobby to non-commercial, personal use, and charging a bridge fee is commercial. Hobby is fine while
you are moving your own money to test; nothing here needs Vercel Cron, so a Hobby deployment is
functionally complete rather than crippled.

## Two build details

**`build:vercel` exists because of the dist directory.** Locally, `pnpm build` writes to
`.next-build`, so a production build cannot wipe the directory a running `next dev` is serving
from — when it does, every request fails with `ENOENT: routes-manifest.json`, the build looks
fine, the dev server looks broken, and nothing in either message points at the other process. On
Vercel there is no dev server to protect and Vercel expects `.next`.

**`.env.production` is not in the repo**, deliberately — a `.env` in git reads as a mistake
whatever it contains. `scripts/with-env.mjs` treats a missing file as "use the environment" when
`NETWORK` or `NEXT_PUBLIC_NETWORK` is already set, and still fails loudly on a local checkout where
neither is.

## If a forward fails

`/claim` completes a transfer from the user's own wallet. It fetches Circle's attestation, builds
the `receiveMessage` call for the destination named in the message, and has the user's wallet sign
and pay (Phantom on Solana, the browser's EVM wallet on Arc and the EVM chains). The receipt links to
it with the burn hash already filled in.

The payer does not have to be the recipient: `receiveMessage` mints to the address the burn named
whoever submits it, so a third party can rescue someone else's stuck transfer. When the recipient
has no USDC account yet, the page asks for the destination wallet — a token account address cannot
be reversed into its owner, so there is no way to create one without being told — and checks the
derived address against the burn before anything is signed.

Three server routes exist for it, all because the browser cannot do the work directly:
`/api/attestation` keeps the Iris URL out of the bundle, `/api/reattest` asks Circle to re-sign a Fast
message whose attestation expired, and `/api/solana-rpc` is a method-restricted pass-through, because
Solana's public RPC answers the CORS preflight with 200 and then **403s the actual POST** whenever an
`Origin` header is present.

## Search engines and assistants

The site is https://xebra.exchange. `xebra-sandy.vercel.app` and `www.xebra.exchange` redirect to it;
set both redirects to **308 (permanent)** in Vercel → Domains, since a 307 tells search engines the move
is temporary. The canonical address is pinned in `apps/web/lib/site.ts`, not read from the environment.

What it serves for them, all built from the documents in `apps/web/lib/seo/docs.ts`:

- The written pages (`/how-it-works`, `/fees`, `/routes`, `/security`, `/faq`, `/claim`) and one page per
  live route (`/bridge/stellar-to-solana`…). Stellar routes appear when the wrapper commits their
  domain; route pages, the sitemap and `llms.txt` are re-read hourly.
- Each page's Markdown at `<page>.md` (`/index.md` for the home page), `/llms.txt` and
  `/llms-full.txt`, for assistants.
- `/robots.txt` (AI crawlers named and allowed; previews closed), `/sitemap.xml`, a canonical URL,
  link-preview image (`/og/...`, drawn on first request and cached) and JSON-LD on every page.

Only a build with `VERCEL_ENV=production` is indexable. Once per new domain: verify it in Google Search
Console and Bing Webmaster Tools (a DNS TXT record) and submit `https://xebra.exchange/sitemap.xml`. When a
fee or limit changes on the contracts, update `apps/web/lib/seo/facts.ts` (its test compares it with
`deployments/mainnet.json`) and `CONTENT_UPDATED` in `lib/site.ts`.

## Watching it

There is no hot wallet to drain, so the old balance alerts went with the relay. What is left to
watch is Circle and the deployment itself:

- `scripts/smoke-prod.sh` exits non-zero on any failed check, so it can gate a deploy or run on a
  schedule.
- `GET /api/circle-health?dest=solana` is the endpoint for an uptime monitor. It answers 200 with
  `status` of `ok`, `degraded` or `down` in the body, so the monitor has to match on the body.

## What is still missing

Arc → Base went through on mainnet on 2026-10-15: 0.78 USDC delivered as 0.72577 in 237 seconds,
Circle's `feeExecuted` equal to `maxFee` (forward tx `0xcfd8f187…7563`). The other routes between Arc
and the EVM chains were proven on testnet on 2026-10-14. They call Circle directly and charge no fee of ours: the EVM fee wrapper is
deployed on Arc mainnet but not switched on (`NEXT_PUBLIC_ARC_USE_WRAPPER`,
[`go-live.md`](./go-live.md#turning-on-the-arc-wrapper)). EVM chains → Arc is off in production (`NEXT_PUBLIC_ARC_RECEIVES_FROM`
unset).

Stellar → the EVM chains other than Arc waits on the wrapper, one 48-hour proposal per chain
([`admin-panel.md`](./admin-panel.md#adding-a-chain)). Base (domain 6) was proposed on 2026-10-15 and
can be committed from 2026-10-17 08:15 UTC; Monad (15) is next, then Arbitrum. Production is built with
`NEXT_PUBLIC_STELLAR_SENDS_TO=all`, so each chain appears on the page as its commit lands.
