# Removing the relay

**Status (2026-10-14): done.** The removal was merged to `main` on 2026-09-30 (87fa729) together with
the web app's move to wrapper v2, and is live: production answers 404 on `/api/relay/*` and
`/api/health`, and Convex holds only the Iris rate counter. The "before cutover" items below were
carried out ([`cutover-v2.md`](./cutover-v2.md)); the docs listed as describing the relay have been
rewritten. The "Left alone on purpose" list still stands.

Decision, 2026-09-21: there is no relay. Circle's Forwarding Service mints on the destination, and a
transfer whose forward fails is claimed by its owner at `/claim`. Why, and what protects users
instead: [`forwarding-wrapper.md`](./forwarding-wrapper.md), "No relay".

This branch (`forwarding-v2`) contains the code removal. **It cannot be deployed while the web app
points at wrapper v1**: v1 burns are not forwarded, and nothing mints them any more. Cut over in one
step, after v2 is on mainnet and its domains are committed.

## Done on this branch

- Deleted: `apps/cctp-relay`, `packages/relay-core`, the Convex relay (`relay.ts`, `jobs.ts`,
  `crons.ts`, `cursors.ts`), `/api/relay/*`, the relay `/api/health`, `lib/relay.ts`, the Solana and
  Arc mint submitters and key decoders, `cctp-client`'s `relay-job` and `route-mint`.
- Kept: `receive-message` in `cctp-solana` and `cctp-evm` (what `/claim` builds its mint from), and
  `readDestinationDomain` (now `cctp-client/src/message.ts`).
- Added: `iris-budget` (rate counter), `circle-health` (pre-flight), `delivery` (Iris forward state),
  `convex/irisBudget.ts`, `/api/circle-health`, `/api/delivery`, and the receipt and Bridge button
  changes in `app/page.tsx`.

## Still to do before cutover

Web app, in `apps/web`: **done 2026-09-24**, checked against the v2 contract on testnet (read-only):

- Speaks wrapper v2: `recipient_owner` in `BridgeRequest`, `quote(amount, needs_account,
  destination_domain, max_fee)`, the new `Quote` fields, error codes 39-45, and `get_domains` for the
  destination's forwarding switches and caps. A simulated `bridge` built with the new encoding is
  accepted by the deployed contract.
- `max_fee` is Circle's `high` forward-fee quote at 1.0x (`packages/sdk/src/core/fees/stellar.ts`), checked against the
  domain caps. One fee is shown and it includes delivery. The transfer is refused, before signing,
  when the domain has forwarding off, when a first-time Solana recipient needs account creation and it
  is off, or when the contract's quote says `forwarded: false`. The price is re-checked right before
  signing and the user is stopped if the total went up.
- First-time Solana recipients: the token account is derived client-side, `recipient_owner` is the
  wallet, the quote uses `includeRecipientSetup=true`, and the panel says the wallet will need a
  little SOL to move the USDC on. An unverified recipient (lookup failed) blocks bridging.
- Finality is 2000 (Standard). Direct mode (a burn that skips the wrapper) is removed: it produced
  burns nobody delivers. If the wrapper contract id is unset the page says bridging is not available.

Still open on the web side: nothing signs against mainnet v2 until it is deployed, so the live path
(`bridge` with a real wallet, Circle's forward on mainnet through the wrapper) is untested end to end.

Deployments (yours to run; nothing here has been touched):

- Convex: `npx convex env set IRIS_BUDGET_SECRET <long random>`; same value in Vercel's server env.
  Clear the `relayJobs` and `watcherCursors` tables, then `npx convex deploy` (see
  `apps/web/convex/README.md`). Remove `RELAY_SOLANA_KEYPAIR`, `RELAY_ARC_PRIVATE_KEY`,
  `RELAY_SUBMIT_TOKEN` and any other `RELAY_*` from the Convex deployment.
- Vercel: remove any `RELAY_*`; stop pointing an uptime monitor at the deleted `/api/health` (use
  `/api/circle-health?dest=solana` if you want one).

Docs that still describe the relay as live (correct until cutover, then rewrite): `README.md`,
`SECURITY.md`, `docs/deploying.md`, `docs/go-live.md`, `docs/environments.md`,
`docs/architecture.md`, `CONTRIBUTING.md`, `docs/GOVERNANCE.md`.

Left alone on purpose:

- `packages/db` `relay_jobs` table and its drizzle migrations (Postgres, part of the older
  container stack).
- `infra/terraform` still names `cctp-relay` services.
- `/recover` and `scripts/recover-stranded-mint.mjs`: they rescue a specific v1 bug and countersign
  transactions a relayer partly signed. They need the relayer key, which is the thing being removed;
  decide whether to keep the script for the transfers already stranded before deleting it.
- `scripts/cctp-mint-solana.mjs`, a one-off manual mint. Still useful for self-claiming.
- The removed untracked Arc/EVM submitter code is archived at
  `.secrets/removed-relay-untracked-2026-09-21.tgz` (git-ignored; it was never committed).
