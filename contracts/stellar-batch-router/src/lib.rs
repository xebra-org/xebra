//! XebraBatchRouter: many transfers, one signature, all or nothing.
//!
//! The wrapper (`contracts/stellar-cctp-wrapper-v2`, deployed `CCPVTWII…`) cannot be upgraded, and a
//! Stellar transaction carries exactly one contract invocation. So "send to many wallets" and "split
//! a transfer above Circle's per-message limit" both need one entry point that calls the wrapper's
//! `bridge` several times inside a single invocation. That is all this contract does.
//!
//! Atomic by construction: `bridge` is called with the panicking client, so if any one transfer is
//! rejected (by the wrapper or by Circle) the whole invocation fails and every earlier transfer in
//! the batch is rolled back with it. There is no partial batch.
//!
//! What it deliberately does not have: no admin, no state besides the wrapper address, no fee, no
//! upgrade path, and it never holds funds. USDC moves from the user to the wrapper and Circle
//! exactly as it does for a single transfer; every per-transfer check (amount bounds, fee caps,
//! domain allowlist, recipient shape, deadline, approval window) stays the wrapper's, applied to
//! each request unchanged. The router adds three checks of its own: the batch is not empty, not
//! longer than `MAX_BATCH`, and every request belongs to the one signer.
//!
//! Authorization: the user signs `batch(user, reqs)` once. Each nested `bridge` asks for the user's
//! auth on its own request, which the host matches as a sub-invocation of that one signed call, so a
//! wallet shows a single approval covering every transfer.
#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, Address, BytesN, Env, Vec,
};

/// The deployed wrapper's WASM (sha256 b5227c305b916c80a81d675dd8fbd8103e7d62e91c501e044ec93e365e686cd8,
/// the `wasmSha256` in `deployments/mainnet.json`). Tests run against it, and a test proves the two
/// types below encode exactly as that binary decodes them, so they cannot drift.
#[cfg(test)]
pub mod wrapper {
    soroban_sdk::contractimport!(file = "wasm/xebra_cctp_wrapper_v2_mainnet.wasm");
}

/// Field-for-field copy of the wrapper's `BridgeRequest` (see `stellar-cctp-wrapper-v2` for what
/// each field means). Declared here, not imported, so it is part of this contract's own interface:
/// wallets and the CLI encode `batch` arguments from it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeRequest {
    pub user: Address,
    pub amount: i128,
    pub destination_domain: u32,
    pub mint_recipient: BytesN<32>,
    pub max_fee: i128,
    pub min_finality_threshold: u32,
    pub approval_expiration_ledger: u32,
    pub recipient_needs_account: bool,
    pub recipient_owner: BytesN<32>,
    pub max_wrapper_fee: i128,
    pub deadline: u64,
}

/// Field-for-field copy of the wrapper's `Quote`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Quote {
    pub amount: i128,
    pub fee: i128,
    pub account_fee: i128,
    pub net_burned: i128,
    pub remainder: i128,
    pub forward_fee: i128,
    pub wrapper_take: i128,
    pub forwarded: bool,
    pub account_created: bool,
}

#[contractclient(name = "WrapperClient")]
pub trait Wrapper {
    fn bridge(env: Env, req: BridgeRequest) -> Quote;
}

/// Upper bound on transfers per batch: a loop guard, not the working limit. The working limit is the
/// network's 16 KiB per-transaction event budget, which allowed 5 forwarded transfers on testnet
/// (see README). It is a network setting that validators can raise, and this contract cannot be
/// upgraded, so the clients enforce the measured figure and this constant leaves room above it.
pub const MAX_BATCH: u32 = 16;

const INSTANCE_TTL_THRESHOLD: u32 = 518_400; // ~30 days at 5 s ledgers
const INSTANCE_TTL_EXTEND_TO: u32 = 3_110_400; // ~180 days

/// Codes start at 100 so they never collide with the wrapper's (1..45): when a batch fails, the
/// code alone says whether the router or the wrapper refused it.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    EmptyBatch = 100,
    BatchTooLarge = 101,
    UserMismatch = 102,
}

#[contracttype]
pub enum DataKey {
    Wrapper,
}

#[contract]
pub struct XebraBatchRouter;

#[contractimpl]
impl XebraBatchRouter {
    pub fn __constructor(env: Env, wrapper: Address) {
        let s = env.storage().instance();
        s.set(&DataKey::Wrapper, &wrapper);
        s.extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }

    /// Bridges every request in order, in one invocation. Fails, and changes nothing, if any one of
    /// them fails.
    ///
    /// Returns nothing on purpose. Stellar counts a transaction's return value against the same
    /// 16 KiB budget as its events (`tx_max_contract_events_size_bytes`), and each transfer already
    /// spends about 2.9 KiB of it on the wrapper's, Circle's and the token's events. Returning the
    /// quotes cost a whole transfer per batch on testnet (5 failed with "return value pushes events
    /// size above network config maximum", 16592 > 16384). Each quote is in the wrapper's
    /// `bridge_initiated` event anyway.
    pub fn batch(env: Env, user: Address, reqs: Vec<BridgeRequest>) -> Result<(), Error> {
        let n = reqs.len();
        if n == 0 {
            return Err(Error::EmptyBatch);
        }
        if n > MAX_BATCH {
            return Err(Error::BatchTooLarge);
        }
        for r in reqs.iter() {
            if r.user != user {
                return Err(Error::UserMismatch);
            }
        }

        // One signature over the whole list: the nested `bridge` auths are its sub-invocations.
        user.require_auth();

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);

        let client = WrapperClient::new(&env, &Self::get_wrapper(env.clone()));
        for r in reqs.iter() {
            // Panicking client on purpose: any refusal aborts the whole batch.
            client.bridge(&r);
        }
        Ok(())
    }

    pub fn get_wrapper(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Wrapper).unwrap()
    }
}

#[cfg(test)]
mod test;
