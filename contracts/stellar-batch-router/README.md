# XebraBatchRouter (Stellar)

Several transfers, one signature, all or nothing. It covers two cases:

- **One send to many wallets**: up to 5 recipients, any mix of destination chains.
- **Splitting a transfer above Circle's per-message limit**: 20M becomes two 10M transfers.

The router calls the deployed wrapper's `bridge` (v2, `CCPVTWII…`, which cannot be upgraded) once
per request, inside one invocation. If any one transfer fails, the whole batch fails and nothing
moves. The router has no admin, no fee, no upgrade path and holds no funds. Every per-transfer check
belongs to the wrapper. The router adds three of its own: the batch is not empty, it has at most
`MAX_BATCH` requests, and every request belongs to the signer. Error codes start at 100 so they never
collide with the wrapper's.

`batch(user, reqs)` returns nothing on purpose (see "Limit" below). Each transfer's quote is in the
wrapper's `bridge_initiated` event.

## Limit: 5 transfers per transaction

Stellar caps a transaction's contract events **plus its return value** at 16,384 bytes
(`tx_max_contract_events_size_bytes`, the same on testnet and mainnet as of 2026-11-18). Events are
the only limit that binds. Compute (about 4.4M instructions per transfer against 400M) and writes are
nowhere near their caps.

Measured against Circle's real testnet contracts, with the wrapper running the exact mainnet WASM:

| Destination path | Event bytes per transfer | Fits |
|---|---|---|
| EVM, forwarded (Arc) | 2,976 | 5 (14,880) |
| Solana, forwarded, existing token account | 2,732 | 5 (13,660; 6 would be 16,392) |

**`simulateTransaction` does not enforce this limit.** Batches of 6, 8, 10 and 11 all simulated OK,
and a real 6-transfer batch then failed on chain with `resource_limit_exceeded`. Clients must count
the bytes themselves, or cap batches at 5. `MAX_BATCH` (16) is only a loop guard: the event limit is
a network setting that validators can raise, and this contract cannot change.

## Testnet record (2026-11-18)

Wrapper `CBCS76J4AEOSZXQCC22NJDJKXLS3ZPH3BHWRXNLKJH3BEQS7ZWX2OM7A` (mainnet WASM b5227c30…, Circle
testnet TokenMessengerMinter `CDNG7HXA…`), router `CCFQXRS5FF6SNY32DRQXR4FGTLNCFLWMPMUHRANBWNFJKOOU7Z42N4KM`
(WASM sha256 3f1c2461…), signer `xebra-fwdtest`, 1 USDC per transfer, Standard finality.

| Tx | What | Result |
|---|---|---|
| `c05d2c03…` | 6 to Arc, first router (returned quotes) | FAILED `resource_limit_exceeded`, nothing moved (wrapper seq stayed 0) |
| `ead53789…` | 5 to Arc, first router | FAILED: "return value pushes events size above network config maximum" 16592 > 16384 |
| `fdadc044…` | 5 to Arc, router without return value | SUCCESS; Iris shows 5 messages, all forwarded `COMPLETE` to 5 recipients |
| `de459798…` | 2 byte-identical requests (the split case) | SUCCESS |
| `48742283…` | 4 chains in one batch: Arc, Base, Avalanche, Optimism (second wrapper `CAXATPSB…`, router `CCIKNA5S…`) | SUCCESS; Circle delivered on all 4 (forward txs checked on Base Sepolia and OP Sepolia: status 1) |
| `bd600a02…` | 5 chains in one batch: Arc, Base, Avalanche, Optimism, Solana (2 USDC each) | SUCCESS; all 5 delivered (Base and OP receipts status 1, Solana devnet finalized) |

Reproduce: `node scripts/batch-router-testnet.mjs <n> [arc|solana] [amount] [--same] [--send]`, or
`BATCH_ENV=.secrets/batch-router-testnet-mixed.env node scripts/batch-router-testnet.mjs 5 mix:arc,base,avalanche,optimism,solana --send`
(the ids live in `.secrets/`).

## Tests

`cargo test` (16 tests) runs the router against the deployed wrapper WASM
(`wasm/xebra_cctp_wrapper_v2_mainnet.wasm`, fetched from mainnet, sha256 matches
`deployments/mainnet.json`), with a mock Circle messenger that pulls the burn with `transfer_from`.
The tests cover: many recipients, the 20M split, mixed forwarded and relay paths, atomic rollback
when the wrapper, Circle or the balance refuses any one transfer, the router's own checks, a single
root authorization with one `bridge` under it per request, and that the router's copies of
`BridgeRequest` and `Quote` encode exactly as the deployed WASM decodes them.

Locally, reuse the v2 crate's build cache: `CARGO_TARGET_DIR=../stellar-cctp-wrapper-v2/target cargo test`.

## Not done

- Mainnet deploy. The contract has had no external audit.
- Front end and SDK: build the batch, cap it at 5, and quote each transfer with the wrapper's `quote`.
- A real signature with address credentials (smart wallet, or a fee sponsor). Every test above used
  the source account's signature, which is what Freighter-style wallets do today.
- The Solana account-creation path (65-byte hook) was not measured. It should still fit 5.
