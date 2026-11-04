# End-to-end demo: Stellar->Solana corridor, happy path

This is a **live run** against real Stellar testnet and Solana devnet infrastructure — not a
local `anvil`/`soroban container`/`solana-test-validator` simulation. It's the first time the
new `contracts/stellar-soroban` escrow has been exercised outside of Rust's `mock_all_auths()`
unit-test harness, closing an open risk flagged since Phase 1 ("verify Soroban's
`require_auth_for_args` wiring at build time").

## What was verified live (2026-08-14, Stellar testnet)

Three funded testnet identities (`e2e-user`, `e2e-solver`, `e2e-arbiter`, generated via
`stellar keys generate` + `stellar keys fund`), one deployed contract instance, one full
`open -> claim -> finalize` lifecycle, real challenge-window wait (60s, not mocked/fast-forwarded):

| Step | Tx | What it proves |
|---|---|---|
| Upload wasm | [`933e641e…`](https://stellar.expert/explorer/testnet/tx/933e641ea418f82a7787e3a7a4d9772b8661117270f5fcb7b17f00553512bf85) | — |
| Deploy contract | [`ffcb2765…`](https://stellar.expert/explorer/testnet/tx/ffcb276573a9fe48ed12ef56c5409a51acf1cbdc3fe89c398b86b15c93371d6c) | Constructor accepted `usdc` (native XLM's SAC), `arbiter`, `challenge_window_secs=60` |
| `open` | [`939a3cf4…`](https://stellar.expert/explorer/testnet/tx/939a3cf47197153d2be2b182ad6ea10d4560bfa39d0d9211aa26b07b3fb2ffb8) | **The genuinely new thing**: `intent.user.require_auth_for_args(...)` verified a real Ed25519 signature over the exact `Intent` struct bytes, against a live host — not mocked. 50 XLM transferred user→escrow. |
| `claim` | [`0f38da0c…`](https://stellar.expert/explorer/testnet/tx/0f38da0c32d3ad3cde1dfa9d2a75b927d64c0a8228e1ba99723c529514f16840) | Solver posted a real 25 XLM bond (`required_bond(500000000) == 250000000`, matching the 10%-floored-at-25-USDC-equivalent formula) |
| `finalize` | [`f86d40b4…`](https://stellar.expert/explorer/testnet/tx/f86d40b440e791da25b9d37e15c482bc785f98404248c03d4ca0493534043376) | Called by the **arbiter identity**, not the solver — proving `finalize` really is permissionless. Paid 75 XLM (50 principal + 25 bond) to the solver. Final `status_of` == `Finalized`. |

Contract: `CBMFZNZ4BUU2FLQW6ELGR6BGFO5T7C2LA5JA4TR5HY7UZN5FD3ZJP4OW` ([lab.stellar.org](https://lab.stellar.org/r/testnet/contract/CBMFZNZ4BUU2FLQW6ELGR6BGFO5T7C2LA5JA4TR5HY7UZN5FD3ZJP4OW))
Intent hash: `66ab5c8488e95dc9e3e70902548089ca9855bab628fdfa63fd5beabd16e8f3e9`

Reproduce with `stellar-open-claim-finalize.sh` (see its header comment for required env vars).

## What's a documented placeholder, and why

`dest_asset`/`dest_address`/`dest_tx_ref` in the run above are **not** a real Solana devnet
delivery — they're fixed placeholder bytes (`0x1111…`, `0x2222…`, and the ASCII string
`demo-dest-tx-ref` respectively). `01-solana-setup.ts` in this directory is real, runnable code
(generates a solver keypair + a recipient keypair, creates a genuine SPL mint, mints inventory to
the solver's ATA) that was **run but did not complete**: Solana devnet's public faucet
(`api.devnet.solana.com`'s `requestAirdrop`) returned `429 — "You've either reached your airdrop
limit today or the airdrop faucet has run dry"` on every attempt (5 retries with backoff, plus a
retry after the Stellar leg finished), consistently, from this environment's outbound IP. This is
a faucet rate-limit, not a code or contract issue — the same class of environment constraint
already documented for local Soroban/Solana infra elsewhere in this README's history (see the
root README's Status section).

To complete the Solana leg from a machine with devnet SOL available:
1. Run `01-solana-setup.ts` (via `pnpm --filter @xebra/solver exec tsx` or similar) — writes
   `solana-setup.json` with the solver/recipient keys and mint address.
2. Feed the mint's 32-byte pubkey and recipient's 32-byte pubkey (both already in the right raw
   form — see `@xebra/intent-schema`'s `assetRefToSplMint`/`chainAddressToSolanaAddress`) into
   the Stellar `open` call's `dest_asset`/`dest_address` instead of the `0x1111…`/`0x2222…`
   placeholders.
3. After `open` returns the real `intent_hash`, call `@xebra/chain-adapters`'
   `buildDeliveryInstructions()` (already used by `apps/solver`'s real fill adapter) to build and
   submit the actual ATA-create + transfer + memo(intentHash) Solana tx, and use its real
   signature as `claim`'s `dest_tx_ref` instead of the placeholder.

Everything downstream of that substitution (claim/challenge/resolve/finalize on the Soroban side)
is exactly what this run already exercised live.


---

## 2026-11-04: the solver's own code against a fresh testnet escrow

The August run above drove the contract with the `stellar` CLI. This one drives it with the code
the solver runs: `apps/solver/e2e/testnet-poll.mts` uses `pollOpenedIntentsOnce`, the on-chain gate
(`readEscrow`), `processOpenedIntent`, the real Soroban `claim` adapter and the file journal.

Escrow `CCLHPAWUGSYF4YAFO553YOETP2QXOKBL7MNE3PW4UI6KVX34TZ357KZV` (testnet, protocol 30, native XLM
standing in for USDC, 60 s challenge window). Recorded in `deployments/testnet.json`.

| Step | Ledger | Tx | By |
|---|---|---|---|
| `open` (50 XLM) | 5560337 | `21cf8afa…5699` | `stellar` CLI, `e2e-user` |
| `claim` (25 XLM bond) | 5560349 | `e4654480…cf8f` | the solver's claim adapter, `e2e-solver` |
| `finalize` | 5560449 | `0b711697…6f8a` | `stellar` CLI, `e2e-arbiter` (permissionless) |

Intent hash `ee05be3e037df7bd63b9df208add8c939e9d594d8733a8b16ebc815cc9cf2b1c`. The final
`readEscrow` reports `Finalized`, `delivered_amount` 1000000 and `dest_tx_ref`
`STUB-no-solana-delivery`.

**What is not real, again: the Solana delivery.** The claim asserts a delivery that never
happened (`stubFill` in the script). On a throwaway testnet escrow that tests the Stellar half; it
is exactly the false claim the challenge window exists to catch, and this repo has still never
run that dispute path live.

What the run did show:

- The poll source decoded a real `IntentOpened` into an intent, and the `claim` adapter's
  `prepareTransaction` and `sendTransaction` worked against a live RPC. **Correction (2026-11-05):**
  this section first said its `pollTransaction` confirmation worked too. It cannot: stellar-sdk 13
  throws `Bad union switch: 4` decoding protocol 23+ result metadata (see the next section), so the
  adapter now confirms through Horizon.
- The first attempt's claim landed but the script then died on a read timeout and its output was
  lost; its state file was deleted before the rerun. The rerun found the escrow already `Claimed`
  and **skipped it** ("escrow is Claimed, not Open"), twice, including from a cold cursor. With no
  journal at all, the chain check alone refused a second delivery.
- The August escrow (`CBMFZNZ4…`) is still on testnet, but its ledger entry has expired. Reading it
  through stellar-sdk 13.3 fails with `Bad union switch: 1` (the response carries an
  archived-entry extension). Ordinary reads decode fine on testnet (protocol 30) and on mainnet
  (protocol 29). `readEscrow` reports that case as an error instead of crashing.


---

## 2026-11-05: a real Solana delivery, on a local validator

Same escrow as above. This time the solver's own Solana fill adapter delivered a real SPL token
and the claim asserted that delivery's real signature. `apps/solver/e2e/devnet-real-fill.mts`
drives it (`MODE=setup|run|verify`).

**What this is not: a public chain.** Solana devnet's RPC faucet is closed (`410 Gone`, "Request
test SOL at https://faucet.solana.com") and the web faucet sat behind a captcha, so the Solana side
ran on `solana-test-validator` (Agave 4.3.2) on this machine. It is the real Solana runtime and the
real SPL Token, ATA and Memo programs, but nobody else can look at that ledger, and the token is a
throwaway mint, not USDC. The Stellar side is the public testnet. The same script runs on devnet
unchanged once a wallet has SOL (`SOLANA_RPC_URL`, `MINT_FILE`).

| Step | Where | Reference |
|---|---|---|
| `open`, 50 XLM, real mint and recipient | Stellar testnet, ledger 5561842 | `704edcd7…9751` |
| Delivery: create ATA, transfer 1 token, memo = intent hash | local validator | signature `2oCSzjPo…T9ia` |
| `claim` by the solver adapter, 25 XLM bond | Stellar testnet, ledger 5561961 | `6d0e1a7e…22f7` |
| `finalize`, permissionless | Stellar testnet, ledger 5562003 | `32977a81…b6e9` |

Intent hash `2427ebb207f7cf20d9316930d31887b8cd14d3fd7e16539375b3e3d517ea8a55`. Checked afterwards
with `verifyDelivery`, the same check a challenger would run, against the validator's RPC: the memo
equals the intent hash, the mint and recipient match, 1,000,000 units were delivered. The recipient's
token account holds 1,000,000.

Three things this run found that no unit test could, all fixed:

1. **The Solana delivery could never have landed on any chain.** The memo carried the raw 32-byte
   hash, and the SPL Memo program rejects anything that is not UTF-8 (`Invalid UTF-8, from byte 2`).
   The memo is now the hash as 64 hex characters. `verifyDelivery` and `parseDeliveryTx` also read
   the decoded `spl-memo` shape that `getParsedTransaction` returns, not only a raw one.
2. **A landed claim was reported as failed.** stellar-sdk 13's `pollTransaction` throws `Bad union
   switch: 4` on protocol 23+ metadata. The claim had landed; the journal was left saying "delivered,
   not claimed". The adapter confirms through Horizon now, and a restart no longer retries a claim
   once the chain says the escrow is not `Open`.
3. A first attempt failed at instruction 2 before sending anything, so nothing was delivered or
   journaled; a fresh state file was needed because its cursor had moved past the intent.

Still not done: a delivery on public devnet, a live dispute (false claim, challenge, slash), and
anything on mainnet.
