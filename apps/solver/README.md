# @xebra/solver

Multi-chain fill bot. v1 scope: Stellar→Solana only (this build's new corridor).

`fill-loop.ts` is the tested orchestration core (`processOpenedIntent`: quote → fill → claim,
against injected `FillAdapter`/`ClaimAdapter` interfaces — 4 tests, no live network needed).
`adapters/solana-fill.ts` and `adapters/stellar-claim.ts` are the concrete v1 implementations:

- **Solana fill**: direct-inventory-match delivery (ATA-create + transfer + memo, via
  `@xebra/chain-adapters`). `quote()` is unit-tested (3 tests); `fill()` signs and submits a
  real transaction and isn't exercised live here (no Solana validator available in this build's
  environment). Jupiter swap-route splicing for "solver only holds USDC" isn't implemented yet.
- **Stellar claim**: calls `claim` on the Stellar-source XebraEscrow via `@stellar/stellar-sdk`
  (`Contract.call` + `TransactionBuilder` + `rpc.Server.prepareTransaction`/`sendTransaction`,
  compiled against the real SDK types). Not exercised against a live Soroban RPC.

## Running it

One process, no event bus and no database. `index.ts` polls Soroban RPC (`poll-intents.ts`, same
decoder as `apps/indexer-stellar`), re-reads each escrow from the chain before spending anything
(`readEscrow` from `@xebra/chain-adapters`: it must be `Open` with at least 180 s to expiry),
delivers, writes the delivery to `SOLVER_STATE_FILE` (`journal.ts`), then claims and waits for the
claim to land. A restart between delivery and claim retries only the claim. Needs
`SOLANA_RPC_URL`, `SOROBAN_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE`, `STELLAR_ESCROW_CONTRACT_ID`,
`SOLVER_SOLANA_KEYPAIR`, `SOLVER_STELLAR_SECRET`; optional `SOLVER_STATE_FILE`, `POLL_INTERVAL_MS`,
`SOROBAN_START_LEDGER`. Back the state file up: losing it is the one way to deliver twice, and the
on-chain check is the only other guard.

`e2e/testnet-poll.mts` is the live testnet run of this path with a stubbed Solana delivery; see
`scripts/e2e-demo/README.md`.

`decode-intent-event.ts` reconstructs an `IntentV2` directly from a live `IntentOpened`
`ChainEvent`'s payload (5 tests) rather than reading back the `intents` rows `apps/projector` writes
from the same events.

Inventory tracking in `index.ts` reads the solver's real SPL balance for the destination mint.
