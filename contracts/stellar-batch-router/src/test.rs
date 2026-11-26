//! Tests run the router against the wrapper WASM deployed on mainnet (imported in `lib.rs`), with a
//! mock Circle messenger that pulls the burn with `transfer_from` exactly as Circle's does. So the
//! allowance each nested `bridge` creates must really exist and really be consumed.
//!
//! `mock_all_auths()` satisfies `require_auth` without signatures. The auth-tree test inspects what
//! the host recorded, and the testnet run in the README checks a real signature end to end.

use soroban_sdk::testutils::{Address as _, AuthorizedFunction, Ledger as _};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, vec, Address, BytesN, Env,
    IntoVal, Symbol, TryFromVal, Val, Vec,
};

use crate::wrapper::{self, DomainCfg, Params};
use crate::{BridgeRequest, Error, Quote, XebraBatchRouter, XebraBatchRouterClient, MAX_BATCH};

const DOMAIN_SOLANA: u32 = 5;
const DOMAIN_ARC: u32 = 26;

// ---------------------------------------------------------------------------
// Mock Circle TokenMessengerMinter
// ---------------------------------------------------------------------------

#[contracttype]
pub enum MockKey {
    PanicOnAmount,
    Burns,
}

#[contract]
pub struct MockMessenger;

#[contractimpl]
impl MockMessenger {
    /// `panic_on_amount`: a burn of exactly this amount is refused, which is how a test makes
    /// Circle reject one transfer in the middle of a batch. Zero disables it.
    pub fn __constructor(env: Env, panic_on_amount: i128) {
        env.storage()
            .instance()
            .set(&MockKey::PanicOnAmount, &panic_on_amount);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn deposit_for_burn(
        env: Env,
        caller: Address,
        amount: i128,
        _destination_domain: u32,
        _mint_recipient: BytesN<32>,
        burn_token: Address,
        _destination_caller: BytesN<32>,
        _max_fee: i128,
        _min_finality_threshold: u32,
    ) {
        Self::burn(env, caller, amount, burn_token);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn deposit_for_burn_with_hook(
        env: Env,
        caller: Address,
        amount: i128,
        _destination_domain: u32,
        _mint_recipient: BytesN<32>,
        burn_token: Address,
        _destination_caller: BytesN<32>,
        _max_fee: i128,
        _min_finality_threshold: u32,
        hook_data: soroban_sdk::Bytes,
    ) {
        if hook_data.is_empty() {
            panic!("HookDataEmpty");
        }
        Self::burn(env, caller, amount, burn_token);
    }

    fn burn(env: Env, caller: Address, amount: i128, burn_token: Address) {
        let p: i128 = env
            .storage()
            .instance()
            .get(&MockKey::PanicOnAmount)
            .unwrap_or(0);
        if p != 0 && amount == p {
            panic!("circle rejected the burn");
        }
        // Circle's `deposit_and_burn` pulls with transfer_from: needs a real allowance.
        token::Client::new(&env, &burn_token).transfer_from(
            &env.current_contract_address(),
            &caller,
            &env.current_contract_address(),
            &amount,
        );
        let n: u32 = env.storage().instance().get(&MockKey::Burns).unwrap_or(0);
        env.storage().instance().set(&MockKey::Burns, &(n + 1));
    }

    pub fn burns(env: Env) -> u32 {
        env.storage().instance().get(&MockKey::Burns).unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const USDC: i128 = 1_0000000; // 7 decimals on Stellar
const FEE_BPS: u32 = 5;
const MIN_FEE: i128 = 1_000_000; // 0.10
const MAX_TRANSFER: i128 = 10_000_000 * USDC; // Circle's per-message limit, as live on mainnet
const ARC_FORWARD_CAP: i128 = 1_000_000;

struct Setup<'a> {
    env: Env,
    router: XebraBatchRouterClient<'a>,
    wrapper: wrapper::Client<'a>,
    messenger: MockMessengerClient<'a>,
    token: token::Client<'a>,
    user: Address,
}

fn setup() -> Setup<'static> {
    setup_with(0)
}

fn setup_with(panic_on_amount: i128) -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    env.ledger().set_timestamp(1_000_000);

    let issuer = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(issuer).address();
    let token = token::Client::new(&env, &usdc);
    let token_admin = token::StellarAssetClient::new(&env, &usdc);

    let messenger_id = env.register(MockMessenger, (panic_on_amount,));
    let params = Params {
        fee_bps: FEE_BPS,
        min_fee: MIN_FEE,
        min_transfer: USDC,
        max_transfer: MAX_TRANSFER,
        max_cctp_fee_bps: 20,
        account_fee: 0,
    };
    let domains: Vec<DomainCfg> = vec![
        &env,
        DomainCfg {
            domain: DOMAIN_SOLANA,
            evm_style: false,
            forward: false,
            max_forward_fee: 0,
            account_creation: false,
            max_forward_fee_new_account: 0,
        },
        DomainCfg {
            domain: DOMAIN_ARC,
            evm_style: true,
            forward: true,
            max_forward_fee: ARC_FORWARD_CAP,
            account_creation: false,
            max_forward_fee_new_account: 0,
        },
    ];
    let wrapper_id = env.register(
        wrapper::WASM,
        (
            usdc.clone(),
            messenger_id.clone(),
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
            params,
            domains,
        ),
    );
    let router_id = env.register(XebraBatchRouter, (wrapper_id.clone(),));

    let user = Address::generate(&env);
    token_admin.mint(&user, &(30_000_000 * USDC));

    Setup {
        router: XebraBatchRouterClient::new(&env, &router_id),
        wrapper: wrapper::Client::new(&env, &wrapper_id),
        messenger: MockMessengerClient::new(&env, &messenger_id),
        token,
        user,
        env,
    }
}

fn solana(env: &Env, tag: u8) -> BytesN<32> {
    BytesN::from_array(env, &[tag; 32])
}

fn evm(env: &Env, tag: u8) -> BytesN<32> {
    let mut b = [0u8; 32];
    for x in b.iter_mut().skip(12) {
        *x = tag;
    }
    BytesN::from_array(env, &b)
}

/// A Solana relay-path request (the wrapper's simplest path).
fn req(s: &Setup, amount: i128, recipient: BytesN<32>) -> BridgeRequest {
    BridgeRequest {
        user: s.user.clone(),
        amount,
        destination_domain: DOMAIN_SOLANA,
        mint_recipient: recipient,
        // Bounded by the wrapper at 20 bps of net; 1 bp is always inside it.
        max_fee: amount / 10_000,
        min_finality_threshold: 2000,
        max_wrapper_fee: amount,
        recipient_needs_account: false,
        recipient_owner: BytesN::from_array(&s.env, &[0u8; 32]),
        approval_expiration_ledger: s.env.ledger().sequence() + 30,
        deadline: s.env.ledger().timestamp() + 600,
    }
}

fn fee(amount: i128) -> i128 {
    core::cmp::max(amount * FEE_BPS as i128 / 10_000, MIN_FEE)
}

// ---------------------------------------------------------------------------
// The two use cases
// ---------------------------------------------------------------------------

#[test]
fn one_send_to_many_wallets() {
    let s = setup();
    let before = s.token.balance(&s.user);
    let reqs = vec![
        &s.env,
        req(&s, 100 * USDC, solana(&s.env, 1)),
        req(&s, 250 * USDC, solana(&s.env, 2)),
        req(&s, 40 * USDC, solana(&s.env, 3)),
    ];
    s.router.batch(&s.user, &reqs);

    assert_eq!(s.messenger.burns(), 3);
    assert_eq!(s.wrapper.get_seq(), 3);
    // Relay path, whole-unit amounts: each transfer debits exactly its amount (fee + net).
    assert_eq!(s.token.balance(&s.user), before - 390 * USDC);
    assert_eq!(
        s.wrapper.get_accrued_fees(),
        fee(100 * USDC) + fee(250 * USDC) + fee(40 * USDC)
    );
    assert_eq!(
        s.token.balance(&s.messenger.address),
        390 * USDC - s.wrapper.get_accrued_fees()
    );
    // The router never holds anything.
    assert_eq!(s.token.balance(&s.router.address), 0);
}

#[test]
fn twenty_million_splits_into_two_identical_transfers() {
    // Two byte-identical requests: the auth tree has two identical children and the host must
    // match each to its own `bridge`. This is the "split above the per-message limit" case.
    let s = setup();
    let half = 10_000_000 * USDC;
    let r = req(&s, half, solana(&s.env, 9));
    s.router.batch(&s.user, &vec![&s.env, r.clone(), r]);

    assert_eq!(s.messenger.burns(), 2);
    assert_eq!(s.wrapper.get_seq(), 2);
    assert_eq!(s.token.balance(&s.messenger.address), 2 * (half - fee(half)));
}

#[test]
fn mixed_paths_in_one_batch() {
    // A forwarded EVM transfer next to a relay-path Solana one.
    let s = setup();
    let mut arc = req(&s, 50 * USDC, evm(&s.env, 4));
    arc.destination_domain = DOMAIN_ARC;
    arc.max_fee = 200_000; // 0.02, under the 0.10 forward cap
    let arc_q = s.wrapper.quote(&arc.amount, &false, &DOMAIN_ARC, &arc.max_fee);
    assert!(arc_q.forwarded);
    s.router
        .batch(&s.user, &vec![&s.env, arc, req(&s, 50 * USDC, solana(&s.env, 5))]);
    assert_eq!(s.messenger.burns(), 2);
    // Forwarded: we keep fee - forward_fee. Relay path: we keep the whole fee.
    assert_eq!(
        s.wrapper.get_accrued_fees(),
        arc_q.wrapper_take + fee(50 * USDC)
    );
}

// ---------------------------------------------------------------------------
// Atomicity: one refusal undoes the whole batch
// ---------------------------------------------------------------------------

fn assert_nothing_moved(s: &Setup, before: i128) {
    assert_eq!(s.token.balance(&s.user), before);
    assert_eq!(s.messenger.burns(), 0);
    assert_eq!(s.wrapper.get_seq(), 0);
    assert_eq!(s.wrapper.get_accrued_fees(), 0);
    assert_eq!(s.token.balance(&s.wrapper.address), 0);
}

#[test]
fn wrapper_refusing_the_last_transfer_reverts_the_first() {
    let s = setup();
    let before = s.token.balance(&s.user);
    let reqs = vec![
        &s.env,
        req(&s, 100 * USDC, solana(&s.env, 1)),
        req(&s, 100 * USDC, solana(&s.env, 2)),
        req(&s, MAX_TRANSFER + 1, solana(&s.env, 3)), // above the wrapper's cap
    ];
    assert!(s.router.try_batch(&s.user, &reqs).is_err());
    assert_nothing_moved(&s, before);
}

#[test]
fn circle_refusing_a_middle_transfer_reverts_all() {
    let bad = 77 * USDC;
    let s = setup_with(bad - fee(bad)); // the mock refuses this net burn
    let before = s.token.balance(&s.user);
    let reqs = vec![
        &s.env,
        req(&s, 100 * USDC, solana(&s.env, 1)),
        req(&s, bad, solana(&s.env, 2)),
        req(&s, 100 * USDC, solana(&s.env, 3)),
    ];
    assert!(s.router.try_batch(&s.user, &reqs).is_err());
    assert_nothing_moved(&s, before);
}

#[test]
fn unknown_destination_in_batch_reverts_all() {
    let s = setup();
    let before = s.token.balance(&s.user);
    let mut bad = req(&s, 100 * USDC, solana(&s.env, 2));
    bad.destination_domain = 99;
    let reqs = vec![&s.env, req(&s, 100 * USDC, solana(&s.env, 1)), bad];
    assert!(s.router.try_batch(&s.user, &reqs).is_err());
    assert_nothing_moved(&s, before);
}

#[test]
fn insufficient_balance_for_the_whole_batch_reverts_all() {
    let s = setup();
    let before = s.token.balance(&s.user); // 30M
    let r = req(&s, MAX_TRANSFER, solana(&s.env, 1));
    // The user holds 30M: three 10M transfers fit exactly (fees come out of each amount), so a
    // fourth must fail, and the three before it must not stand.
    let reqs = vec![&s.env, r.clone(), r.clone(), r.clone(), r];
    assert!(s.router.try_batch(&s.user, &reqs).is_err());
    assert_nothing_moved(&s, before);
}

// ---------------------------------------------------------------------------
// The router's own checks
// ---------------------------------------------------------------------------

#[test]
fn empty_batch_is_refused() {
    let s = setup();
    let empty: Vec<BridgeRequest> = Vec::new(&s.env);
    assert_eq!(
        s.router.try_batch(&s.user, &empty),
        Err(Ok(Error::EmptyBatch))
    );
}

#[test]
fn oversized_batch_is_refused() {
    let s = setup();
    let mut reqs = Vec::new(&s.env);
    for i in 0..=MAX_BATCH {
        reqs.push_back(req(&s, 10 * USDC, solana(&s.env, i as u8 + 1)));
    }
    assert_eq!(
        s.router.try_batch(&s.user, &reqs),
        Err(Ok(Error::BatchTooLarge))
    );
}

/// Five is what fit in one transaction against Circle's real testnet contracts (README). The mock
/// emits fewer events than Circle, so this proves the loop, not the limit.
#[test]
fn five_transfers_in_one_batch() {
    let s = setup();
    let mut reqs = Vec::new(&s.env);
    for i in 0..5u8 {
        reqs.push_back(req(&s, 10 * USDC, solana(&s.env, i + 1)));
    }
    s.router.batch(&s.user, &reqs);
    assert_eq!(s.messenger.burns(), 5);
    assert_eq!(s.wrapper.get_seq(), 5);
}

#[test]
fn request_for_another_user_is_refused() {
    let s = setup();
    let mut other = req(&s, 100 * USDC, solana(&s.env, 2));
    other.user = Address::generate(&s.env);
    let reqs = vec![&s.env, req(&s, 100 * USDC, solana(&s.env, 1)), other];
    assert_eq!(
        s.router.try_batch(&s.user, &reqs),
        Err(Ok(Error::UserMismatch))
    );
    assert_eq!(s.messenger.burns(), 0);
}

#[test]
fn router_error_codes_do_not_collide_with_the_wrapper() {
    assert!(Error::EmptyBatch as u32 >= 100);
    assert!(Error::BatchTooLarge as u32 >= 100);
    assert!(Error::UserMismatch as u32 >= 100);
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

#[test]
fn one_signature_covers_every_transfer() {
    let s = setup();
    let reqs = vec![
        &s.env,
        req(&s, 100 * USDC, solana(&s.env, 1)),
        req(&s, 200 * USDC, solana(&s.env, 2)),
    ];
    s.router.batch(&s.user, &reqs);

    let auths = s.env.auths();
    // Exactly one root authorization, for the user, on `batch(user, reqs)`.
    assert_eq!(auths.len(), 1);
    let (who, root) = &auths[0];
    assert_eq!(who, &s.user);
    let AuthorizedFunction::Contract((contract, name, args)) = &root.function else {
        panic!("root is not a contract call");
    };
    assert_eq!(contract, &s.router.address);
    assert_eq!(name, &Symbol::new(&s.env, "batch"));
    assert_eq!(args, &(s.user.clone(), reqs.clone()).into_val(&s.env));

    // Under it: one `bridge` per request, each carrying exactly that request.
    assert_eq!(root.sub_invocations.len(), 2);
    for (i, sub) in root.sub_invocations.iter().enumerate() {
        let AuthorizedFunction::Contract((c, n, a)) = &sub.function else {
            panic!("sub is not a contract call");
        };
        assert_eq!(c, &s.wrapper.address);
        assert_eq!(n, &symbol_short!("bridge"));
        assert_eq!(a, &(reqs.get(i as u32).unwrap(),).into_val(&s.env));
    }
}

#[test]
#[should_panic]
fn no_signature_no_batch() {
    let s = setup();
    let reqs = vec![&s.env, req(&s, 100 * USDC, solana(&s.env, 1))];
    s.env.set_auths(&[]);
    s.router.batch(&s.user, &reqs);
}

// ---------------------------------------------------------------------------
// The router's copies of the wrapper's types must encode exactly as the deployed WASM decodes
// ---------------------------------------------------------------------------

#[test]
fn bridge_request_round_trips_through_the_deployed_type() {
    let s = setup();
    let mut r = req(&s, 123 * USDC, solana(&s.env, 7));
    r.recipient_needs_account = true;
    r.recipient_owner = solana(&s.env, 8);
    let v: Val = r.clone().into_val(&s.env);
    let theirs = wrapper::BridgeRequest::try_from_val(&s.env, &v).unwrap();
    assert_eq!(theirs.amount, r.amount);
    assert_eq!(theirs.recipient_owner, r.recipient_owner);
    assert_eq!(theirs.deadline, r.deadline);
    let back: Val = theirs.into_val(&s.env);
    assert_eq!(BridgeRequest::try_from_val(&s.env, &back).unwrap(), r);
}

#[test]
fn quote_round_trips_through_the_deployed_type() {
    let env = Env::default();
    let q = Quote {
        amount: 1,
        fee: 2,
        account_fee: 3,
        net_burned: 4,
        remainder: 5,
        forward_fee: 6,
        wrapper_take: 7,
        forwarded: true,
        account_created: false,
    };
    let v: Val = q.clone().into_val(&env);
    let theirs = wrapper::Quote::try_from_val(&env, &v).unwrap();
    assert_eq!(theirs.wrapper_take, 7);
    let back: Val = theirs.into_val(&env);
    assert_eq!(Quote::try_from_val(&env, &back).unwrap(), q);
}
