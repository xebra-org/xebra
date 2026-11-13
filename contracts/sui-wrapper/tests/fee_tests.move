#[test_only, allow(unused_let_mut)]
module xebra_fee::fee_tests;

use sui::coin::{Self, Coin};
use sui::event;
use sui::test_scenario::{Self as ts, Scenario};
use xebra_fee::fee::{Self, AdminCap, FeeConfig, FeeTaken};

const ADMIN: address = @0xA;
const USER: address = @0xB;
const TREASURY: address = @0xC;
const NEW_TREASURY: address = @0xD;

const U64_MAX: u64 = 18_446_744_073_709_551_615;
/// USDC has 6 decimals on Sui.
const USDC_1: u64 = 1_000_000;
/// The live model: 10 bps, 0.30 USDC floor.
const BPS: u64 = 10;
const MIN_FEE: u64 = 300_000;
/// Destination domain used in tests (Base).
const DOMAIN: u32 = 6;

public struct USDC has drop {}

/// Publish, then create the USDC settings as ADMIN. Leaves the scenario inside a fresh transaction.
fun setup(fee_bps: u64, min_fee: u64): Scenario {
    let mut sc = ts::begin(ADMIN);
    fee::init_for_testing(sc.ctx());
    sc.next_tx(ADMIN);
    let cap = sc.take_from_sender<AdminCap>();
    fee::create_config<USDC>(&cap, fee_bps, min_fee, TREASURY, sc.ctx());
    sc.return_to_sender(cap);
    sc.next_tx(ADMIN);
    sc
}

fun live(): Scenario { setup(BPS, MIN_FEE) }

// === Fee math ===

#[test]
fun quote_uses_the_minimum_on_small_amounts() {
    let mut sc = live();
    let config = sc.take_shared<FeeConfig<USDC>>();
    // 10 bps of 100 USDC is 0.10 USDC, below the 0.30 floor.
    assert!(fee::quote(&config, 100 * USDC_1) == MIN_FEE);
    // Even 1 base unit is charged the floor (and take_fee then refuses it as below the fee).
    assert!(fee::quote(&config, 1) == MIN_FEE);
    ts::return_shared(config);
    sc.end();
}

#[test]
fun quote_switches_to_the_percentage_exactly_at_the_floor() {
    let mut sc = live();
    let config = sc.take_shared<FeeConfig<USDC>>();
    // 10 bps of 300 USDC is exactly 0.30 USDC: both rules agree.
    assert!(fee::quote(&config, 300 * USDC_1) == MIN_FEE);
    // One base unit under: 299.999999 USDC * 10 / 10000 rounds down to 299_999, floor wins.
    assert!(fee::quote(&config, 300 * USDC_1 - 1) == MIN_FEE);
    // 1,000 USDC: 1.00 USDC.
    assert!(fee::quote(&config, 1_000 * USDC_1) == USDC_1);
    // 1,000,000 USDC: 1,000 USDC.
    assert!(fee::quote(&config, 1_000_000 * USDC_1) == 1_000 * USDC_1);
    ts::return_shared(config);
    sc.end();
}

#[test]
fun quote_rounds_the_percentage_down() {
    let mut sc = setup(BPS, 0);
    let config = sc.take_shared<FeeConfig<USDC>>();
    // 1,999 base units * 10 / 10000 = 1.999 -> 1.
    assert!(fee::quote(&config, 1_999) == 1);
    ts::return_shared(config);
    sc.end();
}

#[test]
fun quote_does_not_overflow_at_the_largest_amount() {
    let mut sc = live();
    let config = sc.take_shared<FeeConfig<USDC>>();
    let f = fee::quote(&config, U64_MAX);
    assert!(f == (((U64_MAX as u128) * (BPS as u128)) / 10_000) as u64);
    assert!(f < U64_MAX);
    ts::return_shared(config);
    sc.end();
}

// === take_fee ===

#[test]
fun take_fee_sends_the_fee_to_the_recipient_and_leaves_the_rest() {
    let mut sc = live();
    sc.next_tx(USER);
    let config = sc.take_shared<FeeConfig<USDC>>();
    let mut payment = coin::mint_for_testing<USDC>(100 * USDC_1, sc.ctx());

    let charged = fee::take_fee(&config, &mut payment, DOMAIN, MIN_FEE, sc.ctx());

    assert!(charged == MIN_FEE);
    assert!(payment.value() == 100 * USDC_1 - MIN_FEE);
    coin::burn_for_testing(payment);
    ts::return_shared(config);

    sc.next_tx(TREASURY);
    let fee_coin = sc.take_from_sender<Coin<USDC>>();
    assert!(fee_coin.value() == MIN_FEE);
    coin::burn_for_testing(fee_coin);
    sc.end();
}

#[test]
fun take_fee_emits_one_event_with_the_full_picture() {
    let mut sc = live();
    sc.next_tx(USER);
    let config = sc.take_shared<FeeConfig<USDC>>();
    let mut payment = coin::mint_for_testing<USDC>(1_000 * USDC_1, sc.ctx());

    fee::take_fee(&config, &mut payment, DOMAIN, USDC_1, sc.ctx());

    let events = event::events_by_type<FeeTaken<USDC>>();
    assert!(events.length() == 1);
    assert!(
        events[0] == fee::fee_taken_for_testing<USDC>(
            object::id(&config),
            USER,
            1_000 * USDC_1,
            USDC_1,
            999 * USDC_1,
            DOMAIN,
            TREASURY,
        ),
    );
    coin::burn_for_testing(payment);
    ts::return_shared(config);
    sc.end();
}

#[test]
fun there_is_no_maximum_transfer() {
    // 18 quintillion base units, the most a Coin can hold. The fee is a bounded percentage of it
    // and nothing aborts.
    let mut sc = live();
    sc.next_tx(USER);
    let config = sc.take_shared<FeeConfig<USDC>>();
    let mut payment = coin::mint_for_testing<USDC>(U64_MAX, sc.ctx());
    let max_fee = fee::quote(&config, U64_MAX);

    let charged = fee::take_fee(&config, &mut payment, DOMAIN, max_fee, sc.ctx());

    assert!(charged == max_fee);
    assert!(payment.value() == U64_MAX - max_fee);
    coin::burn_for_testing(payment);
    ts::return_shared(config);
    sc.end();
}

#[test]
fun a_zero_fee_config_takes_nothing_and_sends_nothing() {
    let mut sc = setup(0, 0);
    sc.next_tx(USER);
    let config = sc.take_shared<FeeConfig<USDC>>();
    let mut payment = coin::mint_for_testing<USDC>(5 * USDC_1, sc.ctx());

    let charged = fee::take_fee(&config, &mut payment, DOMAIN, 0, sc.ctx());

    assert!(charged == 0);
    assert!(payment.value() == 5 * USDC_1);
    coin::burn_for_testing(payment);
    ts::return_shared(config);

    sc.next_tx(TREASURY);
    assert!(!ts::has_most_recent_for_sender<Coin<USDC>>(&sc));
    sc.end();
}

#[test, expected_failure(abort_code = fee::EFeeAboveMax)]
fun take_fee_aborts_if_the_fee_is_more_than_the_user_agreed_to() {
    let mut sc = live();
    sc.next_tx(USER);
    let config = sc.take_shared<FeeConfig<USDC>>();
    let mut payment = coin::mint_for_testing<USDC>(100 * USDC_1, sc.ctx());
    fee::take_fee(&config, &mut payment, DOMAIN, MIN_FEE - 1, sc.ctx());
    abort 999
}

#[test, expected_failure(abort_code = fee::EAmountBelowFee)]
fun take_fee_aborts_if_the_fee_would_leave_nothing_to_burn() {
    let mut sc = live();
    sc.next_tx(USER);
    let config = sc.take_shared<FeeConfig<USDC>>();
    // Exactly the floor: nothing would remain.
    let mut payment = coin::mint_for_testing<USDC>(MIN_FEE, sc.ctx());
    fee::take_fee(&config, &mut payment, DOMAIN, MIN_FEE, sc.ctx());
    abort 999
}

#[test, expected_failure(abort_code = fee::EAmountNotPositive)]
fun take_fee_aborts_on_an_empty_coin() {
    let mut sc = live();
    sc.next_tx(USER);
    let config = sc.take_shared<FeeConfig<USDC>>();
    let mut payment = coin::zero<USDC>(sc.ctx());
    fee::take_fee(&config, &mut payment, DOMAIN, MIN_FEE, sc.ctx());
    abort 999
}

// === Pause ===

#[test, expected_failure(abort_code = fee::EPaused)]
fun take_fee_aborts_while_paused() {
    let mut sc = live();
    let cap = sc.take_from_sender<AdminCap>();
    let mut config = sc.take_shared<FeeConfig<USDC>>();
    fee::set_paused(&cap, &mut config, true);
    assert!(fee::is_paused(&config));
    ts::return_shared(config);
    sc.return_to_sender(cap);

    sc.next_tx(USER);
    let config = sc.take_shared<FeeConfig<USDC>>();
    let mut payment = coin::mint_for_testing<USDC>(100 * USDC_1, sc.ctx());
    fee::take_fee(&config, &mut payment, DOMAIN, MIN_FEE, sc.ctx());
    abort 999
}

#[test]
fun unpausing_restores_fee_collection() {
    let mut sc = live();
    let cap = sc.take_from_sender<AdminCap>();
    let mut config = sc.take_shared<FeeConfig<USDC>>();
    fee::set_paused(&cap, &mut config, true);
    fee::set_paused(&cap, &mut config, false);
    ts::return_shared(config);
    sc.return_to_sender(cap);

    sc.next_tx(USER);
    let config = sc.take_shared<FeeConfig<USDC>>();
    let mut payment = coin::mint_for_testing<USDC>(100 * USDC_1, sc.ctx());
    assert!(fee::take_fee(&config, &mut payment, DOMAIN, MIN_FEE, sc.ctx()) == MIN_FEE);
    coin::burn_for_testing(payment);
    ts::return_shared(config);
    sc.end();
}

// === Admin: fee ===

#[test]
fun the_admin_can_change_the_fee_up_to_the_ceilings() {
    let mut sc = live();
    let cap = sc.take_from_sender<AdminCap>();
    let mut config = sc.take_shared<FeeConfig<USDC>>();

    fee::set_fee(&cap, &mut config, fee::max_fee_bps_ceiling(), fee::max_min_fee_ceiling());
    assert!(fee::fee_bps(&config) == 100);
    assert!(fee::min_fee(&config) == 5_000_000);
    // 1,000,000 USDC at 1.00%.
    assert!(fee::quote(&config, 1_000_000 * USDC_1) == 10_000 * USDC_1);

    ts::return_shared(config);
    sc.return_to_sender(cap);
    sc.end();
}

#[test, expected_failure(abort_code = fee::EFeeBpsTooHigh)]
fun the_fee_percentage_cannot_pass_one_percent() {
    let mut sc = live();
    let cap = sc.take_from_sender<AdminCap>();
    let mut config = sc.take_shared<FeeConfig<USDC>>();
    fee::set_fee(&cap, &mut config, 101, MIN_FEE);
    abort 999
}

#[test, expected_failure(abort_code = fee::EMinFeeTooHigh)]
fun the_minimum_fee_cannot_pass_five_usdc() {
    let mut sc = live();
    let cap = sc.take_from_sender<AdminCap>();
    let mut config = sc.take_shared<FeeConfig<USDC>>();
    fee::set_fee(&cap, &mut config, BPS, 5_000_001);
    abort 999
}

#[test, expected_failure(abort_code = fee::EFeeBpsTooHigh)]
fun creating_a_config_above_the_ceiling_fails() {
    let mut sc = ts::begin(ADMIN);
    fee::init_for_testing(sc.ctx());
    sc.next_tx(ADMIN);
    let cap = sc.take_from_sender<AdminCap>();
    fee::create_config<USDC>(&cap, 101, MIN_FEE, TREASURY, sc.ctx());
    abort 999
}

#[test, expected_failure(abort_code = fee::EFeeAboveMax)]
fun a_fee_raised_after_the_user_signed_makes_their_transaction_abort() {
    // The user's transaction was built when the fee was 0.30 USDC, so it carries max_fee = 0.30.
    let mut sc = live();
    let cap = sc.take_from_sender<AdminCap>();
    let mut config = sc.take_shared<FeeConfig<USDC>>();
    fee::set_fee(&cap, &mut config, 100, 5_000_000);
    ts::return_shared(config);
    sc.return_to_sender(cap);

    sc.next_tx(USER);
    let config = sc.take_shared<FeeConfig<USDC>>();
    let mut payment = coin::mint_for_testing<USDC>(1_000 * USDC_1, sc.ctx());
    fee::take_fee(&config, &mut payment, DOMAIN, MIN_FEE, sc.ctx());
    abort 999
}

// === Admin: recipient ===

#[test]
fun changing_the_recipient_redirects_future_fees_only() {
    let mut sc = live();
    let cap = sc.take_from_sender<AdminCap>();
    let mut config = sc.take_shared<FeeConfig<USDC>>();
    fee::set_fee_recipient(&cap, &mut config, NEW_TREASURY);
    assert!(fee::fee_recipient(&config) == NEW_TREASURY);
    ts::return_shared(config);
    sc.return_to_sender(cap);

    sc.next_tx(USER);
    let config = sc.take_shared<FeeConfig<USDC>>();
    let mut payment = coin::mint_for_testing<USDC>(100 * USDC_1, sc.ctx());
    fee::take_fee(&config, &mut payment, DOMAIN, MIN_FEE, sc.ctx());
    coin::burn_for_testing(payment);
    ts::return_shared(config);

    sc.next_tx(NEW_TREASURY);
    let fee_coin = sc.take_from_sender<Coin<USDC>>();
    assert!(fee_coin.value() == MIN_FEE);
    coin::burn_for_testing(fee_coin);
    sc.end();
}

#[test, expected_failure(abort_code = fee::EZeroRecipient)]
fun the_recipient_cannot_be_the_zero_address() {
    let mut sc = live();
    let cap = sc.take_from_sender<AdminCap>();
    let mut config = sc.take_shared<FeeConfig<USDC>>();
    fee::set_fee_recipient(&cap, &mut config, @0x0);
    abort 999
}

#[test, expected_failure(abort_code = fee::EZeroRecipient)]
fun creating_a_config_with_a_zero_recipient_fails() {
    let mut sc = ts::begin(ADMIN);
    fee::init_for_testing(sc.ctx());
    sc.next_tx(ADMIN);
    let cap = sc.take_from_sender<AdminCap>();
    fee::create_config<USDC>(&cap, BPS, MIN_FEE, @0x0, sc.ctx());
    abort 999
}

// === Authority ===

#[test]
fun only_the_publisher_holds_the_admin_cap() {
    let mut sc = live();
    assert!(ts::has_most_recent_for_address<AdminCap>(ADMIN));
    assert!(!ts::has_most_recent_for_address<AdminCap>(USER));
    assert!(!ts::has_most_recent_for_address<AdminCap>(TREASURY));
    sc.end();
}

#[test]
fun the_admin_cap_can_be_handed_to_a_multisig() {
    let mut sc = live();
    let cap = sc.take_from_sender<AdminCap>();
    transfer::public_transfer(cap, NEW_TREASURY);

    sc.next_tx(NEW_TREASURY);
    let cap = sc.take_from_sender<AdminCap>();
    let mut config = sc.take_shared<FeeConfig<USDC>>();
    fee::set_paused(&cap, &mut config, true);
    ts::return_shared(config);
    sc.return_to_sender(cap);
    assert!(!ts::has_most_recent_for_address<AdminCap>(ADMIN));
    sc.end();
}
