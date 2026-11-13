# Xebra fee collector for Sui (`xebra_fee`)

A small Move package that takes Xebra's fee on transfers that start on Sui. It is the Sui-side
equivalent of the fee logic in the Stellar and Arc wrappers.

**Status: written and unit-tested (23 tests). Not published. Not audited.** Not wired into the web
app yet.

## What it does

A transfer from the Xebra page is one programmable transaction block:

1. split the user's USDC (the whole value is the amount they typed)
2. **`xebra_fee::fee::take_fee`** deducts the fee, sends it to Xebra's fee recipient, emits `FeeTaken`
3. Circle's `deposit_for_burn` on what is left
4. Circle's `handler::burn` and `complete_burn` (see `apps/web/lib/sui-stellar/build-burn.ts`)

The fee is `max(amount * fee_bps / 10_000, min_fee)`, taken out of the amount and rounded down,
which is how the Stellar wrapper computes it. Live values on the other wrappers: 10 bps and a
0.30 USDC minimum. **There is no maximum transfer.** Any amount a coin can hold goes through.

Destination is not restricted here: the module is blind to where the burn goes. It records
`destination_domain` in the event, so it works for Sui to Stellar and for Sui to any other
CCTP chain.

## Design

| Choice | Why |
|---|---|
| The module never holds funds | The fee goes straight to the recipient inside `take_fee`. No vault to drain, no withdraw function, no stranded USDC, no solvency check a frozen coin could brick. |
| No pending state, no timelock | Settings change in one call. Nothing can go stale, be overwritten, or be cancelled by a second key. |
| One authority: `AdminCap` | There is no separate pauser that could veto the admin's recovery. |
| User protection is in the user's signature | `take_fee` takes `max_fee`. If the admin raises the fee after a transaction was built, that transaction aborts instead of overcharging. |
| Ceilings compiled in | 100 bps and 5 USDC, the same as the other wrappers. A stolen `AdminCap` can raise fees only to that bound, only for future transactions, and cannot touch any funds. |
| Generic over the coin type | `FeeConfig<T>` binds the settings to the coin, so a fee cannot be paid in, or read for, the wrong coin. |

These choices respond to the governance findings in `docs/audit-2026-11-08-known-issues.md`
(C-1 to C-3, C-6): pauser veto, proposals that never expire, stranded USDC.

## What it cannot do

It cannot force a user to call it. Someone who builds their own transaction and calls Circle
directly pays no Xebra fee. The fee is enforced for transfers made through the Xebra page.
`FeeTaken` is emitted in the same transaction as Circle's `DepositForBurn`, so volume can be counted
by joining the two events on the transaction digest.

It does not verify that a burn happened after the fee was taken. It is deliberately decoupled from
Circle's packages, which Circle upgrades; a later version could take a `&BurnReceipt<T>` to bind the
fee to a real burn at the cost of a dependency on Circle's package version.

## API

```move
public fun quote<T>(config: &FeeConfig<T>, gross: u64): u64
public fun take_fee<T>(config: &FeeConfig<T>, payment: &mut Coin<T>,
                       destination_domain: u32, max_fee: u64, ctx: &mut TxContext): u64

// AdminCap only
public fun create_config<T>(_: &AdminCap, fee_bps: u64, min_fee: u64, fee_recipient: address, ctx)
public fun set_fee<T>(_: &AdminCap, config: &mut FeeConfig<T>, fee_bps: u64, min_fee: u64)
public fun set_fee_recipient<T>(_: &AdminCap, config: &mut FeeConfig<T>, new_recipient: address)
public fun set_paused<T>(_: &AdminCap, config: &mut FeeConfig<T>, paused: bool)
```

`take_fee` aborts if paused (`EPaused`), the coin is empty (`EAmountNotPositive`), the fee exceeds
`max_fee` (`EFeeAboveMax`), or the fee would leave nothing to burn (`EAmountBelowFee`).

Events: `FeeTaken`, `ConfigCreated`, `FeeChanged` (old and new values), `RecipientChanged`,
`PauseChanged`.

## Using it in the PTB

```ts
const [coin] = tx.splitCoins(primary, [amount]);
const fee = tx.moveCall({
  target: `${XEBRA_FEE_PACKAGE}::fee::take_fee`,
  typeArguments: [USDC_TYPE],
  arguments: [
    tx.object(XEBRA_FEE_CONFIG),   // shared FeeConfig<USDC>
    coin,                          // &mut: its value drops by the fee
    tx.pure.u32(destinationDomain),
    tx.pure.u64(quotedFee),        // max_fee: what the page showed the user
  ],
});
// `coin` now holds amount - fee: pass it to deposit_for_burn as usual.
```

Set `max_fee` to the fee the page displayed, so a change between quote and inclusion fails the
transaction instead of surprising the user.

## Build and test

```bash
cd contracts/sui-wrapper
sui move build
sui move test        # 23 tests
```

The installed `sui` CLI (1.61) talks JSON-RPC, which public fullnodes have switched off, so
`sui client publish` and `--dry-run` fail with `MethodNotFound`. Publish with the TypeScript SDK
over gRPC (as `apps/web/lib/sui-stellar` does) or a CLI configured for a gRPC/GraphQL endpoint.

## Before it goes on mainnet

1. External review. The 2026-11-08 audit pass did not cover this package.
2. Publish from a clean machine; record the package id, the `UpgradeCap` and `AdminCap` ids in
   `deployments/mainnet.json`.
3. **`AdminCap`**: move it to a multisig address immediately. It is the only authority.
4. **`UpgradeCap`**: decide deliberately. Keep it in a multisig, or call `make_immutable`. Do not
   leave it in the publisher's hot wallet. Without it, fee logic can never change.
5. Call `create_config<USDC>` with Circle's USDC type
   `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC`,
   `fee_bps` 10, `min_fee` 300000, and the fee recipient address.
6. Send one real transfer and confirm `FeeTaken` and Circle's `DepositForBurn` share a digest and the
   recipient received `amount - fee`.
7. Wire the package and config ids into `build-burn.ts` behind an env flag, and show the fee on the
   page before the user signs.
