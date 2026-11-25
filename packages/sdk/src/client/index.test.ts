import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  type ApiErrorCode,
  CLIENT_ERROR_CODES,
  type ClientErrorCode,
  ERROR_CODES,
  type XebraErrorCode,
} from "../api/errors.js";
import { XebraError } from "../errors.js";
import {
  XebraApiError,
  type XebraCallOptions,
  type XebraClient,
  createXebraClient,
  isXebraApiError,
} from "./index.js";

const json = (status: number, body: unknown, type = "application/json") =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": type } });

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  json(
    status,
    {
      type: `https://docs.xebra.exchange/errors/${code}`,
      title: code,
      status,
      detail: `a ${code}`,
      code,
      ...extra,
    },
    "application/problem+json",
  );

const STATUS = (state: string) => ({
  state,
  chain: "stellar",
  tx: "a".repeat(64),
  deliveryTx: null,
  reason: null,
  claimUrl: null,
});

describe("createXebraClient", () => {
  it("sends the key, the SDK version and the query, to the base URL", async () => {
    const fetch = vi.fn(async () => json(200, { routes: [], complete: true }));
    const client = createXebraClient({
      baseUrl: "https://example.test/",
      apiKey: "xk_live_x",
      fetch,
    });
    await client.routes();
    await client.quote({ from: "stellar", to: "base", amount: "10" }).catch(() => {});
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.test/v1/routes");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xk_live_x");
    expect((init.headers as Record<string, string>)["X-Xebra-Sdk"]).toBeDefined();
    expect((fetch.mock.calls[1] as unknown as [string])[0]).toBe(
      "https://example.test/v1/quote?from=stellar&to=base&amount=10",
    );
  });

  it("turns a problem into an XebraApiError carrying its code and figures", async () => {
    const client = createXebraClient({
      fetch: async () => problem(422, "amount_above_maximum", { maximum: "100" }),
    });
    const err = await client.quote({ from: "stellar", to: "base", amount: "150" }).catch((e) => e);
    expect(err).toBeInstanceOf(XebraApiError);
    expect(err).toMatchObject({
      status: 422,
      code: "amount_above_maximum",
      extra: { maximum: "100" },
    });
  });

  it("puts a problem's field issues on extra.issues", async () => {
    const issues = [{ path: ["amount"], message: "must be more than zero" }];
    const client = createXebraClient({
      fetch: async () => problem(422, "invalid_amount", { issues }),
    });
    const err = await client.routes().catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: "invalid_amount", extra: { issues } });
  });

  it("refuses an answer that does not match the schema rather than passing it on", async () => {
    const client = createXebraClient({ fetch: async () => json(200, { routes: "nope" }) });
    await expect(client.routes()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("reports an answer that is not JSON", async () => {
    const client = createXebraClient({
      fetch: async () => new Response("<html>", { status: 502 }),
    });
    await expect(client.routes()).rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("keeps a code newer than this SDK, its detail, and the body, rather than invalid_response", async () => {
    const body = {
      type: "https://docs.xebra.exchange/errors/brand_new_code",
      title: "Brand new",
      status: 422,
      detail: "A reason this SDK has never seen.",
      code: "brand_new_code",
      floor: "3",
    };
    const client = createXebraClient({
      fetch: async () => json(422, body, "application/problem+json"),
    });
    const err = await client.quote({ from: "stellar", to: "base", amount: "1" }).catch((e) => e);
    expect(err).toBeInstanceOf(XebraApiError);
    expect(err).toMatchObject({
      status: 422,
      code: "brand_new_code",
      detail: "A reason this SDK has never seen.",
      message: "A reason this SDK has never seen.",
      retryable: false,
      extra: { body },
    });
    expect(err.cause).toMatchObject({ issues: expect.any(Array) });
  });

  it("reports a gateway's own JSON as invalid_response with its status and body", async () => {
    const body = { error: { code: "FUNCTION_INVOCATION_FAILED", message: "Bad gateway" } };
    const client = createXebraClient({ fetch: async () => json(502, body) });
    const err = await client.routes().catch((e) => e);
    expect(err).toMatchObject({
      status: 502,
      code: "invalid_response",
      detail: "The API answered 502.",
      extra: { body },
    });
  });

  it("keeps a gateway's detail, but not a code that is not shaped like the API's", async () => {
    const body = { code: "INTERNAL_SERVER_ERROR", detail: "Upstream died." };
    const client = createXebraClient({ fetch: async () => json(500, body) });
    await expect(client.routes()).rejects.toMatchObject({
      status: 500,
      code: "invalid_response",
      detail: "Upstream died.",
      extra: { body },
    });
  });

  it("reports a JSON error body that is not an object as invalid_response", async () => {
    const client = createXebraClient({ fetch: async () => json(503, "Service Unavailable") });
    await expect(client.routes()).rejects.toMatchObject({
      status: 503,
      code: "invalid_response",
      extra: { body: "Service Unavailable" },
    });
  });

  it("gives up after its timeout", async () => {
    const client = createXebraClient({
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    });
    await expect(client.routes()).rejects.toMatchObject({ code: "timeout" });
  });

  it("still aborts through the caller's signal where AbortSignal.any is missing", async () => {
    const any = Object.getOwnPropertyDescriptor(AbortSignal, "any");
    // Node 20.0-20.2 has no AbortSignal.any, and engines allows 20.
    Reflect.deleteProperty(AbortSignal, "any");
    try {
      const client = createXebraClient({
        fetch: (_url, init) =>
          new Promise((_, reject) =>
            init?.signal?.addEventListener("abort", () =>
              reject((init.signal as AbortSignal).reason),
            ),
          ),
      });
      const caller = new AbortController();
      const pending = client.getTransfer("stellar", "a".repeat(64), caller.signal);
      caller.abort(new Error("stopped by the caller"));
      await expect(pending).rejects.toThrow("stopped by the caller");
    } finally {
      if (any) Object.defineProperty(AbortSignal, "any", any);
    }
  });
});

describe("options on a single call", () => {
  const TX = "a".repeat(64);
  const QUOTE = { from: "stellar", to: "base", amount: "10" } as const;
  const TRANSFER = { ...QUOTE, sender: "GSENDER", recipient: "0xrecipient" };

  /** A fetch that never answers, and fails with the signal's reason once the request is aborted. */
  const hanging = () =>
    vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) return reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

  /** A fetch that answers after `ms`, unless the request is aborted first. */
  const answering = (ms: number, body: unknown) =>
    vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(json(200, body)), ms);
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
    );

  it("stops a quote when the caller aborts, and rejects with the caller's own reason", async () => {
    const fetch = hanging();
    const client = createXebraClient({ fetch });
    const caller = new AbortController();
    const reason = new Error("the component unmounted");
    const pending = client.quote(QUOTE, { signal: caller.signal });
    caller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    // The request itself was told to stop: aborting is more than no longer listening for it.
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("takes a signal on every method", async () => {
    const methods: Array<[string, (c: XebraClient, o: XebraCallOptions) => Promise<unknown>]> = [
      ["routes", (c, o) => c.routes(o)],
      ["quote", (c, o) => c.quote(QUOTE, o)],
      ["createTransfer", (c, o) => c.createTransfer(TRANSFER, o)],
      ["getTransfer", (c, o) => c.getTransfer("stellar", TX, o)],
      ["getTransfer with only a signal", (c, o) => c.getTransfer("stellar", TX, o.signal)],
      ["createClaim", (c, o) => c.createClaim({ chain: "stellar", tx: TX, payer: "0xpayer" }, o)],
      ["health", (c, o) => c.health(o)],
    ];
    for (const [name, run] of methods) {
      const client = createXebraClient({ fetch: hanging() });
      const caller = new AbortController();
      const reason = new Error(`stopped ${name}`);
      const pending = run(client, { signal: caller.signal });
      caller.abort(reason);
      await expect(pending, name).rejects.toBe(reason);
    }
  });

  it("gives one call its own timeout, shorter than the client's", async () => {
    const client = createXebraClient({ timeoutMs: 10_000, fetch: hanging() });
    const err = await client.quote(QUOTE, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XebraApiError);
    // The message names the limit that applied to this call, not the client's ten seconds.
    expect(err).toMatchObject({ code: "timeout", detail: "No answer within 20 ms." });
  });

  it("gives one call its own timeout, longer than the client's, and only that call", async () => {
    const health = { status: "ok", version: "1" };
    const client = createXebraClient({ timeoutMs: 20, fetch: answering(80, health) });
    await expect(client.health()).rejects.toMatchObject({ code: "timeout" });
    await expect(client.health({ timeoutMs: 2_000 })).resolves.toEqual(health);
    // The next call is back on the client's 20 ms.
    await expect(client.health()).rejects.toMatchObject({
      code: "timeout",
      detail: "No answer within 20 ms.",
    });
  });

  it("times out a call whose signal nobody aborts: whichever comes first ends it", async () => {
    const client = createXebraClient({ fetch: hanging() });
    const caller = new AbortController();
    await expect(client.routes({ signal: caller.signal, timeoutMs: 20 })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(caller.signal.aborted).toBe(false);
  });

  it("keeps the options out of what is sent", async () => {
    const fetch = hanging();
    const client = createXebraClient({ fetch });
    const caller = new AbortController();
    const pending = client.createTransfer(TRANSFER, { signal: caller.signal, timeoutMs: 5_000 });
    caller.abort();
    await pending.catch(() => {});
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.xebra.exchange/v1/transfers");
    expect(JSON.parse(String(init?.body))).toEqual(TRANSFER);
  });
});

describe("input the API would refuse", () => {
  const QUOTE = { from: "stellar", to: "base", amount: "10" } as const;
  const TRANSFER = { ...QUOTE, sender: "GSENDER", recipient: "0xrecipient" };
  const neverCalled = () => vi.fn(async () => json(200, {}));

  it("refuses an amount with seven places as invalid_amount, without a request", async () => {
    const fetch = neverCalled();
    const client = createXebraClient({ fetch });
    const err = await client.quote({ ...QUOTE, amount: "12.1234567" }).catch((e) => e);
    expect(err).toBeInstanceOf(XebraApiError);
    expect(err).toMatchObject({
      status: 0,
      code: "invalid_amount",
      retryable: false,
      extra: {
        issues: expect.arrayContaining([{ path: ["amount"], message: expect.any(String) }]),
      },
    });
    expect(err.detail).toMatch(/^amount: /);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a zero amount and an unknown chain on a quote", async () => {
    const fetch = neverCalled();
    const client = createXebraClient({ fetch });
    await expect(client.quote({ ...QUOTE, amount: "0" })).rejects.toMatchObject({
      status: 0,
      code: "invalid_amount",
    });
    const unknownChain = { ...QUOTE, to: "mars" } as unknown as Parameters<XebraClient["quote"]>[0];
    const err = await client.quote(unknownChain).catch((e) => e);
    expect(err).toMatchObject({
      status: 0,
      code: "invalid_request",
      extra: { issues: [{ path: ["to"] }] },
    });
    expect(err.detail).toMatch(/^to: /);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a transfer with a missing sender, an extra field or a bad maxTotalFee", async () => {
    const fetch = neverCalled();
    const client = createXebraClient({ fetch });
    type Transfer = Parameters<XebraClient["createTransfer"]>[0];
    const { sender: _sender, ...noSender } = TRANSFER;
    await expect(client.createTransfer(noSender as Transfer)).rejects.toMatchObject({
      status: 0,
      code: "invalid_request",
      extra: { issues: [{ path: ["sender"] }] },
    });
    await expect(
      client.createTransfer({ ...TRANSFER, memo: "x" } as unknown as Transfer),
    ).rejects.toMatchObject({ status: 0, code: "invalid_request" });
    await expect(client.createTransfer({ ...TRANSFER, maxTotalFee: "-1" })).rejects.toMatchObject({
      status: 0,
      code: "invalid_amount",
      extra: { issues: [{ path: ["maxTotalFee"] }] },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still sends what passes", async () => {
    const fetch = vi.fn(async () => problem(422, "route_unavailable"));
    const client = createXebraClient({ fetch });
    await expect(client.quote({ ...QUOTE, speed: "fast" })).rejects.toMatchObject({
      code: "route_unavailable",
    });
    await expect(client.createTransfer({ ...TRANSFER, maxTotalFee: "0.5" })).rejects.toMatchObject({
      code: "route_unavailable",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("waitForDelivery", () => {
  it("polls until a settled state, waiting out a 503", async () => {
    const answers = [
      problem(503, "upstream_unavailable"),
      json(200, STATUS("pending")),
      json(200, STATUS("delivered")),
    ];
    const client = createXebraClient({
      fetch: async () => answers.shift() ?? json(200, STATUS("delivered")),
    });
    const s = await client.waitForDelivery("stellar", "a".repeat(64), { intervalMs: 1 });
    expect(s.state).toBe("delivered");
    expect(answers).toHaveLength(0);
  });

  for (const state of ["needs_claim", "failed"]) {
    it(`stops at ${state}`, async () => {
      const client = createXebraClient({ fetch: async () => json(200, STATUS(state)) });
      expect(
        (await client.waitForDelivery("stellar", "a".repeat(64), { intervalMs: 1 })).state,
      ).toBe(state);
    });
  }

  it("does not retry a problem with the request itself", async () => {
    const fetch = vi.fn(async () => problem(400, "invalid_request"));
    const client = createXebraClient({ fetch });
    await expect(client.waitForDelivery("stellar", "bad", { intervalMs: 1 })).rejects.toMatchObject(
      {
        code: "invalid_request",
      },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("works when taken off the client", async () => {
    const { waitForDelivery } = createXebraClient({
      fetch: async () => json(200, STATUS("delivered")),
    });
    expect((await waitForDelivery("stellar", "a".repeat(64), { intervalMs: 1 })).state).toBe(
      "delivered",
    );
  });

  it("gives up at its deadline", async () => {
    const client = createXebraClient({ fetch: async () => json(200, STATUS("pending")) });
    await expect(
      client.waitForDelivery("stellar", "a".repeat(64), { intervalMs: 5, timeoutMs: 20 }),
    ).rejects.toMatchObject({
      code: "wait_timeout",
      extra: { lastStatus: "pending" },
    });
  });
});

describe("XebraError and retryability", () => {
  it("wraps network failures as retryable XebraError and XebraApiError preserving cause", async () => {
    const fetchErr = new TypeError("fetch failed");
    const client = createXebraClient({
      fetch: async () => {
        throw fetchErr;
      },
    });
    const err = await client.routes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XebraError);
    expect(err).toBeInstanceOf(XebraApiError);
    expect(err).toMatchObject({
      name: "XebraApiError",
      code: "network_error",
      retryable: true,
      cause: fetchErr,
    });
  });

  it("marks transient API codes retryable and non-transient codes non-retryable", async () => {
    for (const [status, code] of [
      [429, "rate_limited"],
      [503, "upstream_unavailable"],
      [500, "internal_error"],
    ] as const) {
      const client = createXebraClient({ fetch: async () => problem(status, code) });
      const err = await client.routes().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(XebraError);
      expect(err).toBeInstanceOf(XebraApiError);
      expect((err as XebraApiError).retryable, code).toBe(true);
    }

    const client422 = createXebraClient({
      fetch: async () => problem(422, "amount_above_maximum", { maximum: "100" }),
    });
    const rejected = await client422
      .quote({ from: "stellar", to: "base", amount: "150" })
      .catch((e: unknown) => e);
    expect((rejected as XebraApiError).retryable).toBe(false);

    const baseErr = new XebraError("bad_input", "invalid value");
    expect(baseErr.name).toBe("XebraError");
    expect(baseErr.code).toBe("bad_input");
    expect(baseErr.retryable).toBe(false);
  });
});

/** What a call rejected with. Fails, rather than passing by accident, when the call succeeds. */
async function failure(call: Promise<unknown>): Promise<XebraApiError> {
  try {
    await call;
  } catch (err) {
    return err as XebraApiError;
  }
  throw new Error("expected the call to reject, and it did not");
}

describe("isXebraApiError", () => {
  const brand = Symbol.for("xebra.error");

  it("is true for this copy's errors", async () => {
    const client = createXebraClient({ fetch: async () => problem(503, "upstream_unavailable") });
    const err = await client.routes().catch((e) => e);
    expect(isXebraApiError(err)).toBe(true);
    expect(isXebraApiError(new XebraApiError(0, "timeout", "No answer."))).toBe(true);
  });

  it("is true for an error from another copy of the SDK, which carries the brand and the name", () => {
    // What another install's XebraApiError looks like from here: not an instance of this class.
    const other = Object.assign(new Error("a reason"), {
      name: "XebraApiError",
      status: 422,
      code: "amount_below_minimum",
      detail: "a reason",
      extra: { minimum: "2" },
      [brand]: true,
    });
    expect(other).not.toBeInstanceOf(XebraApiError);
    expect(isXebraApiError(other)).toBe(true);
    expect(isXebraApiError({ name: "XebraApiError", [brand]: true })).toBe(true);
  });

  it("is false without the brand, without the name, or for anything else", () => {
    expect(isXebraApiError({ name: "XebraApiError", code: "timeout" })).toBe(false);
    expect(isXebraApiError({ name: "Error", [brand]: true })).toBe(false);
    expect(isXebraApiError({ name: "XebraApiError", [brand]: "yes" })).toBe(false);
    expect(isXebraApiError(new XebraError("invalid_amount", "Not an amount."))).toBe(false);
    expect(isXebraApiError(new Error("plain"))).toBe(false);
    for (const value of [null, undefined, "XebraApiError", 0]) {
      expect(isXebraApiError(value)).toBe(false);
    }
  });

  it("keeps the brand out of what an error shows", () => {
    const err = new XebraApiError(422, "invalid_amount", "Bad amount.");
    expect(Object.keys(err)).not.toContain(brand);
    expect(Object.getOwnPropertyDescriptor(err, brand)).toMatchObject({
      value: true,
      enumerable: false,
    });
  });
});

describe("a body that stops arriving", () => {
  const TX = "a".repeat(64);
  /** A 200 whose headers arrive and whose body then stalls, until the request is aborted. */
  const stalled = (signal: AbortSignal | null | undefined) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"routes":['));
          signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  const soon = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("is a timeout when the client's clock runs out, not a 200 that was not JSON", async () => {
    const client = createXebraClient({
      timeoutMs: 20,
      fetch: async (_url, init) => stalled(init?.signal),
    });
    const err = await failure(client.routes());
    expect(err).toBeInstanceOf(XebraApiError);
    expect(err).toMatchObject({
      code: "timeout",
      status: 0,
      retryable: true,
      detail: "No answer within 20 ms.",
    });
    // What the read itself failed with is kept, for whoever reads the stack.
    expect(err.cause).toMatchObject({ name: "TimeoutError" });
  });

  it("rejects with the caller's own reason when the caller aborts", async () => {
    const client = createXebraClient({ fetch: async (_url, init) => stalled(init?.signal) });
    const caller = new AbortController();
    const reason = new Error("the user left the page");
    const pending = client.getTransfer("stellar", TX, caller.signal);
    // Let the headers arrive first, so the abort lands while the body is being read.
    await soon(5);
    caller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("is the caller's abort, not the timeout, when both have happened", async () => {
    // A body that fails only when told to, so both signals can fire before the read ends.
    let fail: (why: unknown) => void = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        fail = (why) => controller.error(why);
      },
    });
    const client = createXebraClient({
      timeoutMs: 10,
      fetch: async () => new Response(body, { status: 200 }),
    });
    const caller = new AbortController();
    const reason = new Error("the user left the page");
    const pending = client.getTransfer("stellar", TX, caller.signal);
    await soon(40);
    caller.abort(reason);
    fail(new Error("socket closed"));
    await expect(pending).rejects.toBe(reason);
  });
});

describe("error codes and extra fields, as types", () => {
  it("names the client's own codes, apart from the API's", () => {
    expect([...CLIENT_ERROR_CODES]).toEqual([
      "network_error",
      "timeout",
      "invalid_response",
      "wait_timeout",
    ]);
    for (const code of CLIENT_ERROR_CODES) expect(ERROR_CODES).not.toContain(code);
    expectTypeOf<ClientErrorCode>().toEqualTypeOf<
      "network_error" | "timeout" | "invalid_response" | "wait_timeout"
    >();
    expectTypeOf<XebraErrorCode>().toEqualTypeOf<ApiErrorCode | ClientErrorCode>();
    expectTypeOf<XebraApiError["code"]>().toEqualTypeOf<XebraErrorCode>();
  });

  it("types the problem's figures on extra, and leaves the rest unknown", () => {
    type Extra = XebraApiError["extra"];
    for (const key of ["minimum", "maximum", "have", "need", "total", "limit", "needs"] as const) {
      expectTypeOf<Extra[typeof key]>().toEqualTypeOf<string | undefined>();
    }
    expectTypeOf<Extra["minimum"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Extra["lastStatus"]>().toBeUnknown();
    const err = new XebraApiError(422, "amount_below_minimum", "Too little.", { minimum: "2.4" });
    const minimum: string | undefined = err.extra.minimum;
    expect(minimum).toBe("2.4");
  });
});

describe("the error behind an error", () => {
  it("keeps what could not be read as the cause of an invalid_response", async () => {
    const answering = (res: () => Response) =>
      failure(createXebraClient({ fetch: async () => res() }).routes());

    const notJson = await answering(() => new Response("<html>", { status: 502 }));
    expect(notJson).toMatchObject({ code: "invalid_response", status: 502 });
    expect(notJson.cause).toBeInstanceOf(SyntaxError);

    // A 200 of the wrong shape, and a 500 that is not a problem: both carry what did not match.
    for (const res of [() => json(200, { routes: "nope" }), () => json(500, { oops: true })]) {
      const err = await answering(res);
      expect(err).toMatchObject({ code: "invalid_response" });
      expect(err.cause).toMatchObject({ issues: expect.any(Array) });
    }
  });

  it("says what the last poll failed with when a wait runs out with the API unreachable", async () => {
    const down = new TypeError("fetch failed");
    const client = createXebraClient({
      fetch: async () => {
        throw down;
      },
    });
    const err = await failure(
      client.waitForDelivery("stellar", "a".repeat(64), { intervalMs: 5, timeoutMs: 20 }),
    );
    expect(err).toMatchObject({ code: "wait_timeout", extra: {} });
    expect(err.cause).toMatchObject({ code: "network_error", cause: down });
  });

  it("gives a wait that ran out no cause when the last poll was answered", async () => {
    // A 503 first: a failure that a later answer supersedes must not be reported as the cause.
    const answers = [problem(503, "upstream_unavailable")];
    const client = createXebraClient({
      fetch: async () => answers.shift() ?? json(200, STATUS("pending")),
    });
    const err = await failure(
      client.waitForDelivery("stellar", "a".repeat(64), { intervalMs: 5, timeoutMs: 30 }),
    );
    expect(err).toMatchObject({ code: "wait_timeout", extra: { lastStatus: "pending" } });
    expect(err.cause).toBeUndefined();
  });
});

/** A problem answer with headers, as the API sends its 503s. */
const problemWith = (status: number, code: string, headers: Record<string, string>) =>
  new Response(
    JSON.stringify({
      type: `https://docs.xebra.exchange/errors/${code}`,
      title: code,
      status,
      detail: `a ${code}`,
      code,
    }),
    { status, headers: { "Content-Type": "application/problem+json", ...headers } },
  );

describe("Retry-After", () => {
  const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const failWith = async (answer: Response): Promise<XebraApiError> => {
    const client = createXebraClient({ fetch: async () => answer });
    return (await client.routes().catch((e: unknown) => e)) as XebraApiError;
  };

  it("is read as seconds into retryAfterMs, on a 503 and on a 429", async () => {
    const unavailable = await failWith(
      problemWith(503, "upstream_unavailable", { "Retry-After": "3" }),
    );
    expect(unavailable).toBeInstanceOf(XebraApiError);
    expect(unavailable).toMatchObject({ status: 503, code: "upstream_unavailable" });
    expect(unavailable.retryAfterMs).toBe(3000);

    const limited = await failWith(problemWith(429, "rate_limited", { "Retry-After": " 10 " }));
    expect(limited.retryAfterMs).toBe(10_000);
    expect(
      (await failWith(problemWith(503, "upstream_unavailable", { "Retry-After": "0" })))
        .retryAfterMs,
    ).toBe(0);
  });

  it("is read as an HTTP date, counted from now", async () => {
    const at = (offsetMs: number) => new Date(NOW + offsetMs).toUTCString();
    const later = await failWith(
      problemWith(503, "upstream_unavailable", { "Retry-After": at(7000) }),
    );
    expect(later.retryAfterMs).toBe(7000);
    // A date that has passed is no wait, not a negative one.
    const past = await failWith(
      problemWith(503, "upstream_unavailable", { "Retry-After": at(-60_000) }),
    );
    expect(past.retryAfterMs).toBe(0);
  });

  it("is undefined when the header is missing or is neither seconds nor a date", async () => {
    expect((await failWith(problem(503, "upstream_unavailable"))).retryAfterMs).toBeUndefined();
    for (const value of ["soon", "1.5", "-3", "3 seconds", "0x10", ""]) {
      const err = await failWith(
        problemWith(503, "upstream_unavailable", { "Retry-After": value }),
      );
      expect(err.retryAfterMs, JSON.stringify(value)).toBeUndefined();
    }
  });

  it("is kept from an answer that is not a problem, or not JSON at all", async () => {
    // A gateway's own JSON, which is not a problem document.
    const gateway = await failWith(
      new Response(JSON.stringify({ message: "busy" }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "4" },
      }),
    );
    expect(gateway).toMatchObject({ status: 503, code: "invalid_response" });
    expect(gateway.retryAfterMs).toBe(4000);

    const html = await failWith(
      new Response("<html>busy</html>", {
        status: 503,
        headers: { "Content-Type": "text/html", "Retry-After": "5" },
      }),
    );
    expect(html).toMatchObject({ status: 503, code: "invalid_response" });
    expect(html.retryAfterMs).toBe(5000);
  });

  it("is not read from an answer that succeeded", async () => {
    const client = createXebraClient({
      fetch: async () =>
        new Response(JSON.stringify({ routes: [], complete: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Retry-After": "9" },
        }),
    });
    await expect(client.routes()).resolves.toEqual({ routes: [], complete: true });
  });

  it("is undefined on the client's own errors", async () => {
    const client = createXebraClient({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const err = (await client.routes().catch((e: unknown) => e)) as XebraApiError;
    expect(err.code).toBe("network_error");
    expect(err.retryAfterMs).toBeUndefined();
    expect(new XebraApiError(0, "timeout", "x").retryAfterMs).toBeUndefined();
  });
});

describe("opt-in retries", () => {
  const ROUTES = { routes: [], complete: true };
  const TRANSFER = {
    from: "stellar",
    to: "base",
    amount: "10",
    sender: "GSENDER",
    recipient: "0xrecipient",
  } as const;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Answers in order, then keeps giving the last one. */
  const answering = (...answers: Array<() => Response | Promise<Response>>) => {
    let i = 0;
    return vi.fn(async () => {
      const next = answers[Math.min(i, answers.length - 1)] as () => Response | Promise<Response>;
      i++;
      return next();
    });
  };
  const unavailable = (retryAfter?: string) => () =>
    problemWith(
      503,
      "upstream_unavailable",
      retryAfter === undefined ? {} : { "Retry-After": retryAfter },
    );
  const ok = () => json(200, ROUTES);

  it("are off unless asked for: a 503 is reported after one request", async () => {
    const fetch = answering(unavailable("3"), ok);
    const client = createXebraClient({ fetch });
    await expect(client.routes()).rejects.toMatchObject({ status: 503, retryAfterMs: 3000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("wait out a 503 for at least its Retry-After, then answer", async () => {
    const fetch = answering(unavailable("3"), ok);
    const client = createXebraClient({ fetch, retry: { attempts: 2, baseMs: 100 } });
    const result = client.routes();
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual(ROUTES);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("back off from baseMs, doubling, when the server names no wait", async () => {
    // The jitter takes up to half away: with the random part at its lowest the waits are 50, 100, 200.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = answering(unavailable(), unavailable(), unavailable(), ok);
    const client = createXebraClient({ fetch, retry: { attempts: 3, baseMs: 100 } });
    const result = client.routes();
    const calls: number[] = [];
    for (const step of [49, 1, 99, 1, 199, 1]) {
      await vi.advanceTimersByTimeAsync(step);
      calls.push(fetch.mock.calls.length);
    }
    expect(calls).toEqual([1, 2, 2, 3, 3, 4]);
    await expect(result).resolves.toEqual(ROUTES);
  });

  it("wait the whole doubled baseMs when the random part is at its highest", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const fetch = answering(unavailable(), unavailable(), ok);
    const client = createXebraClient({ fetch, retry: { attempts: 2, baseMs: 100 } });
    const result = client.routes();
    const calls: number[] = [];
    for (const step of [99, 1, 199, 1]) {
      await vi.advanceTimersByTimeAsync(step);
      calls.push(fetch.mock.calls.length);
    }
    expect(calls).toEqual([1, 2, 2, 3]);
    await expect(result).resolves.toEqual(ROUTES);
  });

  it("take the longer of the backoff and Retry-After", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    // The backoff (5 s) is longer than what the server asked for (1 s).
    const fetch = answering(unavailable("1"), ok);
    const client = createXebraClient({ fetch, retry: { attempts: 1, baseMs: 5000 } });
    const result = client.routes();
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual(ROUTES);
  });

  it("stop after `attempts` more requests and report the last failure", async () => {
    const fetch = answering(unavailable("1"));
    const client = createXebraClient({ fetch, retry: { attempts: 2, baseMs: 10 } });
    const result = client.routes().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({
      status: 503,
      code: "upstream_unavailable",
      retryAfterMs: 1000,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("ask again after a 429 and after a network error", async () => {
    const limited = answering(() => problemWith(429, "rate_limited", { "Retry-After": "1" }), ok);
    const a = createXebraClient({ fetch: limited, retry: { attempts: 1, baseMs: 10 } }).routes();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(a).resolves.toEqual(ROUTES);
    expect(limited).toHaveBeenCalledTimes(2);

    const down = answering(() => {
      throw new TypeError("fetch failed");
    }, ok);
    const b = createXebraClient({ fetch: down, retry: { attempts: 1, baseMs: 10 } }).routes();
    await vi.advanceTimersByTimeAsync(10);
    await expect(b).resolves.toEqual(ROUTES);
    expect(down).toHaveBeenCalledTimes(2);
  });

  it("never send a POST twice", async () => {
    const fetch = answering(unavailable("1"), () => json(200, {}));
    const client = createXebraClient({ fetch, retry: { attempts: 3, baseMs: 10 } });
    const transfer = client.createTransfer(TRANSFER).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await transfer).toMatchObject({ status: 503, retryAfterMs: 1000 });
    expect(fetch).toHaveBeenCalledTimes(1);

    const claimFetch = answering(() => {
      throw new TypeError("fetch failed");
    });
    const claims = createXebraClient({ fetch: claimFetch, retry: { attempts: 3, baseMs: 10 } });
    const claim = claims
      .createClaim({ chain: "stellar", tx: "a".repeat(64) } as Parameters<
        XebraClient["createClaim"]
      >[0])
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await claim).toMatchObject({ code: "network_error" });
    expect(claimFetch).toHaveBeenCalledTimes(1);
  });

  it("do not repeat what asking again cannot cure", async () => {
    for (const [status, code] of [
      [400, "invalid_request"],
      [422, "route_unavailable"],
      [500, "internal_error"],
    ] as const) {
      const fetch = answering(() => problem(status, code));
      const client = createXebraClient({ fetch, retry: { attempts: 3, baseMs: 10 } });
      const result = client.routes().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await result, code).toMatchObject({ status, code });
      expect(fetch, code).toHaveBeenCalledTimes(1);
    }
  });

  it("do not repeat a request that timed out", async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const client = createXebraClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
      timeoutMs: 50,
      retry: { attempts: 3, baseMs: 10 },
    });
    const result = client.routes().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ code: "timeout" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("give the error back at once when the server asks for more than a minute", async () => {
    const fetch = answering(unavailable("61"), ok);
    const client = createXebraClient({ fetch, retry: { attempts: 3, baseMs: 10 } });
    await expect(client.routes()).rejects.toMatchObject({ status: 503, retryAfterMs: 61_000 });
    expect(fetch).toHaveBeenCalledTimes(1);

    // Exactly a minute is still waited out.
    const atLimit = answering(unavailable("60"), ok);
    const result = createXebraClient({
      fetch: atLimit,
      retry: { attempts: 1, baseMs: 10 },
    }).routes();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toEqual(ROUTES);
    expect(atLimit).toHaveBeenCalledTimes(2);
  });

  it("stop waiting when the caller aborts, with the caller's reason", async () => {
    const fetch = answering(unavailable("30"), ok);
    const client = createXebraClient({ fetch, retry: { attempts: 3, baseMs: 10 } });
    const controller = new AbortController();
    const result = client.routes({ signal: controller.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const reason = new Error("the user left");
    controller.abort(reason);
    expect(await result).toBe(reason);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("read anything that is not a count or a duration as no retries", async () => {
    for (const retry of [
      { attempts: 0, baseMs: 10 },
      { attempts: -2, baseMs: 10 },
      { attempts: Number.NaN, baseMs: 10 },
    ]) {
      const fetch = answering(unavailable("1"), ok);
      const result = createXebraClient({ fetch, retry })
        .routes()
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await result, JSON.stringify(retry)).toMatchObject({ status: 503 });
      expect(fetch, JSON.stringify(retry)).toHaveBeenCalledTimes(1);
    }
    // A fraction is cut to whole attempts, and a bad baseMs still honours Retry-After.
    const fetch = answering(unavailable("1"));
    const result = createXebraClient({ fetch, retry: { attempts: 1.9, baseMs: Number.NaN } })
      .routes()
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("waitForDelivery and Retry-After", () => {
  const TX = "a".repeat(64);
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const polling = (...answers: Array<() => Response>) => {
    let i = 0;
    return vi.fn(async () => {
      const next = answers[Math.min(i, answers.length - 1)] as () => Response;
      i++;
      return next();
    });
  };
  const delivered = () => json(200, STATUS("delivered"));

  it("waits for Retry-After after a 503 when it is longer than the interval", async () => {
    const fetch = polling(
      () => problemWith(503, "upstream_unavailable", { "Retry-After": "3" }),
      delivered,
    );
    const client = createXebraClient({ fetch });
    const result = client.waitForDelivery("stellar", TX, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).state).toBe("delivered");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does the same after a 429", async () => {
    const fetch = polling(
      () => problemWith(429, "rate_limited", { "Retry-After": "2" }),
      delivered,
    );
    const result = createXebraClient({ fetch }).waitForDelivery("stellar", TX, { intervalMs: 500 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).state).toBe("delivered");
  });

  it("keeps its interval when Retry-After is shorter, or missing", async () => {
    for (const headers of [{ "Retry-After": "1" }, {}] as Array<Record<string, string>>) {
      const fetch = polling(() => problemWith(503, "upstream_unavailable", headers), delivered);
      const result = createXebraClient({ fetch }).waitForDelivery("stellar", TX, {
        intervalMs: 5000,
      });
      await vi.advanceTimersByTimeAsync(4999);
      expect(fetch, JSON.stringify(headers)).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await result).state).toBe("delivered");
    }
  });

  it("goes back to its interval once the API answers again", async () => {
    const fetch = polling(
      () => problemWith(503, "upstream_unavailable", { "Retry-After": "3" }),
      () => json(200, STATUS("pending")),
      delivered,
    );
    const result = createXebraClient({ fetch }).waitForDelivery("stellar", TX, {
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).state).toBe("delivered");
  });

  it("gives up at once when the API asks for longer than the wait has left", async () => {
    const fetch = polling(() => problemWith(503, "upstream_unavailable", { "Retry-After": "120" }));
    const client = createXebraClient({ fetch });
    const err = await client
      .waitForDelivery("stellar", TX, { intervalMs: 1000, timeoutMs: 60_000 })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "wait_timeout" });
    expect((err as XebraApiError).cause).toMatchObject({ status: 503, retryAfterMs: 120_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
