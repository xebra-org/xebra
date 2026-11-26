# Governance

Who can change what on the deployed `XebraCctpWrapper` contract (v2, `cctpWrapperV2` in
`deployments/mainnet.json`), and how fast. Everything here is enforced on-chain, in
`contracts/stellar-cctp-wrapper-v2/src/lib.rs` — this document names it, it doesn't grant it. v1,
retired, has the same roles and timelock but no `tighten_domain`.

## Two roles, deliberately separate

| Role | Can do | Held by |
|---|---|---|
| **ADMIN** | propose/commit parameter, admin, pauser, fee-recipient, and domain changes; withdraw accrued fees; unpause | see [`deployments/mainnet.json`](../deployments/mainnet.json) |
| **PAUSER** | `pause()`, `cancel_pending` (veto every pending change), and `tighten_domain` / `remove_domain` (turn a destination's forwarding off, lower its caps, or drop it) — immediately, no timelock, and none of them can loosen anything | see [`deployments/mainnet.json`](../deployments/mainnet.json) |

**`ADMIN` and `PAUSER` must be different keys held by different people.** The pauser exists so a
compromised admin can still be stopped by someone who is not the attacker. v1's deploy script
(`scripts/deploy-cctp-wrapper.sh`) warns if they match but cannot enforce the separation — it
can't know who actually holds each key. v2's (`scripts/deploy-cctp-wrapper-v2.sh`) reuses v1's.

Current holders are whatever is recorded in `deployments/mainnet.json` at time of reading; this
document intentionally doesn't duplicate the addresses so it can't go stale the way the README's
status table once did.

## The timelock

Every admin action except pausing follows the same two-step, 48-hour pattern
(`TIMELOCK_SECS = 172_800` in `lib.rs`):

1. **Propose** — `propose_params`, `propose_admin`, `propose_pauser`, `propose_fee_recipient`, or
   `propose_domain`. Requires `ADMIN`'s auth. Records the change and an `eta` 48 hours out.
2. **Commit** — `commit_params`, `accept_admin` (requires the *new* admin's own auth, not the old
   admin's), `commit_pauser`, `commit_fee_recipient`, or `commit_domain`. Fails if called before
   `eta`.

`cancel_pending` lets `ADMIN` or `PAUSER` withdraw every pending proposal before it commits.
`tighten_params` and `tighten_domain` are the exceptions: they can only make limits *stricter*
(a lower `max_transfer`, a higher `min_transfer`, a lower `fee_bps`, `min_fee` or `account_fee`, a lower
forward-fee cap, forwarding off, etc.), never looser, so they skip the timelock — a safety ratchet,
not a bypass. A lower fee counts as stricter because it can only cost the sender less, which is what
the timelock protects. `remove_domain` is instant for the same reason.

**Pausing is immediate and untimelocked, on purpose.** `pause(caller)` checks `caller` is either
`ADMIN` or `PAUSER` and takes effect in the same transaction. Everything else that is not a
tightening — including `unpause` — needs `ADMIN` and, if it's a parameter change, the full 48 hours.

## Why it's shaped this way

A fee-taking contract with a fixed `MAX_TRANSFER` and no external audit
(see [`SECURITY.md`](../SECURITY.md)) needs two different response speeds: *stop it now* if
something looks wrong, and *change it deliberately* for everything else, with enough delay that
users and other maintainers have a window to notice and react before a parameter change takes
effect. 48 hours is chosen to be long enough to notice, short enough to still be useful.

## The EVM wrapper

`contracts/arc-evm/src/XebraCctpWrapper.sol`, the fee wrapper for transfers out of Arc, is governed
the same way: an admin and a pauser, instant pause and veto, 48 hours for anything that loosens. The
functions are the Soroban ones in camelCase (`pause`, `unpause`, `proposeParams`/`commitParams`,
`tightenParams`, `proposeDomain`/`commitDomain`, `tightenDomain`, `removeDomain`, `cancelPending`,
`proposeAdmin`/`acceptAdmin`, `proposePauser`/`commitPauser`,
`proposeFeeRecipient`/`commitFeeRecipient`, `withdrawFees`). Two differences follow from there being
no relay: a domain on its list is a domain Circle forwards to, so there is no `forward` switch, and
`removeDomain` is the kill switch for one chain. Its keys are EVM keys, separate from the Stellar
ones. Until `/admin` has an EVM section it is governed with `scripts/arc-wrapper-admin.sh`: `status`
reads, and every other command shows the call and asks for a typed `yes`.

## What this doesn't cover

The Iris rate counter (`apps/web/convex/`) and frontend (`apps/web`) have no on-chain governance —
they're ordinary deployed software, changed by ordinary PRs and deploys. Until the EVM wrapper is
deployed and switched on, the routes between Arc and the EVM chains call Circle's contracts directly,
so there is no contract of ours there to govern. Nothing about them requires a
timelock because they hold no funds and confer no authority the contract doesn't independently
check; the contract is the only thing here whose bugs are irreversible by design.
