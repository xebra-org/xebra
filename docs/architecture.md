# Xebra v2 — Stellar-as-Hub, Stellar→Solana Corridor

**Status (2026-10-14):** this is the design written before the build, kept as history. What runs
today is narrower: the CCTP rail goes through the Soroban wrapper v2, and Circle's Forwarding Service
mints on the destination. There is no `cctp-relay` (deleted 2026-09-24), nothing on the deployment
path uses Postgres, Redis, Redpanda or ECS, and the frontend connects wallets through Freighter,
EIP-6963 and the Wallet Standard (no wagmi). Arc also sends to fourteen EVM chains and Solana by
calling Circle directly. The solver no longer uses an event bus or a database: it polls Soroban RPC
and keeps its state in one file (2026-11-05, see `apps/solver/README.md`). See the [README](../README.md).

## Context

Xebra v1 (specced, not yet built) is a single corridor: Arc→Stellar, intent-based swap-capable bridge. The user now wants to extend this into a generalized, production-grade multi-chain system where **Stellar becomes the settlement hub**, adding a new **Stellar→Solana** corridor, using **CCTP** as the plain-USDC rail alongside the existing intent+escrow+solver model as the swap rail. This is greenfield — the repo currently contains only the spec markdown, no code — so this plan defines the system from scratch rather than modifying existing implementation.

Confirmed decisions (from user):
1. **Dual rail, unified**: pure USDC→USDC moves route through CCTP directly (no escrow/solver — redundant); USDC→non-USDC-asset moves use the intent/escrow/solver swap rail. One frontend, one flow, auto-routed.
2. **Stellar becomes the hub**: Stellar must work as both source (new) and destination (existing, unchanged) across corridors. Arc↔Stellar (existing spec) stays frozen/unmodified; Stellar→Solana is the new corridor built on the same pattern.
3. **Direction**: Stellar→Solana one-way for v1. Solana→Stellar and further spokes are documented follow-ons, not built now.
4. **Stack ambition**: full production-grade — IaC, containerized services, observability, CI/CD, real data layer. Over-engineering explicitly welcomed, but every component must be justified, not decoration.

The Arc→Stellar contract (`XebraEscrow.sol`) and its intent format are **not modified** — this plan only adds new components alongside it.

---

## Architecture overview

```
                    ┌─────────────────────────┐
   Arc (EVM)        │   STELLAR (hub)          │        Solana
   ─────────        │   ─────────────          │        ──────
   XebraEscrow.sol   │  • XebraEscrow-Soroban   │   (destination only, v1)
   (existing, frozen)│    (NEW — source escrow) │   • Jupiter swap on delivery
   solver watches +  │  • Existing dest-side    │   • SPL Memo + Transfer =
   fills on Stellar  │    fulfillment (frozen)  │     falsifiable proof
                      │  • CCTP burn (Circle)    │   • CCTP mint (Circle)
                      └─────────────────────────┘
                                  │
                     router: dest==native USDC? ──yes──> CCTP-direct rail (+ relay service)
                                  │no
                                  v
                        intent + escrow + solver swap rail
```

Two rails, one router (`packages/router-core`), shared by frontend and backend so the decision can't be spoofed client-side.

---

## 1. Generalized intent format

New versioned schema (`packages/intent-schema`), **not** a modification of the Arc EIP-712 struct (that stays frozen). An `arc-v1` adapter maps the legacy struct into this schema so the DB/API/dashboard represent all corridors uniformly.

```
enum ChainId    { ARC_EVM=1, STELLAR=2, SOLANA=3 }   // spokes append here later
enum AddrEnc    { EVM_ADDRESS_20, STELLAR_ED25519_32, SOLANA_ED25519_32 }
enum AssetKind  { NATIVE, EVM_ERC20, STELLAR_CLASSIC_ASSET, STELLAR_SOROBAN_TOKEN, SPL_TOKEN }

struct ChainAddress { chainId, encoding, raw: bytes32 }   // canonical 32-byte slot
struct AssetRef      { chainId, kind, assetId: bytes32 }

struct IntentV2 {
  version, user: ChainAddress, sourceChain, sourceAsset: AssetRef, sourceAmount,
  destChain, destAsset: AssetRef, minDestAmount, destAddress: ChainAddress,
  expiry, nonce
}
```

- Asset IDs: Stellar classic assets keep v1's `sha256(assetCode||issuer)`; SPL tokens use the raw 32-byte mint pubkey directly (already the right width); EVM ERC-20s use the left-padded 20-byte contract address.
- `ChainAddress.raw` normalizes Solana base58 pubkeys and Stellar StrKey (`G...`) addresses to the same raw-32-byte slot Arc already uses for `destAddress`.
- Intent hash does **not** need one hash function across all source chains — it needs to be a single opaque 32-byte value fixed at `open()` time and referenced verbatim by every downstream leg. Arc keeps its EIP-712 `keccak256`. The new Soroban contract computes `keccak256` over a fixed-order XDR-canonical byte layout of `IntentV2` — **verify at build time**: exact `soroban-sdk` API for `keccak256` + canonical struct XDR serialization (fall back to `sha256`, definitely present, if not).

## 2. Stellar-as-source signing

Use Soroban's **native `require_auth`** / detached authorization entries — this is Stellar's real EIP-712 equivalent, not a bespoke scheme:

1. Frontend simulates the new escrow's `open(intent, ...)` invocation with the user's Stellar `Address`.
2. Simulation returns the auth entry (exact call args + expiration ledger) the user must sign.
3. **Stellar Wallets Kit → Freighter** prompts signing of the auth entry (a documented Freighter capability, distinct from signing a full tx envelope).
4. Signed entry goes back to the frontend, which submits the actual `open` tx. Stellar base fees are negligible (~0.00001 XLM), so the user submitting their own `open` tx after signing is a fine default — no relay required here (unlike §5's Solana-mint problem). Fee-bump is an optional nicety, not a requirement.

**Verify at build time**: Stellar Wallets Kit auth-entry-signing parity across wallets beyond Freighter before advertising broad wallet support.

## 3. New Soroban escrow (Stellar-as-source)

Mirrors `XebraEscrow.sol` 1:1: same state machine (`Open→Claimed→Finalized`, `Open→Refunded`, `Claimed→Challenged→(Finalized|Refunded)`), same function set (`open/claim/challenge/resolve/finalize/refund`), same permissionless-except-`resolve` policy, same bond math (10% of sourceAmount, min 25 USDC-equiv, symmetric challenger bond), same challenge-window-as-constructor-param.

Soroban-specific concerns to design in (not gloss over):
- **Storage TTL**: persistent storage needs explicit `extend_ttl` bumps on every transition (`open`/`claim`/`challenge`) so an entry can't be evicted mid-lifecycle before `finalize`/`refund`/`resolve` — a real new failure mode Arc doesn't have. Needs explicit tests.
- **Auth**: `open` uses `require_auth_for_args` on the user's `Address` — no manual signature verification code, host enforces it. Other functions stay permissionless for the *caller* but bond-posting still requires the poster to authorize their own token transfer via the Stellar Asset Contract.
- **USDC**: Stellar Asset Contract (SAC) wrapping Circle's Stellar USDC issuer, standard Soroban token interface.
- **Arbiter**: same shape as Arc — single admin `Address`, constructor-set, designed for the same future Tholos swap-out as the Arc side.

Tooling: `soroban-sdk` (Rust), tested via its own `#[test]` + `testutils` harness. No Anchor needed here (this is Rust/Soroban, not Solana).

## 4. Solana delivery + proof — decision: SPL Memo, not a bespoke program

**Chosen**: solver delivers via an atomic Solana tx containing (a) `createAssociatedTokenAccountIdempotent` for the recipient (payer = solver, since the user must never hold SOL, matching the "never touches destination-chain tooling" principle), (b) Jupiter swap-route instructions if the solver only holds USDC on Solana (approximating `pathPaymentStrictReceive`'s atomic conversion — Jupiter lacks universal exact-out, so the solver's Fill loop quotes for overshoot and simply doesn't claim if it can't clear `minDestAmount`, same fallback semantics as v1), (c) the SPL transfer, (d) an **SPL Memo instruction carrying the intent hash** (as 64 hex characters: the Memo program rejects non-UTF-8 data, so the raw 32 bytes cannot be sent; found in the first live run, 2026-11-05).

**Rejected**: a bespoke Anchor "delivery attestation" program. It would add real new trust/audit surface (upgrade authority, program audit, PDA design) for a purely ergonomic benefit — falsifiability already comes from the public tx itself, not from a program attesting to it. Memo+Transfer preserves the "one hash, one verification shape across every dest chain" property (fetch tx via any Solana RPC's `getTransaction`, check Memo instruction == intent hash, check co-located Transfer instruction's mint/amount/recipient — same conceptual shape as the existing Horizon-verification pitch). The over-engineering budget goes into the **indexer** (a durable `apps/indexer-solana` doing this parsing continuously), not into new on-chain trust surface.

Solana compute: multi-hop Jupiter routes can be compute-heavy — solver must attach `ComputeBudgetProgram` instructions (unit limit + priority fee), an operational tuning concern for the solver, not a protocol concern.

## 5. CCTP-direct rail (Stellar → Solana)

- **Burn**: call Circle's deployed CCTP V2 Soroban contracts (`TokenMessengerMinter`/`MessageTransmitter`) directly — external dependency, not reimplemented.
- **Attestation**: poll Circle's Iris API, standard CCTP flow.
- **Mint**: call CCTP V2 Solana's `MessageTransmitterV2`/`TokenMessengerMinterV2` `receiveMessage` — **verify current program IDs and testnet/devnet address parity before build** (mainnet IDs are published; environment-specific addresses have historically differed).
- **Relay service** (`apps/cctp-relay`, new component, not in original spec): watches burn events via the Stellar watcher's normalized stream, tracks Iris attestation, submits `receiveMessage` on Solana paying SOL gas from an operator hot wallet, plus ATA creation if needed. Job state in Postgres (`relay_jobs`), BullMQ-driven retries, idempotent by message hash.
- **Funding/ops**: hot wallet balance alerted via Grafana; relay economics folded into the quoted spread (consistent with the base spec's "no on-chain fee parameter" philosophy) rather than building CCTP V2 hooks-based auto-refuel now (flagged as a real future option).
- **Permissionless fallback (load-bearing)**: `receiveMessage` is permissionless and the Iris attestation is public — if the relay stalls, the status page surfaces the raw message + attestation and a "submit yourself" action. This is the one deliberate, clearly-labeled exception to "user never touches destination gas," scoped to the degraded path only, and it exists specifically because Circle's own protocol design permits it.

## 6. Routing layer

`packages/router-core` — pure-function shared library, called by **both** frontend (instant quote-time UX) and `apps/api` (authoritative check before accepting a submission — frontend is UX-optimization only, backend is source of truth). Rule: `destAsset == destination chain's canonical native-USDC identifier` ⇒ CCTP-direct rail; else ⇒ intent/solver rail. Checked against a `corridors` registry table first — this is what makes future spokes a config addition, not new routing code.

## 7. Solver bot extension

Refactor into a chain-adapter architecture (`packages/chain-adapters`: `WatchAdapter`/`FillAdapter`/`ClaimAdapter` interfaces; `apps/solver` composes per corridor):
- `StellarSourceWatchAdapter`: subscribes to the new Soroban escrow's events via Soroban RPC `getEvents` — **verify current Soroban RPC event-polling capabilities at build time** (Horizon doesn't index Soroban events the way classic Stellar events are indexed).
- `SolanaFillAdapter`: Jupiter quote + the atomic ATA/swap/transfer/memo tx from §4.
- `SolanaClaimAdapter`: submits `claim` on the Soroban escrow with the Solana tx signature as the bonded, falsifiable assertion — **Soroban cannot verify Solana state on-chain** (no light client), same trust-minimization pattern as v1 (Arc can't verify Stellar state either — that's why bonds/challenges exist at all). Not a regression, worth stating explicitly since it could otherwise look like a gap.
- **Rebalancing**: solver runs its own CCTP client (`packages/cctp-client`, shared with the relay service) for Stellar↔Solana inventory moves, rather than depending on the relay service's uptime/pricing — avoids a circular operational dependency. The solver already needs SOL for delivery txs, so self-paying its own mint-side gas is a non-issue for it (unlike end users).

## 8. Backend services

| Service | Responsibility |
|---|---|
| `indexer-arc` / `indexer-stellar` / `indexer-solana` | Chain-specific watchers, normalize events, publish to event backbone |
| `api` | tRPC + thin REST/OpenAPI facade over Postgres — the *only* thing the frontend talks to; no direct RPC/Horizon/Solana-RPC calls from the browser |
| `solver` | Multi-chain fill bot (§7) |
| `cctp-relay` | CCTP mint-relay service (§5) |
| `arbiter-service` | Wraps the v1 admin key behind KMS; internal-only, submits `resolve()` on whichever chain's escrow raised a challenge |

- **Event backbone**: **Redpanda** (Kafka-API-compatible, single-binary, no ZK/JVM). Justified by four independent, differently-paced consumers needing a durable, replayable stream (indexer→API projection, solver, relay, future notification consumers) — a genuine pub/sub-with-replay need, not decoration. NATS JetStream flagged as the lighter fallback if the team wants less Kafka-shaped ops.
- **Job queue**: **BullMQ + Redis**, for "do this idempotent action until it succeeds" (Solana mint submission, claim/finalize submission, arbiter resolve submission) — distinct tier from the event bus (facts vs. actions), standard production pattern.
- **Persistence**: **Postgres** as a queryable mirror of on-chain state (chain state stays canonical); ORM **Drizzle** over Prisma — TS-native, no separate query-engine binary across many small containers, inspectable SQL, code-as-migrations for CI gating.
- **API**: **tRPC** primary (frontend + backend both TS, end-to-end types with near-zero boilerplate), thin REST/OpenAPI facade (`trpc-openapi`) for public verify/status endpoints so non-TS consumers aren't locked out.
- **Arbiter custody**: KMS-backed, not a hot key. AWS KMS added native Ed25519 support (Nov 2025), so one KMS provider can plausibly back both an EVM (secp256k1) and Stellar (Ed25519) signer adapter (`packages/arbiter-signer`). **Verify at build time**: exact wiring of Stellar's raw-32-byte Ed25519 signing payload against KMS's message-type modes. Vault Transit / Turnkey flagged as fallback custody if KMS wiring doesn't pan out.

## 9. Frontend

**Next.js (App Router)** — reversed from v1 spec's Vite choice, because the scope changed: a corridor selector, a unified status dashboard reading from the new indexer/API (not raw polling), and shareable per-intent verification links (`/intent/[hash]`) that should render meaningfully pre-hydration all push toward SSR/routing Vite's SPA model doesn't give for free. Next route handlers also host the thin BFF layer (tRPC mount, config endpoints).

Wallets: `wagmi`/`viem` for Arc (unchanged), **Stellar Wallets Kit** for Stellar-as-source signing (§2), and for Solana — **no wallet connector at all**, just a base58 address field with client-side validation. Solana is destination-only in v1; a wallet connector there would be pure unused surface area, mirroring how Arc users never needed Stellar tooling in v1.

## 10. Data model (core entities)

`chains`, `assets` (with `is_native_usdc` flag the router reads), `corridors` (source/dest chain, escrow address if applicable, challenge window, bond bps, active), `intents` (hash pk, corridor, user, amounts, assets, addresses, status, raw jsonb), `escrow_events` (append-only chain-event mirror), `claims` (solver, dest tx ref, delivered amount, bond, challenge fields), `cctp_transfers` (burn/mint tx refs, message hash, attestation status), `relay_jobs` (status, attempts, errors), `solver_inventory_snapshots` (per-chain balances, feeds low-inventory alerts).

## 11. Infra & tech stack

- **Monorepo**: pnpm workspaces + Turborepo (task-graph caching genuinely pays off across many small TS services + Foundry/Soroban/cargo packages invoked as Turbo tasks).
- **Local dev**: Docker Compose — `anvil`, Stellar `quickstart` (incl. Soroban RPC), `solana-test-validator`, Postgres, Redis, Redpanda.
- **IaC**: Terraform, remote state. Compute: **ECS Fargate** over Kubernetes — the service count here doesn't need K8s scheduling sophistication, Fargate removes node-mgmt burden entirely; the right trade for "production-grade but coherent." RDS Postgres, ElastiCache Redis, Redpanda Cloud (self-host later if cost justifies), Secrets Manager + KMS.
- **CI/CD**: GitHub Actions, Turbo-aware (affected-only builds). `forge test` (unchanged Solidity), Soroban SDK test harness (new Rust contract), Vitest integration tests against `solana-test-validator` fixtures, Playwright e2e against the full compose stack. Mainnet deploys gated behind manual-approval environments.
- **Observability**: `pino` structured logging, OpenTelemetry traces/metrics → Grafana Cloud (managed to start; self-host later if justified). Day-one alerts: relay SOL balance low, per-chain solver inventory low, unclaimed-but-delivered intents nearing challenge-window close, CCTP attestation pending past threshold, arbiter KMS failures.

## Proposed repo layout

```
apps/
  web/                  # Next.js frontend
  api/                  # tRPC + REST facade
  solver/               # multi-chain fill bot
  cctp-relay/           # CCTP mint-relay service
  arbiter-service/      # KMS-backed resolve() submitter
  indexer-arc/
  indexer-stellar/
  indexer-solana/
packages/
  intent-schema/        # IntentV2 + arc-v1 adapter + hashing
  router-core/           # CCTP-vs-intent routing rule
  chain-adapters/        # Watch/Fill/Claim adapters per chain
  cctp-client/           # shared CCTP burn/attest/mint client
  arbiter-signer/        # KMS-backed EVM + Stellar signer adapters
  db/                    # Drizzle schema + migrations
contracts/
  arc-evm/               # existing XebraEscrow.sol (frozen)
  stellar-soroban/        # NEW escrow mirroring it
infra/
  terraform/
  docker-compose.yml
```

## Phased delivery plan (Stellar→Solana corridor)

1. **Soroban escrow** — full state machine + unit tests incl. both dispute outcomes, testnet deploy, exercised via CLI only.
2. **Solana delivery/proof + schema** — `intent-schema`, `router-core`, memo+transfer convention; proven via scripted (no-UI) run: open on Soroban → manual deliver+memo on Solana → claim back.
3. **CCTP-direct rail** — burn/attest/mint + `cctp-relay`, demonstrated as a standalone USDC transfer, including a deliberate drill of the manual-claim fallback with the relay stopped.
4. **Solver + backend services** — chain-adapter refactor, watchers/event-backbone/Postgres/API stood up; fully automated Stellar→Solana intent-swap fill, no manual scripts.
5. **Frontend integration** — Stellar Wallets Kit, Solana address field, corridor selector, unified status dashboard; both rails demoable from one page alongside the untouched Arc→Stellar corridor.
6. **Hardening** — Soroban dispute walkthrough (false claim → challenge → KMS arbiter resolve), relay-down fallback drill, concurrent intents across all three live corridors, live dashboards, Terraform staging env, recorded end-to-end demo.

## Open risks to verify during build (not blocking the plan, but must confirm before relying on them)

- Exact `soroban-sdk` API for `keccak256` + canonical struct XDR serialization (fallback: `sha256`).
- Stellar Wallets Kit auth-entry-signing support across wallets beyond Freighter.
- Current CCTP V2 Solana program IDs and devnet/testnet address parity with mainnet.
- Soroban RPC `getEvents` capabilities/limits for the new escrow's event stream.
- KMS `ED25519`/raw-message-mode wiring against Stellar's pre-hashed 32-byte signing payload.

## Verification

- Contracts: `forge test` (Arc, unchanged) and Soroban SDK test harness (new contract) covering every state transition incl. both dispute outcomes.
- Integration: Vitest against `solana-test-validator` + Stellar `quickstart` + `anvil` via Docker Compose — full open→fill→claim→finalize cycle on both rails, plus expiry/refund and challenge/resolve paths.
- E2E: Playwright driving the Next.js frontend through a full Stellar→Solana intent (swap rail) and a full CCTP-direct transfer, including the manual-claim fallback drill with `cctp-relay` stopped.
- Manual: recorded end-to-end demo per the phased plan's stage 6, mirroring the base spec's existing demo bar (dispute walkthrough matters as much as the happy path).
