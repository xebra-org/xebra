/// Xebra's fee collector for transfers that start on Sui.
///
/// A transfer from the Xebra page is one programmable transaction block (PTB):
///
///   1. split the amount the user typed off their USDC
///   2. `take_fee`        <- this module: deducts the fee, sends it to Xebra, emits `FeeTaken`
///   3. Circle's `deposit_for_burn` on what is left
///   4. Circle's `handler::burn` and `complete_burn`
///
/// The fee model is the one the Stellar and Arc wrappers already use:
/// `fee = max(amount * fee_bps / 10_000, min_fee)`, taken out of the amount, rounded down.
/// There is no maximum transfer. Nothing here limits how much a user can send.
///
/// Design choices, each one a lesson from the 2026-11-08 audit of the other two wrappers:
///
/// - **The module never holds funds.** The fee goes straight to `fee_recipient` inside `take_fee`.
///   There is no vault to drain, no withdraw function, no way to strand USDC sent by mistake, and
///   no solvency check that a frozen coin could brick.
/// - **No pending state.** Settings change in one call, so there is no proposal that can go stale,
///   be overwritten, or be cancelled by someone else.
/// - **One privileged object.** `AdminCap` is the only authority. There is no second "pauser" key
///   that could veto the admin's recovery.
/// - **Users are protected by their own signature, not by a timelock.** `take_fee` takes the most
///   the user agreed to pay (`max_fee`). If the admin raises the fee after a transaction was built,
///   that transaction aborts instead of overcharging.
/// - **Hard ceilings in the code** (100 bps, 5 USDC minimum), the same as the other wrappers, so a
///   stolen `AdminCap` can raise fees only up to a small, known bound and only for future
///   transactions.
///
/// What this module cannot do: force a user to call it. Someone who builds their own PTB and calls
/// Circle directly pays no Xebra fee. The fee is enforced for transfers made through the Xebra page.
/// `FeeTaken` is emitted in the same transaction as Circle's `DepositForBurn`, so volume can be
/// counted by joining the two events on the transaction digest.
module xebra_fee::fee;

use sui::coin::Coin;
use sui::event;

// === Limits compiled into the contract (same as the Stellar and Arc wrappers) ===

/// Basis-point denominator.
const BPS_DENOM: u128 = 10_000;
/// Highest fee percentage the admin can ever set: 100 bps = 1.00%.
const MAX_FEE_BPS_CEILING: u64 = 100;
/// Highest minimum fee the admin can ever set: 5 USDC at 6 decimals.
const MAX_MIN_FEE_CEILING: u64 = 5_000_000;

// === Errors ===

const EPaused: u64 = 0;
const EAmountNotPositive: u64 = 1;
const EFeeAboveMax: u64 = 2;
const EAmountBelowFee: u64 = 3;
const EFeeBpsTooHigh: u64 = 4;
const EMinFeeTooHigh: u64 = 5;
const EZeroRecipient: u64 = 6;

// === Objects ===

/// The only authority. Created once at publish and sent to the publisher. Move it to a multisig
/// address before real use: whoever holds it can change fees (within the ceilings), change where
/// fees go, and pause fee collection. It cannot touch anyone's funds.
public struct AdminCap has key, store {
    id: UID,
}

/// Fee settings for one coin type. Shared, so every transaction can read it. `T` is the coin being
/// bridged (Circle's USDC on Sui); the type parameter makes it impossible to pay a fee in the wrong
/// coin or read the wrong settings.
public struct FeeConfig<phantom T> has key {
    id: UID,
    fee_bps: u64,
    min_fee: u64,
    fee_recipient: address,
    paused: bool,
}

// === Events ===

/// A fee was collected. `gross` is what the user put in, `net` is what is left to burn.
public struct FeeTaken<phantom T> has copy, drop {
    config: ID,
    payer: address,
    gross: u64,
    fee: u64,
    net: u64,
    destination_domain: u32,
    fee_recipient: address,
}

public struct ConfigCreated<phantom T> has copy, drop {
    config: ID,
    fee_bps: u64,
    min_fee: u64,
    fee_recipient: address,
}

public struct FeeChanged<phantom T> has copy, drop {
    config: ID,
    old_fee_bps: u64,
    old_min_fee: u64,
    new_fee_bps: u64,
    new_min_fee: u64,
}

public struct RecipientChanged<phantom T> has copy, drop {
    config: ID,
    old_recipient: address,
    new_recipient: address,
}

public struct PauseChanged<phantom T> has copy, drop {
    config: ID,
    paused: bool,
}

// === Setup ===

fun init(ctx: &mut TxContext) {
    transfer::transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
}

/// Create and share the settings for coin type `T`. Normally called once, for USDC.
public fun create_config<T>(
    _: &AdminCap,
    fee_bps: u64,
    min_fee: u64,
    fee_recipient: address,
    ctx: &mut TxContext,
) {
    assert_fee_within_ceilings(fee_bps, min_fee);
    assert!(fee_recipient != @0x0, EZeroRecipient);
    let config = FeeConfig<T> {
        id: object::new(ctx),
        fee_bps,
        min_fee,
        fee_recipient,
        paused: false,
    };
    event::emit(ConfigCreated<T> {
        config: object::id(&config),
        fee_bps,
        min_fee,
        fee_recipient,
    });
    transfer::share_object(config);
}

// === The fee ===

/// What `take_fee` will charge on `gross`, without charging it. The page uses this to show the fee
/// and to set `max_fee`.
public fun quote<T>(config: &FeeConfig<T>, gross: u64): u64 {
    // u128 so `gross * fee_bps` cannot overflow, even at u64::MAX. The result is at most `gross`
    // because fee_bps is capped at 100, so the cast back to u64 is safe.
    let pct = (((gross as u128) * (config.fee_bps as u128)) / BPS_DENOM) as u64;
    if (pct > config.min_fee) pct else config.min_fee
}

/// Deduct Xebra's fee from `payment`, send it to the fee recipient, and leave the rest in
/// `payment` for the PTB to burn. Returns the fee.
///
/// `payment` is the coin the user is spending in full: its whole value is the amount, and the fee
/// comes out of it, the same as on the Stellar and Arc wrappers.
///
/// Aborts if fee collection is paused, the coin is empty, the fee would exceed `max_fee` (what the
/// user agreed to), or the fee would leave nothing to burn.
public fun take_fee<T>(
    config: &FeeConfig<T>,
    payment: &mut Coin<T>,
    destination_domain: u32,
    max_fee: u64,
    ctx: &mut TxContext,
): u64 {
    assert!(!config.paused, EPaused);
    let gross = payment.value();
    assert!(gross > 0, EAmountNotPositive);

    let fee = quote(config, gross);
    assert!(fee <= max_fee, EFeeAboveMax);
    assert!(gross > fee, EAmountBelowFee);

    if (fee > 0) {
        let fee_coin = payment.split(fee, ctx);
        transfer::public_transfer(fee_coin, config.fee_recipient);
    };

    event::emit(FeeTaken<T> {
        config: object::id(config),
        payer: ctx.sender(),
        gross,
        fee,
        net: gross - fee,
        destination_domain,
        fee_recipient: config.fee_recipient,
    });
    fee
}

// === Admin ===

/// Change the fee. Within the compiled ceilings, effective immediately. Transactions already built
/// carry their own `max_fee`, so a raise cannot overcharge them.
public fun set_fee<T>(_: &AdminCap, config: &mut FeeConfig<T>, fee_bps: u64, min_fee: u64) {
    assert_fee_within_ceilings(fee_bps, min_fee);
    event::emit(FeeChanged<T> {
        config: object::id(config),
        old_fee_bps: config.fee_bps,
        old_min_fee: config.min_fee,
        new_fee_bps: fee_bps,
        new_min_fee: min_fee,
    });
    config.fee_bps = fee_bps;
    config.min_fee = min_fee;
}

/// Change where fees are sent. Affects future fees only; the module holds nothing.
public fun set_fee_recipient<T>(_: &AdminCap, config: &mut FeeConfig<T>, new_recipient: address) {
    assert!(new_recipient != @0x0, EZeroRecipient);
    event::emit(RecipientChanged<T> {
        config: object::id(config),
        old_recipient: config.fee_recipient,
        new_recipient,
    });
    config.fee_recipient = new_recipient;
}

/// Stop or resume fee collection. While paused, `take_fee` aborts, so transfers built by the Xebra
/// page fail instead of going through without a fee.
public fun set_paused<T>(_: &AdminCap, config: &mut FeeConfig<T>, paused: bool) {
    config.paused = paused;
    event::emit(PauseChanged<T> { config: object::id(config), paused });
}

// === Reads ===

public fun fee_bps<T>(config: &FeeConfig<T>): u64 { config.fee_bps }

public fun min_fee<T>(config: &FeeConfig<T>): u64 { config.min_fee }

public fun fee_recipient<T>(config: &FeeConfig<T>): address { config.fee_recipient }

public fun is_paused<T>(config: &FeeConfig<T>): bool { config.paused }

public fun max_fee_bps_ceiling(): u64 { MAX_FEE_BPS_CEILING }

public fun max_min_fee_ceiling(): u64 { MAX_MIN_FEE_CEILING }

// === Internal ===

fun assert_fee_within_ceilings(fee_bps: u64, min_fee: u64) {
    assert!(fee_bps <= MAX_FEE_BPS_CEILING, EFeeBpsTooHigh);
    assert!(min_fee <= MAX_MIN_FEE_CEILING, EMinFeeTooHigh);
}

// === Test support ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx);
}

#[test_only]
public fun fee_taken_for_testing<T>(
    config: ID,
    payer: address,
    gross: u64,
    fee: u64,
    net: u64,
    destination_domain: u32,
    fee_recipient: address,
): FeeTaken<T> {
    FeeTaken<T> { config, payer, gross, fee, net, destination_domain, fee_recipient }
}
