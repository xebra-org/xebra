# @xebra/api

tRPC + thin REST facade over Postgres (docs/architecture.md §8). Part of the intent rail, which is
not deployed, and nothing in apps/web calls it: the only page that did, `/intent/[hash]`, was removed
on 2026-11-04.
Route handlers stay thin: `quote.ts` (the CCTP-vs-intent/swap routing decision) and
`repositories.ts` (the only Drizzle call sites) hold the real logic; `router.ts` just wires zod
validation to them.

## Endpoints

- `chains` — all known chains.
- `corridors` — active (sourceChain, destChain) pairs.
- `quote({ sourceChain, destChain, destAsset })` — the authoritative routing decision for the
  intent rail (`@xebra/router-core`'s rule; the bridge screen no longer calls it).
- `intentStatus({ intentHash })` — an intent + its claim (if any), the same data a challenger or
  the frontend's status page reads.

## Run

```bash
DATABASE_URL=postgres://xebra:xebra@localhost:5432/xebra PORT=4000 pnpm dev
```

Verified against a live server + Postgres instance (not just typechecked): seeded a corridor,
USDC asset, and intent, started the server, and confirmed `corridors`, `quote` (both rails —
native-USDC routes `cctp-direct`, everything else `intent-swap`), and `intentStatus` all return
correct data over real HTTP, including superjson round-tripping `Date`/`bigint`-shaped fields
correctly.

Uses tRPC's standalone HTTP adapter with a `superjson` transformer (needed because `IntentV2`
carries `Date`/numeric-string fields) — a client must serialize query input the same way
(`@trpc/client`'s httpBatchLink handles this automatically; a raw HTTP call needs to wrap the
input in `{"json": ...}`).
