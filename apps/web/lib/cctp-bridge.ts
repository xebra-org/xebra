import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import {
  Account,
  Address,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import type { DomainForwardConfig, FeeParams } from "@xebra/sdk/core";
import { formatError } from "./format-error";

/**
 * Client for `contracts/stellar-cctp-wrapper-v2` — Stellar to Solana and to every EVM chain the
 * wrapper has committed, delivered by Circle's Forwarding Service.
 *
 * # There is no direct mode
 *
 * An earlier version could burn straight through Circle's TokenMessengerMinter when the wrapper was
 * not deployed. That produced a burn with nobody to mint it: the relay that used to do so is gone,
 * and a burn without the forwarding hook is only ever claimed by its owner. Every transfer now goes
 * through the wrapper, which puts the hook on the burn.
 *
 * # The fee breakdown is read from the contract, never recomputed here
 *
 * `quoteBridge` simulates the wrapper's own `quote()` view rather than reimplementing
 * `fee = max(amount * fee_bps / 10_000, min_fee)` in TypeScript. Two reasons:
 *
 * 1. The parameters are on-chain and can change under a 48h timelock. A hardcoded copy in the
 *    frontend would silently disagree with reality after any `commit_params`.
 * 2. The rounding is load-bearing. `net` is floored to a 10-stroop boundary because Stellar
 *    USDC has 7 decimals and CCTP's canonical representation has 6; a JS reimplementation
 *    that got that wrong would quote a number the contract never burns.
 *
 * # `max_fee` is the delivery fee, and comes from Circle's quote
 *
 * With forwarding, `max_fee` is what Circle charges, in full, to mint on the destination (gas plus
 * its service fee). It is taken from Circle's live forward-fee quote (`packages/sdk/src/core/fees/stellar.ts`) and
 * bounded on chain by a per-domain cap and a tenth of the burn, so a buggy front end cannot hand
 * away a user's principal.
 */

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
const INCLUSION_FEE = "1000000";

export interface BridgeQuote {
  /** What the user asked to send, in stroops. */
  amount: bigint;
  /** Everything the user pays besides the principal, in stroops: Circle's delivery fee, or our
   *  percentage-or-floor fee if that is larger. One number, so the page can say what it costs. */
  fee: bigint;
  /** Zero when forwarded: creating a recipient's account is inside the delivery fee. */
  accountFee: bigint;
  /** What is burned. The recipient receives this less Circle's delivery fee. */
  netBurned: bigint;
  /** Sub-10-stroop remainder that never leaves the user's wallet. */
  remainder: bigint;
  /** Circle's delivery fee for this transfer, in stroops. It is inside `fee`, not on top of it. */
  forwardFee: bigint;
  /** The part of `fee` we keep: `fee - forwardFee`. */
  wrapperTake: bigint;
  /** False means the contract would not forward this transfer, so nobody would deliver it. The
   *  page must refuse to send. */
  forwarded: boolean;
  /** Circle will also create the recipient's token account. */
  accountCreated: boolean;
}

export interface BridgeChainConfig {
  /** Horizon base URL, used only for confirmation polling. */
  horizonUrl: string;
  /**
   * Xebra's fee wrapper (v2 on mainnet). Null when a build has none configured, and then nothing
   * can be sent: there is no direct path around the wrapper on the Stellar route (see the header).
   */
  wrapperContractId: string | null;
  cctpTokenMessengerId: string;
  usdcSacAddress: string;
  sorobanRpcUrl: string;
  networkPassphrase: string;
  destinationDomain: number;
}

/**
 * Reads the fee split from the wrapper. Throws with the contract's own error name when the
 * amount is outside the configured bounds, so the user sees the real reason (AmountBelowMin,
 * AmountAboveMax) rather than a generic failure.
 */
export async function quoteBridge(
  config: BridgeChainConfig,
  sourceAddress: string,
  amount: bigint,
  /**
   * Whether the destination has no USDC account yet, from `/api/recipient`. Circle then creates
   * it as part of delivery, which roughly doubles its fee.
   *
   * Must match what `submitBridge` is given, or the quote shown and the amount charged differ.
   */
  recipientNeedsAccount: boolean,
  /** The delivery fee the transfer will sign, in stroops (`chooseMaxFee`). On the forward path it
   *  *is* the price, so the price cannot be quoted without it. */
  maxFee: bigint,
): Promise<BridgeQuote> {
  if (!config.wrapperContractId) throw new Error("The bridge contract is not configured.");

  const server = new rpc.Server(config.sorobanRpcUrl);
  const contract = new Contract(config.wrapperContractId);
  const account = await server.getAccount(sourceAddress);

  const tx = new TransactionBuilder(account, {
    fee: INCLUSION_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      contract.call(
        "quote",
        nativeToScVal(amount, { type: "i128" }),
        nativeToScVal(recipientNeedsAccount, { type: "bool" }),
        nativeToScVal(config.destinationDomain, { type: "u32" }),
        nativeToScVal(maxFee, { type: "i128" }),
      ),
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(humanizeContractError(sim.error, config.wrapperContractId));
  }
  if (!sim.result) throw new Error("The bridge did not return a quote.");

  const raw = scValToNative(sim.result.retval) as {
    amount: bigint;
    fee: bigint;
    account_fee: bigint;
    net_burned: bigint;
    remainder: bigint;
    forward_fee: bigint;
    wrapper_take: bigint;
    forwarded: boolean;
    account_created: boolean;
  };

  return {
    amount: BigInt(raw.amount),
    fee: BigInt(raw.fee),
    accountFee: BigInt(raw.account_fee),
    netBurned: BigInt(raw.net_burned),
    remainder: BigInt(raw.remainder),
    forwardFee: BigInt(raw.forward_fee),
    wrapperTake: BigInt(raw.wrapper_take),
    forwarded: raw.forwarded,
    accountCreated: raw.account_created,
  };
}

/**
 * The wrapper's percentage and floor fee, which decide how small a forwarded transfer can be: Circle's
 * delivery fee may not exceed a tenth of the burn, and the burn is what is left after our share.
 */
export async function getWrapperFeeParams(
  config: BridgeChainConfig,
  sourceAddress: string,
): Promise<FeeParams | null> {
  if (!config.wrapperContractId) return null;
  const server = new rpc.Server(config.sorobanRpcUrl);
  const retval = await simulateWithPassphrase(
    server,
    config.networkPassphrase,
    config.wrapperContractId,
    sourceAddress,
    "get_params",
  );
  const p = scValToNative(retval) as { fee_bps: number | bigint; min_fee: bigint };
  return { feeBps: BigInt(p.fee_bps), minFee: BigInt(p.min_fee) };
}

/**
 * Every destination the wrapper has committed, with its forwarding switches and caps, by CCTP
 * domain. The caps are what `chooseMaxFee` checks a quote against, and `forward: false` is the kill
 * switch, which the page must honour: with no relay, a transfer the contract will not forward is one
 * nobody delivers.
 *
 * One read answers for every destination, and it needs no wallet: `get_domains` is a view, and a
 * simulation does not check its source account, so it runs from a placeholder. That is what lets
 * the form decide which chains to offer before anyone connects.
 */
export async function getWrapperDomains(
  config: Pick<BridgeChainConfig, "wrapperContractId" | "sorobanRpcUrl" | "networkPassphrase">,
): Promise<Map<number, DomainForwardConfig> | null> {
  if (!config.wrapperContractId) return null;
  const server = new rpc.Server(config.sorobanRpcUrl);
  const tx = new TransactionBuilder(new Account(VIEW_SOURCE, "0"), {
    fee: INCLUSION_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(new Contract(config.wrapperContractId).call("get_domains"))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`get_domains failed: ${sim.error}`);
  if (!sim.result) throw new Error("get_domains returned no result");
  const domains = scValToNative(sim.result.retval) as Array<{
    domain: number;
    forward: boolean;
    max_forward_fee: bigint;
    account_creation: boolean;
    max_forward_fee_new_account: bigint;
  }>;
  return new Map(
    domains.map((d) => [
      Number(d.domain),
      {
        forward: d.forward,
        maxForwardFee: BigInt(d.max_forward_fee),
        accountCreation: d.account_creation,
        maxForwardFeeNewAccount: BigInt(d.max_forward_fee_new_account),
      },
    ]),
  );
}

/** The all-zero account: a valid address nobody holds, used only as the source of a view. */
const VIEW_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export async function simulateWithPassphrase(
  server: rpc.Server,
  networkPassphrase: string,
  contractId: string,
  sourceAddress: string,
  method: string,
  // biome-ignore lint/suspicious/noExplicitAny: stellar-sdk's call() takes variadic xdr.ScVal
  ...args: any[]
) {
  const contract = new Contract(contractId);
  const account = await server.getAccount(sourceAddress);
  const tx = new TransactionBuilder(account, { fee: INCLUSION_FEE, networkPassphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method} failed: ${sim.error}`);
  if (!sim.result) throw new Error(`${method} returned no result`);
  return sim.result.retval;
}

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

export interface SubmitBridgeParams {
  config: BridgeChainConfig;
  userAddress: string;
  amount: bigint;
  /** Destination recipient, already decoded to 32 bytes and validated. */
  mintRecipient: Uint8Array;
  maxFee: bigint;
  /** The user's own ceiling on Xebra's fee, from the quote they were shown. */
  maxWrapperFee: bigint;
  /** 2000: Standard, the only finality Stellar has. Fast is not available from Stellar. */
  minFinalityThreshold: number;
  /** Must match the value the quote was taken with, or the price shown and the price charged
   *  differ. */
  recipientNeedsAccount: boolean;
  /** The recipient's wallet, 32 bytes, when `recipientNeedsAccount` (Circle creates the token
   *  account for it, and `mintRecipient` must be that account); otherwise null. */
  recipientOwner: Uint8Array | null;
  /** Seconds from now. The contract rejects anything beyond one hour. */
  ttlSeconds: number;
}

/**
 * Builds, signs and submits `bridge()`. One transaction, one signature: the auth tree the
 * wallet produces covers both the fee transfer and Circle's `deposit_for_burn`, because the
 * user — not the wrapper — is the `caller` passed to Circle.
 *
 * There is no partial state to clean up if this fails. The contract holds no user principal
 * between transactions, so either the whole thing succeeds or the user keeps every stroop.
 */
export async function submitBridge(
  kit: StellarWalletsKit,
  params: SubmitBridgeParams,
): Promise<{ txHash: string }> {
  const { config } = params;
  if (!config.wrapperContractId) {
    // There is no direct path to fall back to: a burn that skips the wrapper skips the forwarding
    // hook, and nobody would deliver it.
    throw new Error("The bridge contract is not configured.");
  }
  const server = new rpc.Server(config.sorobanRpcUrl);
  const contract = new Contract(config.wrapperContractId);
  const account = await server.getAccount(params.userAddress);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + params.ttlSeconds);

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
  const approvalExpirationLedger = latestLedger + APPROVAL_TTL_LEDGERS;

  const request = encodeBridgeRequest({
    user: params.userAddress,
    amount: params.amount,
    destinationDomain: config.destinationDomain,
    mintRecipient: params.mintRecipient,
    maxFee: params.maxFee,
    minFinalityThreshold: params.minFinalityThreshold,
    recipientNeedsAccount: params.recipientNeedsAccount,
    recipientOwner: params.recipientOwner ?? new Uint8Array(32),
    approvalExpirationLedger,
    maxWrapperFee: params.maxWrapperFee,
    deadline,
  });

  const tx = new TransactionBuilder(account, {
    fee: INCLUSION_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(contract.call("bridge", request))
    .setTimeout(120)
    .build();

  // prepareTransaction simulates and attaches the auth entries + resource footprint. If the
  // contract would reject the request, it fails HERE — before the user is asked to sign.
  let prepared: Awaited<ReturnType<typeof server.prepareTransaction>>;
  try {
    prepared = await server.prepareTransaction(tx);
  } catch (err) {
    throw new Error(humanizeContractError(formatError(err), config.wrapperContractId));
  }

  const { signedTxXdr } = await kit.signTransaction(prepared.toXDR(), {
    networkPassphrase: config.networkPassphrase,
  });

  const signedTx = TransactionBuilder.fromXDR(signedTxXdr, config.networkPassphrase);
  return submitSigned(server, signedTx, "bridge transaction");
}

/**
 * The user's USDC balance on Stellar, in stroops.
 *
 * Checked before the button is enabled, because the alternative is what actually happened on
 * mainnet: the app happily prepared a transfer against an empty wallet, and the failure arrived
 * from deep inside the USDC contract as `Error(Contract, #10)` — a number that means something
 * else entirely in our own contract. A balance is one simulation away and answers the question
 * before anyone is asked to sign.
 */
export async function getUsdcBalance(config: BridgeChainConfig, owner: string): Promise<bigint> {
  const server = new rpc.Server(config.sorobanRpcUrl);
  const retval = await simulateWithPassphrase(
    server,
    config.networkPassphrase,
    config.usdcSacAddress,
    owner,
    "balance",
    nativeToScVal(new Address(owner), { type: "address" }),
  );
  return BigInt(scValToNative(retval) as string | bigint);
}

/** Ledgers the allowance stays live for. It only needs to survive the following burn. */
const APPROVAL_TTL_LEDGERS = 60;

/**
 * Submits a signed transaction and interprets the full status set.
 *
 * Soroban RPC's `sendTransaction` returns one of PENDING, DUPLICATE, TRY_AGAIN_LATER or
 * ERROR — and it returns a transaction **hash for all of them**. Checking only for ERROR
 * therefore treats TRY_AGAIN_LATER (the node declined to queue it, usually fee/congestion)
 * as success, and the caller then polls a hash that will never appear in any ledger.
 */
export async function submitSigned(
  server: rpc.Server,
  signedTx: Parameters<rpc.Server["sendTransaction"]>[0],
  what: string,
): Promise<{ txHash: string }> {
  const result = await server.sendTransaction(signedTx);

  switch (result.status) {
    case "PENDING":
      return { txHash: result.hash };
    case "DUPLICATE":
      // Already in the mempool from a previous attempt — the same hash, so polling is valid.
      return { txHash: result.hash };
    case "TRY_AGAIN_LATER":
      throw new Error(
        `The network declined to queue the ${what} right now (TRY_AGAIN_LATER). Nothing has moved. Wait a few seconds and try again.`,
      );
    default:
      throw new Error(describeRejectedTransaction(result, what));
  }
}

/** What each transaction-level failure means to a person, keyed by the XDR result code name.
 *  None of these cost the user USDC — only a network fee at most. */
const TX_RESULT_MESSAGES: Record<string, string> = {
  txTooLate:
    "The signing window expired before the network accepted it, so the transfer did not go through. No USDC has moved. Please try again and approve in your wallet promptly.",
  txTooEarly: "The transfer was submitted too early. No USDC has moved. Please try again.",
  txBadSeq:
    "Your wallet sent another transaction in the meantime. No USDC has moved. Please try again.",
  txInsufficientFee:
    "The network is busy and the fee was too low. No USDC has moved. Please try again.",
  txInsufficientBalance:
    "Your wallet does not have enough XLM to cover the network fee. Add some XLM and try again.",
  txNoAccount: "This Stellar account is not funded yet. Add some XLM and try again.",
  txBadAuth: "Your wallet signature was not accepted. Please try again.",
  txBadAuthExtra: "Your wallet signature was not accepted. Please try again.",
  txFailed: "The transaction failed on the network. No USDC has moved.",
};

/** The `status: ERROR` reply carries an XDR result; read its code name rather than dumping it. */
export function describeRejectedTransaction(result: unknown, what: string): string {
  let code: string | undefined;
  try {
    const errorResult = (result as { errorResult?: { result(): { switch(): { name: string } } } })
      .errorResult;
    code = errorResult?.result().switch().name;
  } catch {
    code = undefined;
  }
  const known = code ? TX_RESULT_MESSAGES[code] : undefined;
  if (known) return known;
  return `The network rejected the ${what}${code ? ` (${code})` : ""}. No USDC has moved. Please try again.`;
}

/**
 * Polls until a submitted transaction is applied, so the next step sees its ledger effects.
 *
 * # Why Horizon rather than the SDK's `getTransaction`
 *
 * `rpc.Server.getTransaction` decodes the transaction's result **XDR**, and the installed
 * @stellar/stellar-sdk (13.x) predates protocol 23's `TransactionMetaV4`. It therefore throws
 * `TypeError: Bad union switch: 4` on any successful mainnet transaction — the switch value
 * is literally the meta version it does not know.
 *
 * That failure is especially misleading: the transaction has *succeeded* and been included in
 * a ledger; only the client's parsing of the receipt blows up. The first real mainnet approve
 * landed (ledger 64329152, fee 9,036 stroops) and still surfaced as a failed transfer.
 *
 * Horizon answers the only question this function asks — did it land, and did it succeed —
 * as plain JSON, with no XDR anywhere in the path. A 404 means "not yet included", which is
 * the normal state while polling.
 *
 * The SDK is four majors behind (13.3.0 vs 17.0.1) and should still be upgraded; this keeps
 * the funds path working without doing that mid-flight.
 */
export async function waitForTx(
  config: BridgeChainConfig,
  txHash: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `${config.horizonUrl.replace(/\/$/, "")}/transactions/${txHash}`;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (res.ok) {
        const body = (await res.json()) as { successful?: boolean; result_xdr?: string };
        if (body.successful === true) return;
        if (body.successful === false) {
          throw new Error(
            `Transaction ${txHash} was included in a ledger but failed. Nothing has moved.`,
          );
        }
      } else if (res.status !== 404) {
        // 404 is the expected "not included yet" answer; anything else is worth surfacing
        // rather than silently retrying until the deadline.
        throw new Error(`Horizon returned ${res.status} while checking ${txHash}.`);
      }
    } catch (err) {
      // A network blip should not abort a transfer that is probably fine; a real on-chain
      // failure is rethrown above and must not be swallowed here.
      if (err instanceof Error && err.message.includes("was included in a ledger but failed")) {
        throw err;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${txHash} to be applied.\n\nCheck the hash on stellar.expert. If it never lands, nothing has moved and it is safe to retry.`,
  );
}

/**
 * Maps the wrapper's `#[contracterror]` variants to something a person can act on. Soroban
 * surfaces these as `Error(Contract, #N)`, which is accurate and completely opaque to a user
 * about to move money.
 */
const CONTRACT_ERRORS: Record<number, string> = {
  2: "The bridge is paused. No funds have moved — please try again later.",
  6: "That request would stay valid for too long. Refresh and try again.",
  5: "This quote expired. Refresh and try again.",
  7: "That destination chain is not supported yet.",
  8: "The destination address cannot be all zeroes.",
  9: "That address is the wrong kind for this destination chain. Check it and try again.",
  10: "The transfer speed was not accepted. Refresh and try again.",
  11: "Enter an amount greater than zero.",
  12: "That amount is below the minimum for this bridge.",
  13: "That amount is above the current per-transfer limit.",
  14: "The amount is too small to cover the fee.",
  15: "After fees there is too little left to send. Try a larger amount.",
  16: "Circle's fee quote was negative, which should not happen. Refresh and try again.",
  17: "Circle's fee would exceed the amount being sent. Try a larger transfer.",
  18: "The network fee quote was too high; refresh and try again.",
  19: "The fee changed since you were quoted. Refresh to see the new amount.",
  30: "Not enough accrued fees to withdraw.",
  36: "This transfer sat too long before being submitted. Refresh and try again.",
  37: "The approval window was set too far ahead. Refresh and try again.",
  39: "Circle's delivery fee was zero, which should not happen. Refresh and try again.",
  40: "Circle's delivery fee is above the limit we allow for this destination right now. Try again shortly.",
  41: "Circle's delivery fee is more than a tenth of this transfer. Try a larger amount.",
  43: "This wallet needs a USDC account opened, but its owner was missing. Refresh and try again.",
  44: "That request named an account owner it should not have. Refresh and try again.",
  45: "The delivery address was the wallet itself, not its USDC account. Refresh and try again.",
};

/**
 * Finds which contract actually threw.
 *
 * A Soroban error trace is a stack: the wrapper reports the failure of the call it made, and the
 * contract it called reports the real cause. The log is printed newest-first, so the *last* error
 * event names the origin. Without this, any `Error(Contract, #N)` anywhere in the trace was read
 * as the wrapper's error #N — so USDC refusing a transfer for insufficient balance was shown to
 * the user as "the bridge rejected this transfer (code 10)", blaming the wrong contract for a
 * problem in their own wallet.
 */
function originatingContract(raw: string): string | null {
  const ids = [...raw.matchAll(/contract:([A-Z0-9]{56})[^\n]*?Error\(Contract/g)].map((m) => m[1]);
  return ids.length > 0 ? (ids[ids.length - 1] as string) : null;
}

/** The one Stellar Asset Contract failure a user can actually cause, and its exact wording. The
 *  SAC does not say "insufficient balance" — it reports the resulting balance being out of range,
 *  which no amount of guessing at the phrase "insufficient" would have matched. */
const SAC_BALANCE_RANGE = /resulting balance is not within the allowed range/i;
const SAC_ALLOWANCE = /not enough allowance|insufficient allowance/i;

/**
 * Turns a raw Soroban error into something the person about to move money can act on.
 *
 * `wrapperContractId` is what makes the code table trustworthy: error numbers are per-contract,
 * so `#10` means `BadFinalityThreshold` only when our wrapper threw it. USDC's `#10` is something
 * else entirely, and Circle's would be a third thing.
 */
export function humanizeContractError(raw: string, wrapperContractId?: string | null): string {
  // Cause-based checks first: they identify the problem regardless of which contract reported it,
  // and they are the failures users hit most.
  if (SAC_BALANCE_RANGE.test(raw)) {
    return "Your USDC balance is too low for this transfer, including the fee.";
  }
  if (SAC_ALLOWANCE.test(raw)) {
    return "The USDC approval was not in place. Refresh and try again.";
  }
  if (/trustline|TrustLine/i.test(raw)) {
    return "This wallet has no USDC trustline on Stellar. Add one, then try again.";
  }

  const origin = originatingContract(raw);
  const match = raw.match(/Error\(Contract,\s*#(\d+)\)/);

  if (match) {
    const code = Number(match[1]);
    // Only read the code table when our contract is the one that threw.
    if (!origin || !wrapperContractId || origin === wrapperContractId) {
      const known = CONTRACT_ERRORS[code];
      if (known) return known;
      return `The bridge rejected this transfer (code ${code}). No funds have moved.`;
    }
    // Somebody else's error. Say so rather than mistranslating it.
    const who = origin === undefined ? "another contract" : `contract ${origin.slice(0, 8)}…`;
    return `The transfer was rejected by ${who} (code ${code}). No funds have moved.`;
  }

  if (/insufficient balance|underflow/i.test(raw)) {
    return "Your USDC balance is too low for this transfer.";
  }
  return raw;
}
