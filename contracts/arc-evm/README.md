# @xebra/arc-evm

Two contracts:

- `XebraCctpWrapper.sol` — the fee wrapper for CCTP transfers out of Arc (below).
- `XebraEscrow.sol` — the Arc-side escrow for the Arc→Stellar corridor, which is not on the
  deployment path (further down).

## Setup

```bash
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts --no-git
```

(`lib/` is gitignored — vendored via `forge install`, not committed. `--no-git` is required in
this repo because `contracts/arc-evm` sits inside the monorepo's own git working tree rather than
being its own repo, which is what `forge install`'s default submodule flow expects.)

## XebraCctpWrapper

The Solidity counterpart of `contracts/stellar-cctp-wrapper-v2`: the sender approves it and calls
`bridge`; it keeps Xebra's fee (the larger of 0.05%, the 0.10 USDC floor and Circle's own fee, which
is paid out of it) and burns the rest through Circle's `TokenMessengerV2` with the forwarding hook it
builds itself. Same compile-time ceilings, per-destination caps, sender's fee ceiling and deadline,
and governance as the Soroban wrapper ([`docs/GOVERNANCE.md`](../../docs/GOVERNANCE.md)). The
difference that matters: Circle's EVM messenger burns from `msg.sender`, so the principal passes
through this contract inside the transaction, and the transaction reverts unless the allowance to
Circle is back to zero and the contract holds at least its accrued fees.

```bash
forge test --match-contract XebraCctpWrapper            # unit and fuzz
ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network \
  forge test --match-contract Fork                      # deploys against Circle's Arc testnet contracts
```

The burn itself cannot run in a local fork: Arc's USDC moves through Arc-only precompiles. It is
proven on Arc testnet with real transfers instead:

```bash
../../scripts/deploy-arc-wrapper.sh                     # dry run by default; NETWORK=testnet|mainnet
PRIVATE_KEY_FILE=… DEST=base ../../scripts/test-arc-wrapper-testnet.sh
NETWORK=testnet ../../scripts/arc-wrapper-admin.sh status
```

Deployed on Arc mainnet at `0x11b30470DAE40B2Fc27b7AA90dc58e6B4fE9f4c3` (2026-10-15,
[`deployments/mainnet.json`](../../deployments/mainnet.json)) and on Arc testnet at
`0xEdf6867df28F6A5EdE4c3B701c9E9e5091FDef75` (2026-10-14,
[`deployments/testnet.json`](../../deployments/testnet.json)). What is left before the page uses it:
[`docs/go-live.md`](../../docs/go-live.md#turning-on-the-arc-wrapper).

## XebraEscrow

`XebraEscrow.sol` — Arc-side escrow for the Arc→Stellar corridor (v1 spec, frozen). Full state
machine (`Open→Claimed→Finalized`, `Open→Refunded`, `Claimed→Challenged→(Finalized|Refunded)`),
EIP-712 intent signing, bonded permissionless claim/challenge, single v1 admin arbiter.

### Test

```bash
forge test -vv
```

17 tests, including both dispute outcomes (`resolve(claimValid: true/false)`), nonce replay,
expired-intent rejection, wrong-source-token rejection, exact-bond enforcement, and a fuzz check
that `requiredBond` never drops below the 25 USDC floor.

### Deploy

```bash
USDC_ADDRESS=0x... ARBITER_ADDRESS=0x... CHALLENGE_WINDOW_SECS=1800 \
  forge script script/DeployXebraEscrow.s.sol --rpc-url arc_testnet --broadcast
```
