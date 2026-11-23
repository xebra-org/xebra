import type { ApiErrorCode, XebraErrorCode } from "../api/errors.js";
import {
  type ClaimBuild,
  ClaimBuildSchema,
  type ClaimRequest,
  type Health,
  HealthSchema,
  type Problem,
  ProblemSchema,
  type Quote,
  type QuoteRequest,
  QuoteRequestSchema,
  QuoteSchema,
  type Routes,
  RoutesSchema,
  type TransferBuild,
  TransferBuildSchema,
  type TransferRequest,
  TransferRequestSchema,
  type TransferStatus,
  TransferStatusSchema,
} from "../api/schemas.js";
import type { ChainId } from "../core/chains/ids.js";
import { XebraError } from "../errors.js";
import { SDK_VERSION } from "../version.js";

export const DEFAULT_BASE_URL = "https://api.xebra.exchange";

const RETRYABLE_API_CODES = new Set<string>([
  "network_error",
  "timeout",
  "rate_limited",
  "upstream_unavailable",
  "internal_error",
]);

/** The same as `XebraErrorCode`, by the name it had first. */
export type XebraApiErrorCode = XebraErrorCode;

/** A problem the API answered with: `code` is stable, `detail` is written for a person. */
export class XebraApiError extends XebraError {
  declare readonly code: XebraApiErrorCode;
  /**
   * How long the server asked to be left alone, from its `Retry-After` header, in milliseconds
   * from when the answer arrived. Undefined when the answer carried no such header, or one that
   * is neither a number of seconds nor a date.
   */
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly status: number,
    code: XebraApiErrorCode,
    readonly detail: string,
    /** The problem's other fields, such as `minimum`, `maximum`, `have` and `need`. */
    readonly extra: Partial<
      Pick<Problem, "minimum" | "maximum" | "have" | "need" | "total" | "limit" | "needs">
    > &
      Record<string, unknown> = {},
    opts?: { cause?: unknown; retryAfterMs?: number | undefined },
  ) {
    super(code, detail, {
      retryable: RETRYABLE_API_CODES.has(code),
      ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
    });
    this.name = "XebraApiError";
    this.retryAfterMs = opts?.retryAfterMs;
    Object.defineProperty(this, XEBRA_ERROR_BRAND, { value: true });
  }
}

/** Shared by every copy of the SDK in one process, where the class itself is not. */
const XEBRA_ERROR_BRAND = Symbol.for("xebra.error");

/**
 * Whether `e` is an `XebraApiError`, from this copy of the SDK or any other. `instanceof` is not
 * enough where two copies are installed, as in a monorepo or a framework that bundles its server
 * and client builds apart: an error from one copy is not an instance of the other's class.
 */
export function isXebraApiError(e: unknown): e is XebraApiError {
  if (e instanceof XebraApiError) return true;
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { [XEBRA_ERROR_BRAND]?: unknown })[XEBRA_ERROR_BRAND] === true &&
    (e as { name?: unknown }).name === "XebraApiError"
  );
}

export interface XebraClientOptions {
  baseUrl?: string;
  /**
   * Sent as `Authorization: Bearer <apiKey>`. Optional: keys are not issued yet, and the API
   * answers without one.
   */
  apiKey?: string;
  fetch?: typeof fetch;
  /** Per request. Default 15 s. */
  timeoutMs?: number;
  /**
   * Ask again when a GET fails for a reason that asking again can cure. Off unless given.
   *
   * A GET that ends in 429, 503 or `network_error` is sent up to `attempts` more times. Before
   * each, the client waits for `baseMs` doubled per failure, less a random part of up to half so
   * that clients which failed together do not return together, and never for less than the
   * `Retry-After` the server sent. When the server asks for more than a minute the client does
   * not sleep on it: the error is thrown at once, with `retryAfterMs` for the caller to act on.
   *
   * A POST is never sent twice: the first one may have been acted on. `timeoutMs` applies to
   * each request, and a call's `signal` also ends the wait between two of them.
   */
  retry?: { attempts: number; baseMs: number };
}

interface Schema<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false; error?: unknown };
}

/** States after which a transfer will not change without someone acting. */
const SETTLED = new Set<TransferStatus["state"]>(["delivered", "needs_claim", "failed"]);

/**
 * `AbortSignal.any` arrived in Node 20.3, while `engines` allows 20.0. Where it is missing,
 * combine the caller's signal with the timeout by hand so either one still aborts the request.
 */
function combineSignals(caller: AbortSignal, timeout: AbortSignal): AbortSignal {
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return any([caller, timeout]);
  const controller = new AbortController();
  const off: Array<() => void> = [];
  const abort = (source: AbortSignal) => () => {
    for (const detach of off) detach();
    controller.abort(source.reason);
  };
  for (const source of [caller, timeout]) {
    if (source.aborted) {
      abort(source)();
      break;
    }
    const listener = abort(source);
    source.addEventListener("abort", listener, { once: true });
    off.push(() => source.removeEventListener("abort", listener));
  }
  return controller.signal;
}

/** What any one call may be given, as its last argument. */
export interface XebraCallOptions {
  /**
   * Stops the call. It rejects with the signal's reason, not with an `XebraApiError`. The timeout
   * still applies: whichever comes first ends the request.
   */
  signal?: AbortSignal;
  /** How long this call may take, in place of the client's `timeoutMs`. */
  timeoutMs?: number;
}

/** `getTransfer` took a bare signal before it took options; it still takes either. */
function isAbortSignal(value: XebraCallOptions | AbortSignal | undefined): value is AbortSignal {
  return typeof (value as AbortSignal | undefined)?.addEventListener === "function";
}

/** Fields whose problems are about the amount, which the API answers as `invalid_amount`. */
const AMOUNT_FIELDS = new Set(["amount", "maxTotalFee"]);

/**
 * Checks a request against the schema the API checks it with, and throws what the API would have
 * answered (`invalid_amount` or `invalid_request`) with status 0, so bad input costs no round trip.
 * The issues are on `extra.issues`, as `{ path, message }`.
 */
function checkInput(
  schema: {
    safeParse(
      v: unknown,
    ):
      | { success: true }
      | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
  },
  input: unknown,
): void {
  const parsed = schema.safeParse(input);
  if (parsed.success) return;
  const issues = parsed.error.issues.map((i) => ({
    path: i.path.map(String),
    message: i.message,
  }));
  const amount = issues.find((i) => AMOUNT_FIELDS.has(i.path[0] ?? ""));
  if (amount) {
    throw new XebraApiError(0, "invalid_amount", `${amount.path[0]}: ${amount.message}.`, {
      issues,
    });
  }
  const detail = issues
    .slice(0, 5)
    .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
  throw new XebraApiError(0, "invalid_request", `${detail}.`, { issues });
}

/**
 * A client for the Xebra API. It prices transfers and builds unsigned transactions; your user's
 * wallet signs them. It never needs or accepts a private key.
 */
export function createXebraClient(opts: XebraClientOptions = {}) {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch;
  const defaultTimeoutMs = opts.timeoutMs ?? 15_000;
  // Anything that is not a count or a duration means no retries, as leaving the option out does.
  const retries = Math.max(0, Math.trunc(opts.retry?.attempts ?? 0)) || 0;
  const retryBaseMs = Math.max(0, opts.retry?.baseMs ?? 0) || 0;

  /** One call: a request, sent again where the client was asked to and it is safe to. */
  async function call<T>(
    path: string,
    schema: Schema<T>,
    init: { method?: "GET" | "POST"; body?: unknown } & XebraCallOptions = {},
  ): Promise<T> {
    const allowed = (init.method ?? "GET") === "GET" ? retries : 0;
    for (let failed = 0; ; failed++) {
      try {
        return await request(path, schema, init);
      } catch (err) {
        if (failed >= allowed || !worthAskingAgain(err)) throw err;
        const wait = retryWait(retryBaseMs, failed, err.retryAfterMs);
        if (wait > MAX_RETRY_WAIT_MS) throw err;
        await sleep(wait, init.signal);
      }
    }
  }

  async function request<T>(
    path: string,
    schema: Schema<T>,
    init: { method?: "GET" | "POST"; body?: unknown } & XebraCallOptions = {},
  ): Promise<T> {
    // Named as the client's own was, so every message below reports the limit that applied.
    const timeoutMs = init.timeoutMs ?? defaultTimeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? combineSignals(init.signal, timeout) : timeout;
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Accept: "application/json",
          "X-Xebra-Sdk": SDK_VERSION,
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal,
      });
    } catch (err) {
      if (timeout.aborted)
        throw new XebraApiError(
          0,
          "timeout",
          `No answer within ${timeoutMs} ms.`,
          {},
          { cause: err },
        );
      if (init.signal?.aborted) throw err;
      throw new XebraApiError(
        0,
        "network_error",
        err instanceof Error ? err.message : String(err),
        {},
        { cause: err },
      );
    }

    // Read before the body: a gateway's 503 may carry the header and no JSON at all.
    const retryAfterMs = res.ok ? undefined : parseRetryAfter(res.headers.get("Retry-After"));
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      // The headers have arrived but the body has not, so either signal can still end the read.
      // An abort is not an answer: report it as what it is, not as a 200 that was not JSON.
      if (init.signal?.aborted) throw init.signal.reason;
      if (timeout.aborted)
        throw new XebraApiError(
          0,
          "timeout",
          `No answer within ${timeoutMs} ms.`,
          {},
          { cause: err },
        );
      throw new XebraApiError(
        res.status,
        "invalid_response",
        `The API answered ${res.status} without JSON.`,
        {},
        { cause: err, retryAfterMs },
      );
    }
    if (!res.ok) {
      const p = ProblemSchema.safeParse(body);
      if (!p.success) {
        // A code newer than this SDK, or a gateway's own JSON: keep what can be read, and the
        // body itself, rather than only the status. An unknown code is the server's, as it sent it.
        const loose = looseProblem(body);
        throw new XebraApiError(
          res.status,
          (loose.code ?? "invalid_response") as XebraApiErrorCode,
          loose.detail ?? `The API answered ${res.status}.`,
          { body },
          { cause: p.error, retryAfterMs },
        );
      }
      const { type: _type, title: _title, status, detail, code, ...extra } = p.data;
      throw new XebraApiError(status, code as ApiErrorCode, detail, extra, { retryAfterMs });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new XebraApiError(
        res.status,
        "invalid_response",
        "The API's answer did not match this SDK's schema.",
        {},
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  const query = (q: Record<string, string | undefined>) =>
    new URLSearchParams(
      Object.entries(q).filter((e): e is [string, string] => e[1] !== undefined),
    ).toString();

  /** The part of a request that the caller's options decide. Absent options add nothing. */
  const passed = (o?: XebraCallOptions): XebraCallOptions => ({
    ...(o?.signal ? { signal: o.signal } : {}),
    ...(o?.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
  });

  const getTransfer = (
    chain: ChainId,
    tx: string,
    /** Options, or only a signal, which is what this argument used to be. */
    o?: XebraCallOptions | AbortSignal,
  ): Promise<TransferStatus> =>
    call(
      `/v1/transfers/${encodeURIComponent(chain)}/${encodeURIComponent(tx)}`,
      TransferStatusSchema,
      passed(isAbortSignal(o) ? { signal: o } : o),
    );

  return {
    /** Every route Xebra sends on right now. */
    routes: (o?: XebraCallOptions): Promise<Routes> => call("/v1/routes", RoutesSchema, passed(o)),

    /**
     * What a transfer costs and what the recipient gets. Read-only. Input the API would refuse is
     * refused here first, with status 0, without a request.
     */
    quote: async (q: QuoteRequest, o?: XebraCallOptions): Promise<Quote> => {
      checkInput(QuoteRequestSchema, q);
      return call(
        `/v1/quote?${query({ from: q.from, to: q.to, amount: q.amount, speed: q.speed, recipient: q.recipient })}`,
        QuoteSchema,
        passed(o),
      );
    },

    /**
     * The unsigned transactions for a transfer, in signing order, and its price. Input the API
     * would refuse is refused here first, with status 0, without a request.
     */
    createTransfer: async (r: TransferRequest, o?: XebraCallOptions): Promise<TransferBuild> => {
      checkInput(TransferRequestSchema, r);
      return call("/v1/transfers", TransferBuildSchema, { method: "POST", body: r, ...passed(o) });
    },

    /** Where a transfer is, by the burn's transaction hash (or Sui digest). */
    getTransfer,

    /** The unsigned mint for a transfer whose delivery did not complete on its own. */
    createClaim: (r: ClaimRequest, o?: XebraCallOptions): Promise<ClaimBuild> =>
      call("/v1/claims", ClaimBuildSchema, { method: "POST", body: r, ...passed(o) }),

    health: (o?: XebraCallOptions): Promise<Health> => call("/v1/health", HealthSchema, passed(o)),

    /**
     * Polls until the transfer is delivered, needs a claim, or failed. A moment where Circle
     * cannot be read is waited out, not reported. Default: every 5 s for up to 30 min.
     */
    async waitForDelivery(
      chain: ChainId,
      tx: string,
      o: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
    ): Promise<TransferStatus> {
      const interval = o.intervalMs ?? 5_000;
      const deadline = Date.now() + (o.timeoutMs ?? 30 * 60_000);
      let lastStatus: TransferStatus | null = null;
      // What the last poll failed with, if it failed: a wait that ends while the API cannot be
      // reached should say so, not only that the transfer did not settle.
      let lastFailure: unknown;
      for (;;) {
        // How long to leave it before the next poll: the interval, unless the API asked for longer.
        let wait = interval;
        try {
          const status = await getTransfer(chain, tx, o.signal);
          lastStatus = status;
          lastFailure = undefined;
          if (SETTLED.has(status.state)) return status;
        } catch (err) {
          const transient =
            err instanceof XebraApiError &&
            (err.code === "upstream_unavailable" ||
              err.code === "rate_limited" ||
              err.code === "network_error" ||
              err.code === "timeout");
          if (!transient) throw err;
          lastFailure = err;
          if (err.status === 429 || err.status === 503) {
            wait = Math.max(interval, err.retryAfterMs ?? 0);
          }
        }
        if (Date.now() + wait > deadline) {
          throw new XebraApiError(
            0,
            "wait_timeout",
            "The transfer did not settle in time; it may still. Ask again later.",
            lastStatus ? { lastStatus: lastStatus.state } : {},
            { cause: lastFailure },
          );
        }
        await sleep(wait, o.signal);
      }
    },
  };
}

export type XebraClient = ReturnType<typeof createXebraClient>;

/** What the API's codes look like. A gateway's `"code": "FUNCTION_INVOCATION_FAILED"` is not one. */
const CODE_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

/** The `code` and `detail` of an error body that failed `ProblemSchema`, where they are usable. */
function looseProblem(body: unknown): { code?: string; detail?: string } {
  if (typeof body !== "object" || body === null) return {};
  const { code, detail } = body as Record<string, unknown>;
  return {
    ...(typeof code === "string" && CODE_SHAPE.test(code) ? { code } : {}),
    ...(typeof detail === "string" && detail.trim() !== "" ? { detail } : {}),
  };
}

/**
 * `Retry-After` in milliseconds from now. The header is a number of seconds or an HTTP date
 * (RFC 9110, 10.2.3); a date already past is no wait at all. Undefined for a missing header and
 * for anything else, so that a value this cannot read is not mistaken for "ask at once".
 */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // Only what looks like a date: `Date.parse` would read "1.5" or "-3" as some year.
  if (!/[a-z]/i.test(text)) return undefined;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** The failures asking again can cure: the two statuses the API says to wait out, and no answer. */
function worthAskingAgain(err: unknown): err is XebraApiError {
  return (
    err instanceof XebraApiError &&
    (err.status === 429 || err.status === 503 || err.code === "network_error")
  );
}

/** The longest the client sleeps before a retry. A server that asks for more is not obeyed by
 * holding the caller's promise open: the error goes back to the caller, who can see how long. */
const MAX_RETRY_WAIT_MS = 60_000;

/**
 * How long to wait after `failed` earlier failures: `baseMs` doubled for each, then anywhere
 * from half of that up to all of it, and never less than the server asked for.
 */
function retryWait(baseMs: number, failed: number, retryAfterMs: number | undefined): number {
  const ceiling = baseMs * 2 ** failed;
  const jittered = ceiling / 2 + Math.random() * (ceiling / 2);
  return Math.max(Math.round(jittered), retryAfterMs ?? 0);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
