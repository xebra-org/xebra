import type { ApiErrorCode } from "../api/errors.js";
import {
  type ClaimBuild,
  ClaimBuildSchema,
  type ClaimRequest,
  type Health,
  HealthSchema,
  ProblemSchema,
  type Quote,
  type QuoteRequest,
  QuoteSchema,
  type Routes,
  RoutesSchema,
  type TransferBuild,
  TransferBuildSchema,
  type TransferRequest,
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

export type XebraApiErrorCode =
  | ApiErrorCode
  | "network_error"
  | "timeout"
  | "invalid_response"
  | "wait_timeout";

/** A problem the API answered with: `code` is stable, `detail` is written for a person. */
export class XebraApiError extends XebraError {
  declare readonly code: XebraApiErrorCode;

  constructor(
    readonly status: number,
    code: XebraApiErrorCode,
    readonly detail: string,
    /** The problem's other fields, such as `minimum`, `maximum`, `have` and `need`. */
    readonly extra: Record<string, unknown> = {},
    opts?: { cause?: unknown },
  ) {
    super(code, detail, {
      retryable: RETRYABLE_API_CODES.has(code),
      ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
    });
    this.name = "XebraApiError";
  }
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
}

interface Schema<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false };
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

/**
 * A client for the Xebra API. It prices transfers and builds unsigned transactions; your user's
 * wallet signs them. It never needs or accepts a private key.
 */
export function createXebraClient(opts: XebraClientOptions = {}) {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch;
  const defaultTimeoutMs = opts.timeoutMs ?? 15_000;

  async function call<T>(
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

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new XebraApiError(
        res.status,
        "invalid_response",
        `The API answered ${res.status} without JSON.`,
        {},
        { cause: err },
      );
    }
    if (!res.ok) {
      const p = ProblemSchema.safeParse(body);
      if (!p.success) {
        throw new XebraApiError(res.status, "invalid_response", `The API answered ${res.status}.`);
      }
      const { type: _type, title: _title, status, detail, code, ...extra } = p.data;
      throw new XebraApiError(status, code as ApiErrorCode, detail, extra);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new XebraApiError(
        res.status,
        "invalid_response",
        "The API's answer did not match this SDK's schema.",
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

    /** What a transfer costs and what the recipient gets. Read-only. */
    quote: (q: QuoteRequest, o?: XebraCallOptions): Promise<Quote> =>
      call(
        `/v1/quote?${query({ from: q.from, to: q.to, amount: q.amount, speed: q.speed, recipient: q.recipient })}`,
        QuoteSchema,
        passed(o),
      ),

    /** The unsigned transactions for a transfer, in signing order, and its price. */
    createTransfer: (r: TransferRequest, o?: XebraCallOptions): Promise<TransferBuild> =>
      call("/v1/transfers", TransferBuildSchema, { method: "POST", body: r, ...passed(o) }),

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
      for (;;) {
        try {
          const status = await getTransfer(chain, tx, o.signal);
          lastStatus = status;
          if (SETTLED.has(status.state)) return status;
        } catch (err) {
          const transient =
            err instanceof XebraApiError &&
            (err.code === "upstream_unavailable" ||
              err.code === "rate_limited" ||
              err.code === "network_error" ||
              err.code === "timeout");
          if (!transient) throw err;
        }
        if (Date.now() + interval > deadline) {
          throw new XebraApiError(
            0,
            "wait_timeout",
            "The transfer did not settle in time; it may still. Ask again later.",
            lastStatus ? { lastStatus: lastStatus.state } : {},
          );
        }
        await sleep(interval, o.signal);
      }
    },
  };
}

export type XebraClient = ReturnType<typeof createXebraClient>;

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
