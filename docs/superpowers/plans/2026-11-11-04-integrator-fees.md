# Integrator fees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A wallet or app that sends transfers through Xebra can add its own fee, enforced and paid on chain, disclosed in every quote, so integrating us earns them money.

**Architecture:** Wrapper v2 has no upgrade entrypoint (by design), so the Soroban side is a new crate `stellar-cctp-wrapper-v3`, a copy of v2 plus the integrator fee; its constructor seeds every live domain, so no 48-hour proposals are needed at launch. The EVM `XebraCctpWrapper` gets the same feature as a new deployment. Integrator fees accrue per integrator inside the contract and are withdrawn by the integrator, never pushed during a user's transfer. The SDK, API, quotes and docs carry the new fields.

**Tech Stack:** Rust + soroban-sdk (as v2), Foundry (as `contracts/arc-evm`), plan 1's SDK and API.

**Spec:** [`2026-11-11-developer-platform.md`](./2026-11-11-developer-platform.md); the user's 2026-11-10 aim ("integrators" earning on top) and the advice given then: transparent, integrator-set markup, split on chain.

## Global Constraints

- Plan 1's Global Constraints apply. No agent sends a mainnet transaction; mainnet deploys and the cutover are the user's.
- The integrator fee is part of what the user signs: `BridgeRequest.integrator` and `integrator_fee_bps`, and the user's `max_wrapper_fee` ceiling covers our fee + the integrator fee + Circle's fee. A quote shown without the integrator fee is a bug.
- Ceilings: compile-time `MAX_INTEGRATOR_FEE_BPS_CEILING = 100` (1.00%); admin param `max_integrator_fee_bps` (timelocked like other params, tighten-only instantly), initial value set by the user before deploy.
- Protocol share: admin param `integrator_share_bps` (the part of each integrator fee Xebra keeps), timelocked, compile-time ceiling 5000 (50%); initial value set by the user before deploy.
- Accrual: `IntegratorFees(Address)` in persistent storage with TTL extension on write; `withdraw_integrator_fees(integrator, to, amount)` requires `integrator.require_auth()`. Never transfer to an integrator inside `bridge`.
- `integrator = None` (or `address(0)` on EVM) with `integrator_fee_bps = 0` behaves exactly as v2. Any other combination of None and non-zero bps is refused.
- Pause stops `bridge`, never `withdraw_integrator_fees`.
- Local builds: set `CARGO_TARGET_DIR` to v1's `target/` (a fresh crate rebuilds soroban-sdk and exceeds the 250 s timeout).

## Review Focus

1. **Rounding at tiny amounts** (1 USDC, 1 bps): the integrator fee floors to whole stroops; principal + every fee + remainder equals what left the user's wallet, exactly. Property test in task 1.
2. **Integrator fee pushes the total over the user's `max_wrapper_fee`:** the transfer reverts with v2's existing `WrapperFeeAboveUserCap` (19), nothing moves. Test in task 1.
3. **An integrator address with no USDC trustline** (Stellar) withdrawing: the withdraw fails with the SAC's error and the accrued balance is unchanged; users' transfers were never affected. Test in task 1.
4. **Admin lowers `max_integrator_fee_bps` while a signed request with a higher bps is in the mempool:** the request reverts (exceeds current max) rather than charging over the new cap. Test in task 1.
5. **Quote/execute mismatch:** the API's quote and the contract's `quote` agree to the stroop for every live domain at 1, 10, 1000 USDC and 0, 1, 50, 100 bps. Test in task 4.

---

### Task 1: Soroban wrapper v3

**Files:**
- Create: `contracts/stellar-cctp-wrapper-v3/` (copy of v2 with history noted in its README), `src/lib.rs` changes, `src/test_integrator.rs`
- Modify: root `Cargo.toml` workspace members if present; CI job that runs v2's tests runs v3's too

**Interfaces:**
- `BridgeRequest` gains `integrator: Option<Address>`, `integrator_fee_bps: u32`.
- `Quote` gains `integrator_fee: i128`, `integrator_take: i128` (after the protocol share), `protocol_share: i128`.
- `Params` gains `max_integrator_fee_bps: u32`, `integrator_share_bps: u32`.
- New entrypoints: `withdraw_integrator_fees(integrator: Address, to: Address, amount: i128) -> Result<(), Error>`, `get_integrator_fees(integrator: Address) -> i128`.
- New event `IntegratorFeeAccrued { integrator, amount, protocol_share, seq }`; `BridgeInitiated` gains `integrator` and `integrator_fee`.
- New errors (next free numbers after v2's): `IntegratorFeeTooHigh`, `IntegratorMismatch` (None with bps > 0 or Some with 0), `InsufficientIntegratorFees`.

- [ ] **Step 1:** Copy the crate; run v2's 83 tests under the new name; all pass before any change.
- [ ] **Step 2:** Failing tests: Review Focus 1 to 4; None/0 path byte-identical to v2's quote and events; withdraw by a non-integrator fails auth; withdraw more than accrued fails; pause blocks bridge not withdraw; property test (proptest) over amount in [min_transfer, max_transfer], bps in [0, max], share in [0, 5000]: conservation of stroops.
- [ ] **Step 3:** Implement. Order of fees: our fee computed as in v2 on `amount`; integrator fee = `amount * bps / 10_000` floored to whole stroops; protocol share = `integrator_fee * share_bps / 10_000` floored; recipient gets `amount - our_fee - integrator_fee - forward_fee - remainder`.
- [ ] **Step 4:** Security pass with the `tob-entry-point-analyzer`, `tob-sharp-edges` and `stellar-smart-contracts` (security.md) skills; record findings in `docs/audit-v3-internal.md`; fix or justify each.
- [ ] **Step 5:** Commit `Add wrapper v3 with integrator fees`.

### Task 2: EVM wrapper with integrator fees

**Files:**
- Create: `contracts/arc-evm/src/XebraCctpWrapperV2.sol` (v1 stays for the deployed address), `test/XebraCctpWrapperV2.t.sol`, fork test beside the existing one

**Interfaces:** same fields in Solidity: `address integrator; uint16 integratorFeeBps;` in `BridgeRequest`; `integratorFee`, `integratorTake`, `protocolShare` in `Quote`; `mapping(address => uint256) public integratorFees`; `withdrawIntegratorFees(address to, uint256 amount)` using `msg.sender` as the integrator; same params, ceilings and errors as task 1.

- [ ] **Step 1:** Port the task 1 tests to Foundry (including a fuzz test for conservation); run `forge test`, see the new ones fail.
- [ ] **Step 2:** Implement; `forge test` and the fork test against Arc pass; commit `Add the EVM wrapper with integrator fees`.

### Task 3: Testnet proof

- [ ] **Step 1:** Deploy v3 to Stellar testnet with a script modelled on `scripts/deploy-cctp-wrapper-v2.sh` (constructor seeds the testnet domains), and the EVM wrapper to Arc testnet with a Foundry script.
- [ ] **Step 2:** One real testnet transfer each way with an integrator at 50 bps; record amounts: recipient, our accrual, integrator accrual, protocol share; withdraw the integrator fees. Record tx hashes in `docs/integrator-fees.md`.
- [ ] **Step 3:** Commit `Prove integrator fees on testnet`.

### Task 4: SDK, API, quotes and docs

**Files:**
- Modify: `packages/sdk/src/core/fees/*` (integrator math mirroring the contracts), `build/stellar.ts` and `build/evm.ts` (encode the new fields), `api/schemas.ts` (`integrator`, `integratorFeeBps` on quote and transfer requests; `fees.integrator` in `Quote`), `openapi.json`; `apps/web/lib/api/service.ts` (an API key's default integrator from plan 3 applies when the request names none); docs `guides/integrator-fees.mdx` (no longer a stub), `concepts/fees.mdx`
- Test: `packages/sdk/src/core/fees/integrator.test.ts` against values produced by the contract tests (export a JSON fixture from the Rust tests and assert the TS math matches every row: Review Focus 5)

- [ ] **Step 1:** Failing fixture test; implement; all suites green; commit `Quote and build integrator fees`.

### Task 5: Mainnet (user-run, agent-prepared)

- [ ] **Step 1:** Prepare `docs/cutover-v3.md` after `docs/cutover-v2.md`: exact deploy commands with constructor args (domains as live on the day, read with `get_domains`), the env var switch, the order (deploy, verify with `get_*` reads, one 1 USDC transfer, switch the site, watch), and rollback (switch the env var back; v2 untouched).
- [ ] **Step 2:** Recommend an external audit of v3 and the EVM wrapper before mainnet; the user decides.
- [ ] **Step 3 (user):** deploy, prove, switch. Then update `deployments/mainnet.json` and memory.
