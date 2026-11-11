import {
  type Account,
  Address,
  Contract,
  type Transaction,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import type { TransferStep } from "./types.js";

/**
 * Inclusion-fee bid, in stroops (0.1 XLM).
 *
 * This is a **bid ceiling, not a charge**. Stellar charges the market clearing rate up to
 * your bid, so bidding high costs nothing in the normal case and buys reliable inclusion when
 * the network is busy.
 *
 * `BASE_FEE` (100) is the network *minimum*, and using it was the bug behind the first real
 * mainnet attempt: the approve was accepted by the client, never included in any ledger, and
 * came back NOT_FOUND on both Horizon and Soroban RPC. Live mainnet stats at the time:
 *
 *     ledger_capacity_usage  0.78          (surge pricing active)
 *     max_fee bids  p50      144,395       (we were bidding 100)
 *     fee_charged   p50      100           (what you actually pay)
 *
 * So the median bid was ~1,400x ours while the median *charge* was the floor. 0.1 XLM sits
 * above the observed p90 of fees actually charged (9,486) with a wide margin, and caps the
 * worst case at roughly three cents.
 *
 * `prepareTransaction` adds Soroban's deterministic resource fee on top; this bids only for
 * inclusion.
 */
export const INCLUSION_FEE = "1000000";

/** Ledgers the allowance stays live for. It only needs to survive the following burn. */
export const APPROVAL_TTL_LEDGERS = 60;

/**
 * Encodes `BridgeRequest` for the contract.
 *
 * # Why every type is spelled out
 *
 * `nativeToScVal` guesses when it is not told, and both of its defaults are wrong here.
 *
 * **Keys.** A JS object becomes an ScMap, and its string keys default to `scvString`. Soroban
 * `#[contracttype]` structs are maps keyed by `scvSymbol`. A string-keyed map has the right field
 * names and the wrong key type, so the contract cannot unpack it.
 *
 * **Integers.** The SDK picks "the smallest XDR integer type that will fit the value". So
 * `amount` of 100000000 goes out as a small int rather than the `i128` the contract declares, and
 * `destination_domain` of 5 does not become `u32` because 5 fits in something narrower. The
 * encoding then depends on the *value*, which means a request can encode correctly at one amount
 * and incorrectly at another.
 *
 * Both faults surface identically and unhelpfully: `Error(Value, UnexpectedType)` out of
 * `map_unpack_to_linear_memory`, naming no field. This cost a live mainnet attempt to find.
 *
 * Each entry below is `[keyType, valueType]`; `null` means the SDK's default, used only for
 * `user`, where an `Address` instance is already unambiguous.
 */
export function encodeBridgeRequest(req: {
  user: string;
  amount: bigint;
  destinationDomain: number;
  mintRecipient: Uint8Array;
  maxFee: bigint;
  minFinalityThreshold: number;
  recipientNeedsAccount: boolean;
  /** The wallet that owns the recipient's token account, when Circle is to create it; all zeroes
   *  otherwise. */
  recipientOwner: Uint8Array;
  approvalExpirationLedger: number;
  maxWrapperFee: bigint;
  deadline: bigint;
}) {
  return nativeToScVal(
    {
      user: new Address(req.user),
      amount: req.amount,
      destination_domain: req.destinationDomain,
      mint_recipient: Buffer.from(req.mintRecipient),
      max_fee: req.maxFee,
      min_finality_threshold: req.minFinalityThreshold,
      recipient_needs_account: req.recipientNeedsAccount,
      recipient_owner: Buffer.from(req.recipientOwner),
      approval_expiration_ledger: req.approvalExpirationLedger,
      max_wrapper_fee: req.maxWrapperFee,
      deadline: req.deadline,
    },
    {
      type: {
        user: ["symbol", null],
        amount: ["symbol", "i128"],
        destination_domain: ["symbol", "u32"],
        mint_recipient: ["symbol", "bytes"],
        max_fee: ["symbol", "i128"],
        min_finality_threshold: ["symbol", "u32"],
        recipient_needs_account: ["symbol", "bool"],
        recipient_owner: ["symbol", "bytes"],
        approval_expiration_ledger: ["symbol", "u32"],
        max_wrapper_fee: ["symbol", "i128"],
        deadline: ["symbol", "u64"],
      },
    } as Parameters<typeof nativeToScVal>[1],
  );
}

/** What `bridge()` needs, in stroops (7 decimals) except where noted. */
export interface StellarBridgeInput {
  /** The sender's G address: the transaction source and the signer. */
  user: string;
  amount: bigint;
  destinationDomain: number;
  /** Destination recipient, already decoded to 32 bytes and validated. */
  mintRecipient: Uint8Array;
  maxFee: bigint;
  /** The user's own ceiling on Xebra's fee, from the quote they were shown. */
  maxWrapperFee: bigint;
  /** 2000: Standard, the only finality Stellar has. */
  minFinalityThreshold: number;
  /** Must match the value the quote was taken with, or the price shown and charged differ. */
  recipientNeedsAccount: boolean;
  /** The recipient's wallet, 32 bytes, when `recipientNeedsAccount`; otherwise null. */
  recipientOwner: Uint8Array | null;
  /** Seconds from now. The contract rejects anything beyond one hour. */
  ttlSeconds: number;
}

/** The three Soroban RPC calls a build makes; `rpc.Server` satisfies it. */
export interface StellarBuildRpc {
  getAccount(address: string): Promise<Account>;
  getLatestLedger(): Promise<{ sequence: number }>;
  prepareTransaction(tx: Transaction): Promise<Transaction>;
}

/** How long the built transaction is submittable. The approval expiry (about 5 min) is longer. */
const TX_TIMEOUT_SECS = 120;

/**
 * Builds and simulates `bridge()` for the wallet to sign. One transaction, one signature: the auth
 * tree covers both the fee transfer and Circle's `deposit_for_burn`, because the user, not the
 * wrapper, is the `caller` passed to Circle.
 *
 * Simulation attaches the auth entries and resource footprint. If the contract would reject the
 * request it fails here, before anyone is asked to sign; the error is passed through as the RPC
 * gave it, for the caller to explain.
 */
export async function buildStellarBridge(
  server: StellarBuildRpc,
  cfg: { wrapperContractId: string; networkPassphrase: string },
  p: StellarBridgeInput,
  now: number = Date.now(),
): Promise<TransferStep> {
  const contract = new Contract(cfg.wrapperContractId);
  const account = await server.getAccount(p.user);
  const deadline = BigInt(Math.floor(now / 1000) + p.ttlSeconds);

  // The ledger at which the one-shot allowance to Circle's TokenMessenger expires, sent as
  // signed data rather than computed on chain.
  //
  // Soroban matches every sub-invocation against the signed authorization tree argument by
  // argument. The contract's `approve(user, messenger, net, expiration_ledger)` is one of those
  // sub-invocations, and the tree is built during simulation but checked during execution — two
  // different ledgers, always. When the contract derived the expiry from
  // `env.ledger().sequence()` the two values could never agree, and every transfer failed with
  // an authorization error rather than anything that named the real cause.
  //
  // `+ APPROVAL_TTL_LEDGERS` rather than something smaller because it maximises the window: the
  // contract requires the expiry to be at or beyond the executing ledger, so this is what decides
  // how long the signed transaction stays submittable — about five minutes at 5s ledgers.
  const { sequence: latestLedger } = await server.getLatestLedger();

  const request = encodeBridgeRequest({
    user: p.user,
    amount: p.amount,
    destinationDomain: p.destinationDomain,
    mintRecipient: p.mintRecipient,
    maxFee: p.maxFee,
    minFinalityThreshold: p.minFinalityThreshold,
    recipientNeedsAccount: p.recipientNeedsAccount,
    recipientOwner: p.recipientOwner ?? new Uint8Array(32),
    approvalExpirationLedger: latestLedger + APPROVAL_TTL_LEDGERS,
    maxWrapperFee: p.maxWrapperFee,
    deadline,
  });

  const tx = new TransactionBuilder(account, {
    fee: INCLUSION_FEE,
    networkPassphrase: cfg.networkPassphrase,
    timebounds: { minTime: 0, maxTime: Math.floor(now / 1000) + TX_TIMEOUT_SECS },
  })
    .addOperation(contract.call("bridge", request))
    .build();

  const prepared = await server.prepareTransaction(tx);
  const maxTime = Number(prepared.timeBounds?.maxTime ?? 0);
  return {
    id: "burn",
    chain: "stellar",
    description: "Send USDC through Xebra's wrapper on Stellar; Circle burns it and delivers it.",
    tx: { kind: "stellar", xdr: prepared.toXDR(), networkPassphrase: cfg.networkPassphrase },
    expiresAt: maxTime > 0 ? new Date(maxTime * 1000).toISOString() : null,
  };
}
