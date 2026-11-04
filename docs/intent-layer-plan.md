# From CCTP wrapper to intent-based, bonded-solver bridge

**Status 2026-11-04.** The intent layer is built and tested. The Soroban escrow has run
`open -> claim -> finalize` on Stellar testnet three times. Twice (2026-08-14, 2026-11-04) the Solana
delivery was a placeholder. On 2026-11-05 the solver delivered a real SPL token and claimed it, but
on a **local** Solana validator, because devnet's faucet was closed. It has never run on mainnet or
against a public Solana cluster, and its dispute path has never run live. Until a real delivery is on a chain explorer, it is a design, and the README, `package.json`
and the site must say so. This file is the path from one to the other.

## What exists (in the repo; only the Soroban escrow has ever been deployed, on testnet)

| Piece | Where | State |
|---|---|---|
| Soroban escrow, Stellar as source (`open`/`claim`/`challenge`/`resolve`/`finalize`/`refund`, 10% bond, symmetric challenger bond, admin arbiter) | `contracts/stellar-soroban` | 14 tests. Testnet: `CCLHPAW…KZV` (2026-11-04, in `deployments/testnet.json`), full lifecycle with a stubbed delivery, see `scripts/e2e-demo/README.md`. Not on mainnet |
| Solidity escrow, Arc as source | `contracts/arc-evm/src/XebraEscrow.sol` | 17 tests, no deployment recorded |
| Solver: poll Soroban, re-check the chain, fill on Solana, claim on Stellar | `apps/solver` | one process, no Kafka. 38 tests. Full path run live on 2026-11-05 (Stellar testnet + local Solana validator); that run found and fixed an undeliverable memo and a claim confirmation stellar-sdk 13 could not parse |
| On-chain status reader (`readEscrow`) | `packages/chain-adapters` | used by the solver; run live against testnet. A page that shows it does not exist yet |
| Arbiter: re-verifies a claim against the destination chain | `apps/arbiter-service` | unit tests only |
| Intent schema, router (CCTP vs swap rail) | `packages/intent-schema`, `packages/router-core` | tested, not called by the page |
| Status API | `apps/api` (tRPC + Postgres) | not deployed; the `/intent/[hash]` page that read it was removed 2026-11-04 |

## What is missing, in the order it blocks a live transfer

Done 2026-11-04: step 2 (a solver that needs no Kafka, with a journal so a crash cannot cause a
second delivery, and an on-chain re-check before every fill) and the reader half of step 3.

1. **One live corridor, not two.** Start with **Stellar to Solana**: the Soroban escrow already
   targets `CHAIN_SOLANA`, the solver already has a Solana fill adapter, and it is the corridor
   where the CCTP rail already runs. Arc to Stellar (the original spec) follows on the same
   schema.
2. ~~**Run the solver without Kafka.**~~ Done. See `apps/solver/README.md`.
3. **Read status from the chain, not a database.** `readEscrow` does this. The page that shows it
   comes back only when there is an escrow worth pointing it at, and it takes its escrow address
   from config, with no `apps/api`. A page backed by nothing is what was just removed.
4. **The bridge page offers a swap.** Today the form takes an amount and an address. A swap needs
   a destination asset and a quoted floor (`minDestAmount`), routed by `router-core`: same-asset
   USDC stays on CCTP, anything else becomes an intent. Hide it behind a flag until step 6.
5. **Deploy on testnet, then mainnet with a hard cap.** The contract has had no audit. Cap
   `source_amount` in the contract at deploy (the wrapper's `max_transfer` of 100 USDC is the
   precedent), and raise it only after clean fills.
6. **Prove the dispute path, not only the happy path.** A recorded run of a false claim being
   challenged and slashed is what makes the optimistic design credible. The spec says so; the
   tests cover it, a live run does not exist.

## What it costs, and what is not yours to decide alone

- **Solver inventory.** The spec sizes a demonstration solver at 500 to 1,000 USDC-equivalent.
  Bond is 10% of the source amount, floor 25 USDC. Someone has to fund both.
- **Arbiter key.** One trusted admin key until the dispute logic moves elsewhere (the spec points
  at Tholos). It must not be the pauser or the wrapper admin key.
- **Legal.** Holding a non-USDC inventory and filling for others is a different activity from
  taking a fee on a USDC transfer. Settle it before mainnet, as with the wrapper.
- **No new custody claims.** The wrapper never holds principal. An escrow does, until `finalize`
  or `refund`. `SECURITY.md` and the README need that stated the day it ships.

## Honest wording until it is live

`package.json`, the README and the site describe the corridor that ships. The line "intent-based
swap-capable bridge with a bonded solver market" goes back in the day a fill, a claim, a finalize
and a slashed false claim are all on a chain explorer, and the transaction hashes are in this repo.
Not before.

## Order of work

1. ~~Poll-based solver and chain-read status, on Stellar testnet.~~ Done 2026-11-04, with a stubbed Solana delivery.
2. ~~A real Solana delivery.~~ Done 2026-11-05 on a local validator. Repeat it on public devnet
   (`devnet-real-fill.mts`, needs about 0.02 devnet SOL from https://faucet.solana.com) so the
   delivery can be checked by someone else, then one challenge and slash.
3. Flagged swap form on the page. Record the three runs in `docs/`.
4. Mainnet deploy with a cap, a funded solver, and the arbiter key held apart from the others.
