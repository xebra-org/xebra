/**
 * Rebalance a market maker's USDC inside NEAR Intents from one chain's asset ID to another's,
 * over Circle's CCTP.
 *
 * NEAR Intents holds one USDC balance per chain (Base USDC, Avalanche USDC, Solana USDC, ...), each
 * behind its own bridge. A market maker whose Base USDC is full and whose Avalanche USDC is empty
 * cannot fill an Avalanche quote. Swapping one for the other inside Intents needs another market
 * maker on the far side, and large amounts often find none. This moves the money itself:
 *
 *   1. withdraw  The market maker signs a NEAR Intents withdrawal of `from` USDC to its own wallet
 *                on `from` (a 1Click quote with origin = destination asset, paid by signed intent).
 *   2. burn      Its wallet burns that USDC with CCTP; Circle mints native USDC on `to` straight
 *                into a 1Click deposit address.
 *   3. deposit   1Click credits the market maker's own Intents account with `to` USDC.
 *
 * Every step is the market maker's own money, signed by its own keys. Xebra builds the burn and
 * never holds anything. If the deposit address expires before Circle's mint lands, 1Click refunds
 * to `toWallet`, the market maker's own address on `to`.
 *
 * The withdrawal is the one step that needs a 1Click partner API key (`generate-intent` and
 * `submit-intent` are partner endpoints). Market makers onboarded through partners.near-intents.org
 * have one; it is passed in and only ever sent to 1Click.
 */

import type { TransferBuild, Quote as XebraQuote } from "../api/schemas.js";
import type { XebraClient } from "../client/index.js";
import type { ChainId } from "../core/chains/ids.js";
import { XebraError } from "../errors.js";
import { type IntentsToken, createIntentsRouter, toXebraChain, usdcChainOf } from "./index.js";

export const ONECLICK_BASE_URL = "https://1click.chaindefuser.com";

/** Signing standards 1Click's `generate-intent` accepts. */
export type IntentSigningStandard =
  | "nep413"
  | "erc191"
  | "raw_ed25519"
  | "webauthn"
  | "ton_connect"
  | "sep53"
  | "tip191";

export interface OneClickOptions {
  /** Partner API key from partners.near-intents.org. Needed to withdraw; quotes work without. */
  apiKey?: string;
  baseUrl?: string;
  /** Distribution-channel tag shown in NEAR Intents' records. Default "xebra". */
  referral?: string;
}

export interface RebalancerOptions {
  /** A Xebra client (`createXebraClient()`). */
  xebra: Pick<XebraClient, "routes" | "quote" | "createTransfer">;
  oneClick?: OneClickOptions;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface RebalanceRequest {
  /**
   * The market maker's account inside NEAR Intents (the intent `signer_id`), e.g. "mm.near".
   * Also where the deposit is credited and a failed withdrawal is refunded.
   */
  intentsAccount: string;
  /** Chain whose USDC balance is too full, in Xebra's or NEAR Intents' naming ("base", "arb"). */
  from: string;
  /** Chain whose USDC balance needs topping up. */
  to: string;
  /**
   * Decimal USDC to move, e.g. "100000". Refused if it has more decimal places than the token
   * has.
   */
  amount: string;
  /** The market maker's own wallet on `from`: receives the withdrawal, signs the burn. */
  fromWallet: string;
  /** The market maker's own wallet on `to`: where 1Click refunds a deposit that comes too late. */
  toWallet: string;
  /**
   * Refuse to build the burn if Xebra's and Circle's fees together exceed this decimal amount.
   * See [the fee cap](/docs/sdk/intents#step-2-building-the-burn).
   */
  maxTotalFee?: string;
  /**
   * CCTP speed for the burn.
   * @defaultValue "standard"
   */
  speed?: "standard" | "fast";
}

/** Raw 1Click quote fields this module reads. Amounts are in the token's smallest unit. */
export interface OneClickQuote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountOut: string;
  amountOutFormatted: string;
  minAmountOut: string;
  timeEstimate: number;
  deadline?: string;
}

export interface RebalanceEstimate {
  from: ChainId;
  to: ChainId;
  fromAsset: string;
  toAsset: string;
  /** Decimal USDC leaving the `from` balance. */
  amount: string;
  /** Decimal USDC expected on the `to` balance. */
  arrives: string;
  fees: {
    /** NEAR Intents' withdrawal of `from` USDC to the wallet. */
    withdraw: string;
    /** Xebra's and Circle's fees for the CCTP leg. */
    cctp: string;
    total: string;
  };
  /** Rough seconds end to end: withdrawal plus CCTP plus deposit. */
  seconds: number;
  /**
   * The same move as one swap inside NEAR Intents, for comparison: what would arrive, or null with
   * the reason and the OneClickError `code` when there is no quote. `http_error` is 1Click saying
   * no (often no market maker for a large amount); anything else means it could not be asked.
   */
  direct: { arrives: string } | { arrives: null; reason: string; code: OneClickErrorCode };
  /**
   * Which way leaves more USDC on the `to` balance. "unknown" when the direct swap could not be
   * priced (1Click unreachable, timed out, 429 or 5xx): ask again before choosing.
   */
  better: "rebalance" | "direct" | "unknown";
}

export interface Withdrawal {
  /** The 1Click deposit address (an Intents account) the signed intent pays. Track by it. */
  depositAddress: string;
  quote: OneClickQuote;
  /** The unsigned intent. Sign `payload` exactly as returned, then call `submitWithdrawal`. */
  intent: { standard: IntentSigningStandard; payload: unknown; [k: string]: unknown };
  /** Decimal USDC the wallet on `from` is promised at least. Burn this much. */
  receives: string;
}

export interface Deposit {
  /** 1Click deposit address on `to`; Circle mints into it. Track by it. */
  depositAddress: string;
  quote: OneClickQuote;
  xebra: XebraQuote;
  /** Unsigned transactions for `fromWallet` to sign on `from`, in order. */
  build: TransferBuild;
}

export type OneClickStatus =
  | "KNOWN_DEPOSIT_TX"
  | "PENDING_DEPOSIT"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

/** How a 1Click call failed. */
export type OneClickErrorCode =
  | "missing_api_key"
  | "no_deposit_address"
  | "http_error"
  | "network_error"
  | "timeout"
  | "invalid_response";

/**
 * A 1Click call failed. `code` says how. `status` is 1Click's HTTP status for `http_error` and
 * `invalid_response`, else 0. `body` is what 1Click sent (parsed JSON, else the raw text), when it
 * sent anything. `retryable` is true for network errors, timeouts, 429 and 5xx.
 */
export class OneClickError extends XebraError {
  declare readonly code: OneClickErrorCode;
  readonly status: number;
  readonly body?: unknown;

  constructor(
    message: string,
    status: number,
    opts: { code?: OneClickErrorCode; body?: unknown; cause?: unknown } = {},
  ) {
    const code = opts.code ?? "http_error";
    super(code, message, {
      retryable: code === "network_error" || code === "timeout" || status === 429 || status >= 500,
      cause: opts.cause,
    });
    this.name = "OneClickError";
    this.status = status;
    if (opts.body !== undefined) this.body = opts.body;
  }
}

/** Decimal string to integer units at `decimals` places. Rejects more places than the token has. */
export function toUnits(amount: string, decimals: number): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new Error(`Not a decimal amount: ${amount}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals)
    throw new Error(`${amount} has more than ${decimals} decimal places.`);
  const units = BigInt(m[1] + frac.padEnd(decimals, "0"));
  return units.toString();
}

/** Integer units to a decimal string without trailing zeros. */
export function fromUnits(units: string, decimals: number): string {
  if (!/^-?\d+$/.test(units)) {
    throw new XebraError(
      "invalid_amount",
      `units must be an integer string, got ${JSON.stringify(units)}`,
    );
  }
  const v = BigInt(units);
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/** The rebalance step that failed. */
export type RebalanceStage = "resolve" | "withdraw" | "deposit_quote" | "build";

/**
 * A step that runs once the market maker's USDC has left (or may have left) NEAR Intents failed:
 * `submitWithdrawal` (stage "withdraw") or `prepareDeposit` ("resolve", "deposit_quote",
 * "build"). The message says where the USDC is now. `code` is the cause's `XebraError` code, else
 * `<stage>_failed`. `retryable` says whether calling the same step again can help. `cause` is the
 * original error.
 */
export class RebalanceError extends XebraError {
  readonly stage: RebalanceStage;

  constructor(
    stage: RebalanceStage,
    message: string,
    opts: { code: string; retryable: boolean; cause: unknown },
  ) {
    super(opts.code, message, { retryable: opts.retryable, cause: opts.cause });
    this.name = "RebalanceError";
    this.stage = stage;
  }
}

function afterWithdrawal(stage: RebalanceStage, where: string, err: unknown): RebalanceError {
  const said = err instanceof Error ? err.message : String(err);
  const known = err instanceof XebraError;
  return new RebalanceError(stage, `${said} ${where}`, {
    code: known ? err.code : `${stage}_failed`,
    // Asking again after an unsure withdrawal could sign a second one: check status first.
    retryable: stage !== "withdraw" && known && err.retryable,
    cause: err,
  });
}

/** Exact decimal subtraction for the 6/7-place amounts used here. */
function sub(a: string, b: string): string {
  const d = 7;
  return fromUnits((BigInt(toUnits(a, d)) - BigInt(toUnits(b, d))).toString(), d);
}

function cmp(a: string, b: string): number {
  const x = BigInt(toUnits(a, 7));
  const y = BigInt(toUnits(b, 7));
  return x === y ? 0 : x > y ? 1 : -1;
}

/** Trim a decimal to at most `places` places, rounding down. */
function floorTo(amount: string, places: number): string {
  const [i, f = ""] = amount.split(".");
  const t = f.slice(0, places).replace(/0+$/, "");
  return t ? `${i}.${t}` : (i as string);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isUnits = (v: unknown): boolean => typeof v === "string" && /^\d+$/.test(v);

/** Shape checks for the 1Click answers this module reads. A body that fails is `invalid_response`. */
const SHAPES = {
  tokens: (v: unknown) => Array.isArray(v),
  quote: (v: unknown) =>
    isRecord(v) &&
    isRecord(v.quote) &&
    isUnits(v.quote.amountOut) &&
    isUnits(v.quote.minAmountOut) &&
    typeof v.quote.timeEstimate === "number" &&
    (v.quote.depositAddress === undefined || typeof v.quote.depositAddress === "string"),
  intent: (v: unknown) => isRecord(v) && isRecord(v.intent),
  submitted: (v: unknown) => isRecord(v) && typeof v.intentHash === "string",
  status: (v: unknown) => isRecord(v) && typeof v.status === "string",
};

export function createRebalancer(opts: RebalancerOptions) {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const base = (opts.oneClick?.baseUrl ?? ONECLICK_BASE_URL).replace(/\/+$/, "");
  const referral = opts.oneClick?.referral ?? "xebra";
  const apiKey = opts.oneClick?.apiKey;
  const router = createIntentsRouter({ client: opts.xebra });
  let tokenCache: { at: number; list: IntentsToken[] } | null = null;

  function requireKey(): void {
    if (!apiKey) {
      throw new OneClickError(
        "Withdrawing from NEAR Intents needs a 1Click partner API key (oneClick.apiKey).",
        0,
        { code: "missing_api_key" },
      );
    }
  }

  async function call<T>(
    path: string,
    body: unknown,
    needsKey: boolean,
    valid: (json: unknown) => boolean,
  ): Promise<T> {
    if (needsKey) requireKey();
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(apiKey ? { "X-API-Key": apiKey } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      const timedOut = name === "TimeoutError" || name === "AbortError";
      throw new OneClickError(
        timedOut
          ? `1Click did not answer ${path.split("?")[0]} within ${timeoutMs} ms.`
          : `Could not reach 1Click (${path.split("?")[0]}).`,
        0,
        { code: timedOut ? "timeout" : "network_error", cause: err },
      );
    }
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // keep null
    }
    if (!res.ok) {
      const said =
        json && typeof json === "object" && "message" in json && typeof json.message === "string"
          ? json.message
          : `1Click answered ${res.status}`;
      throw new OneClickError(said, res.status, { body: json ?? (text || undefined) });
    }
    if (!valid(json)) {
      throw new OneClickError(
        `1Click answered ${res.status} to ${path.split("?")[0]}, but not with the fields Xebra reads.`,
        res.status,
        { code: "invalid_response", body: json ?? text },
      );
    }
    return json as T;
  }

  async function tokens(): Promise<IntentsToken[]> {
    if (tokenCache && now() - tokenCache.at < 300_000) return tokenCache.list;
    const list = await call<IntentsToken[]>("/v0/tokens", undefined, false, SHAPES.tokens);
    tokenCache = { at: now(), list };
    return list;
  }

  /** The NEAR Intents asset for Circle's USDC on `chain`, matched by contract address. */
  async function usdcAsset(chain: ChainId): Promise<IntentsToken> {
    const t = (await tokens()).find((x) => usdcChainOf(x) === chain);
    if (!t) throw new Error(`NEAR Intents lists no Circle USDC on ${chain}.`);
    return t;
  }

  async function resolve(r: RebalanceRequest) {
    const from = toXebraChain(r.from);
    const to = toXebraChain(r.to);
    if (!from || !to) throw new Error(`Unknown chain: ${!from ? r.from : r.to}`);
    if (from === to) throw new Error("`from` and `to` are the same chain.");
    if (!(await router.isRouteAvailable(from, to))) {
      throw new XebraError(
        "route_unavailable",
        `Xebra does not move USDC from ${from} to ${to} right now.`,
      );
    }
    const [fromToken, toToken] = await Promise.all([usdcAsset(from), usdcAsset(to)]);
    return { from, to, fromToken, toToken };
  }

  function deadline(minutes: number): string {
    return new Date(now() + minutes * 60_000).toISOString();
  }

  function quote(q: Record<string, unknown>): Promise<{ quote: OneClickQuote }> {
    return call("/v0/quote", { slippageTolerance: 10, referral, ...q }, false, SHAPES.quote);
  }

  function withdrawQuote(
    r: RebalanceRequest,
    token: IntentsToken,
    dry: boolean,
  ): Promise<{ quote: OneClickQuote }> {
    return quote({
      dry,
      swapType: "EXACT_INPUT",
      // Same asset in and out: nothing to slip, so the minimum is the amount.
      slippageTolerance: 0,
      originAsset: token.assetId,
      destinationAsset: token.assetId,
      amount: toUnits(r.amount, token.decimals),
      depositType: "INTENTS",
      refundTo: r.intentsAccount,
      refundType: "INTENTS",
      recipient: r.fromWallet,
      recipientType: "DESTINATION_CHAIN",
      deadline: deadline(30),
    });
  }

  function depositQuote(
    r: RebalanceRequest,
    token: IntentsToken,
    amount: string,
    dry: boolean,
    minutes: number,
  ): Promise<{ quote: OneClickQuote }> {
    return quote({
      dry,
      // Accept whatever Circle mints: the CCTP fee is taken before the deposit address sees it.
      swapType: "FLEX_INPUT",
      slippageTolerance: 0,
      originAsset: token.assetId,
      destinationAsset: token.assetId,
      amount: toUnits(floorTo(amount, token.decimals), token.decimals),
      depositType: "ORIGIN_CHAIN",
      refundTo: r.toWallet,
      refundType: "ORIGIN_CHAIN",
      recipient: r.intentsAccount,
      recipientType: "INTENTS",
      deadline: deadline(minutes),
    });
  }

  function xebraQuote(from: ChainId, to: ChainId, amount: string, speed?: "standard" | "fast") {
    return opts.xebra.quote({
      from,
      to,
      amount: floorTo(amount, 6),
      ...(speed ? { speed } : {}),
    } as Parameters<typeof opts.xebra.quote>[0]);
  }

  /**
   * What the rebalance costs and leaves on the `to` balance, next to doing the same move as one
   * swap inside NEAR Intents. Read-only: dry quotes only, no deposit address, nothing to sign.
   */
  async function estimate(r: RebalanceRequest): Promise<RebalanceEstimate> {
    const { from, to, fromToken, toToken } = await resolve(r);
    const { quote: w } = await withdrawQuote(r, fromToken, true);
    const receives = fromUnits(w.minAmountOut, fromToken.decimals);
    const x = await xebraQuote(from, to, receives, r.speed);
    let priced = true;
    const [{ quote: d }, direct] = await Promise.all([
      depositQuote(r, toToken, x.recipientGets, true, 60),
      quote({
        dry: true,
        swapType: "EXACT_INPUT",
        originAsset: fromToken.assetId,
        destinationAsset: toToken.assetId,
        amount: toUnits(r.amount, fromToken.decimals),
        depositType: "INTENTS",
        refundTo: r.intentsAccount,
        refundType: "INTENTS",
        recipient: r.intentsAccount,
        recipientType: "INTENTS",
        deadline: deadline(30),
      }).then(
        // Expected output; its floor (minAmountOut) is lower by the 0.1% slippage allowed.
        ({ quote: q }) => ({ arrives: fromUnits(q.amountOut, toToken.decimals) }),
        (err: unknown) => {
          // Only 1Click's own failures mean "no direct quote"; anything else is a bug: throw it.
          if (!(err instanceof OneClickError)) throw err;
          // A refusal (no market maker) settles the comparison; an outage or a bad answer does not.
          priced = err.code === "http_error" && !err.retryable;
          return { arrives: null, reason: err.message, code: err.code };
        },
      ),
    ]);
    const arrives = fromUnits(d.minAmountOut, toToken.decimals);
    const withdrawFee = sub(r.amount, receives);
    const cctpFee = sub(receives, x.recipientGets);
    const better =
      direct.arrives !== null
        ? cmp(direct.arrives, arrives) > 0
          ? "direct"
          : "rebalance"
        : priced
          ? "rebalance"
          : "unknown";
    return {
      from,
      to,
      fromAsset: fromToken.assetId,
      toAsset: toToken.assetId,
      amount: r.amount,
      arrives,
      fees: { withdraw: withdrawFee, cctp: cctpFee, total: sub(r.amount, arrives) },
      seconds: w.timeEstimate + d.timeEstimate + (r.speed === "fast" ? 30 : 20 * 60),
      direct,
      better,
    };
  }

  /**
   * Step 1. A real withdrawal quote and the unsigned intent that pays it. The market maker signs
   * `intent.payload` with the key registered for `intentsAccount`, then calls `submitWithdrawal`.
   */
  async function startWithdrawal(
    r: RebalanceRequest,
    standard: IntentSigningStandard = "nep413",
  ): Promise<Withdrawal> {
    const { fromToken } = await resolve(r);
    requireKey();
    const { quote: q } = await withdrawQuote(r, fromToken, false);
    if (!q.depositAddress) {
      throw new OneClickError("1Click issued no deposit address.", 0, {
        code: "no_deposit_address",
        body: q,
      });
    }
    const { intent } = await call<{ intent: Withdrawal["intent"] }>(
      "/v0/generate-intent",
      {
        type: "swap_transfer",
        standard,
        signerId: r.intentsAccount,
        depositAddress: q.depositAddress,
      },
      true,
      SHAPES.intent,
    );
    return {
      depositAddress: q.depositAddress,
      quote: q,
      intent,
      receives: fromUnits(q.minAmountOut, fromToken.decimals),
    };
  }

  function submitIntent(
    w: Withdrawal,
    signed: { public_key: string; signature: string },
  ): Promise<{ intentHash: string }> {
    return call(
      "/v0/submit-intent",
      { type: "swap_transfer", signedData: { ...w.intent, ...signed } },
      true,
      SHAPES.submitted,
    );
  }

  /**
   * Step 1, submit. `signed` is what the wallet returned for `w.intent.payload`. Throws
   * RebalanceError (stage "withdraw", never `retryable`): the withdrawal may have been accepted,
   * so check `status(w.depositAddress)` before signing another.
   */
  async function submitWithdrawal(
    w: Withdrawal,
    signed: { public_key: string; signature: string },
  ): Promise<{ intentHash: string }> {
    try {
      return await submitIntent(w, signed);
    } catch (err) {
      throw afterWithdrawal(
        "withdraw",
        `The withdrawal may already be on its way to your wallet: check status("${w.depositAddress}") before signing another.`,
        err,
      );
    }
  }

  /**
   * Step 2. A 1Click deposit address on `to` for the market maker's Intents account, and the
   * unsigned CCTP burn from `fromWallet` into it. Call once the withdrawal has landed; `amount` is
   * what arrived in the wallet (default: the request's amount).
   *
   * `minutes` is how long the deposit address waits for Circle's mint before refunding to
   * `toWallet`. Standard CCTP waits for the source chain to finalize (minutes on most EVM chains),
   * so the default is generous.
   *
   * Safe to call again: it signs and moves nothing. A failure throws RebalanceError, whose message
   * says the withdrawn USDC is still in `fromWallet`; call again with the same `amount`.
   */
  async function prepareDeposit(
    r: RebalanceRequest,
    o: { amount?: string; minutes?: number } = {},
  ): Promise<Deposit> {
    const at: { stage: RebalanceStage } = { stage: "resolve" };
    try {
      return await depositSteps(r, o, at);
    } catch (err) {
      const where = `Nothing was burned: the USDC withdrawn from NEAR Intents is still in ${r.fromWallet} on ${r.from}. prepareDeposit is safe to call again.`;
      throw afterWithdrawal(at.stage, where, err);
    }
  }

  async function depositSteps(
    r: RebalanceRequest,
    o: { amount?: string; minutes?: number },
    at: { stage: RebalanceStage },
  ): Promise<Deposit> {
    const { from, to, toToken } = await resolve(r);
    at.stage = "deposit_quote";
    const amount = o.amount ?? r.amount;
    const x = await xebraQuote(from, to, amount, r.speed);
    if (r.maxTotalFee !== undefined && cmp(x.fees.total, r.maxTotalFee) > 0) {
      throw new XebraError(
        "fees_above_cap",
        `CCTP fees ${x.fees.total} exceed maxTotalFee ${r.maxTotalFee}.`,
        { retryable: true },
      );
    }
    const { quote: q } = await depositQuote(r, toToken, x.recipientGets, false, o.minutes ?? 120);
    if (!q.depositAddress) {
      throw new OneClickError("1Click issued no deposit address.", 0, {
        code: "no_deposit_address",
        body: q,
      });
    }
    at.stage = "build";
    const build = await router.buildDeposit({
      from,
      depositChain: to,
      depositAddress: q.depositAddress,
      sender: r.fromWallet,
      amount: floorTo(amount, 6),
      maxTotalFee: r.maxTotalFee ?? x.fees.total,
    });
    return { depositAddress: q.depositAddress, quote: q, xebra: x, build };
  }

  /** Where a withdrawal or deposit is, by its 1Click deposit address. */
  async function status(depositAddress: string): Promise<OneClickStatus> {
    const s = await call<{ status: OneClickStatus }>(
      `/v0/status?${new URLSearchParams({ depositAddress })}`,
      undefined,
      false,
      SHAPES.status,
    );
    return s.status;
  }

  /** Waits `ms`, or rejects with the signal's reason as soon as it aborts. */
  function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((ok, fail) => {
      if (signal?.aborted) return fail(signal.reason);
      const onAbort = () => {
        clearTimeout(t);
        fail(signal?.reason);
      };
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        ok();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Polls `status` until SUCCESS, REFUNDED or FAILED. Default every 5 s for up to 2 h. Network
   * errors, timeouts, 429 and 5xx from 1Click do not end the wait: it backs off (doubling, up to
   * a minute) and keeps polling until the deadline. An abort through `signal` ends it at once.
   */
  async function waitFor(
    depositAddress: string,
    o: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<OneClickStatus> {
    const interval = o.intervalMs ?? 5_000;
    const end = now() + (o.timeoutMs ?? 2 * 60 * 60_000);
    let wait = interval;
    let lastError: unknown;
    for (;;) {
      o.signal?.throwIfAborted();
      try {
        const s = await status(depositAddress);
        if (s === "SUCCESS" || s === "REFUNDED" || s === "FAILED") return s;
        wait = interval;
        lastError = undefined;
      } catch (err) {
        if (!(err instanceof OneClickError) || !err.retryable) throw err;
        lastError = err;
        wait = Math.max(interval, Math.min(wait * 2, 60_000));
      }
      if (now() + wait > end) {
        throw new Error(
          `${depositAddress} did not settle in time. It may still: check status() before acting again.`,
          { cause: lastError },
        );
      }
      await sleep(wait, o.signal);
    }
  }

  return { estimate, startWithdrawal, submitWithdrawal, prepareDeposit, status, waitFor };
}

export type Rebalancer = ReturnType<typeof createRebalancer>;
