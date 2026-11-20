import { describe, expect, it, vi } from "vitest";
import { XebraError } from "../errors.js";
import {
  XebraApiError,
  type XebraCallOptions,
  type XebraClient,
  createXebraClient,
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
