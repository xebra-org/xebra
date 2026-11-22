import { describe, expect, it, vi } from "vitest";
import type { Quote, Routes, TransferBuild, TransferRequest } from "../api/schemas.js";
import { OneClickError, createRebalancer, fromUnits, toUnits } from "./rebalance.js";

// Entries copied from the live 1Click token list on 2026-11-14.
const BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const AVAX = "nep141:avax-0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e.omdep.near";
const TOKENS = [
  // Listed first on purpose: the retired ID for the same contract must be skipped.
  {
    assetId: "nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o",
    blockchain: "avax",
    symbol: "USDC(DEPRECATED)",
    decimals: 6,
    contractAddress: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
  },
  {
    assetId: BASE,
    blockchain: "base",
    symbol: "USDC",
    decimals: 6,
    contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
  {
    assetId: AVAX,
    blockchain: "avax",
    symbol: "USDC",
    decimals: 6,
    contractAddress: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
  },
  // A bridged copy named USDC: must never be picked.
  {
    assetId: "nep141:bnb-0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d.omdep.near",
    blockchain: "bsc",
    symbol: "USDC",
    decimals: 18,
    contractAddress: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
  },
];

const ROUTES: Routes = {
  routes: [{ from: "base", to: "avalanche", speeds: ["standard", "fast"] }],
  complete: true,
};

const REQ = {
  intentsAccount: "mm.near",
  from: "base",
  to: "avax",
  amount: "100000",
  fromWallet: "0x1111111111111111111111111111111111111111",
  toWallet: "0x2222222222222222222222222222222222222222",
};

function xebraQuote(amount: string, fee = "0.0625"): Quote {
  const gets = (Number(amount) - Number(fee)).toFixed(6).replace(/\.?0+$/, "");
  return {
    from: "base",
    to: "avalanche",
    speed: "standard",
    amount,
    recipientGets: gets,
    fees: { xebra: "0.05", circle: "0", delivery: "0.0125", total: fee },
    minimum: "1",
    maximum: null,
    circleStatus: "ok",
    expiresAt: "2026-11-14T23:00:00.000Z",
  };
}

function fakeXebra() {
  return {
    routes: vi.fn(async () => ROUTES),
    quote: vi.fn(async (q: { amount: string }) => xebraQuote(q.amount)),
    createTransfer: vi.fn(
      async (r: TransferRequest) =>
        ({ quote: xebraQuote(r.amount), steps: [] }) as unknown as TransferBuild,
    ),
  };
}

type Body = Record<string, unknown>;

/** A 1Click stand-in: same-asset withdrawals cost 0.0024, deposits are free, swaps fail. */
function fake1Click(o: { directSwap?: "none" | string } = {}) {
  const calls: { path: string; body?: Body; headers: Record<string, string> }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const body = init?.body ? (JSON.parse(String(init.body)) as Body) : undefined;
    calls.push({
      path: u.pathname,
      ...(body ? { body } : {}),
      headers: init?.headers as Record<string, string>,
    });
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/v0/tokens") return json(TOKENS);
    if (u.pathname === "/v0/quote" && body) {
      const amt = BigInt(body.amount as string);
      const out =
        body.originAsset !== body.destinationAsset
          ? o.directSwap === undefined || o.directSwap === "none"
            ? null
            : BigInt(o.directSwap)
          : body.depositType === "INTENTS"
            ? amt - 2400n
            : amt;
      if (out === null) return json({ message: "No liquidity available" }, 400);
      return json({
        quote: {
          ...(body.dry
            ? {}
            : { depositAddress: body.depositType === "INTENTS" ? "dep.intents" : "0xdep" }),
          amountIn: String(amt),
          amountInFormatted: fromUnits(String(amt), 6),
          amountOut: String(out),
          amountOutFormatted: fromUnits(String(out), 6),
          minAmountOut: String(out),
          timeEstimate: body.depositType === "INTENTS" ? 12 : 35,
        },
      });
    }
    if (u.pathname === "/v0/generate-intent") {
      return json({
        intent: { standard: "nep413", payload: { message: "{}" } },
        correlationId: "c",
      });
    }
    if (u.pathname === "/v0/submit-intent") return json({ intentHash: "H", correlationId: "c" });
    if (u.pathname === "/v0/status") return json({ status: "SUCCESS" });
    return json({ message: "not found" }, 404);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const NOW = Date.parse("2026-11-14T20:00:00Z");

describe("units", () => {
  it("round-trips decimals at the token's precision", () => {
    expect(toUnits("100000", 6)).toBe("100000000000");
    expect(toUnits("1.5", 7)).toBe("15000000");
    expect(fromUnits("99999997600", 6)).toBe("99999.9976");
    expect(fromUnits("1000000", 6)).toBe("1");
  });
  it("refuses more places than the token has", () => {
    expect(() => toUnits("1.0000001", 6)).toThrow();
    expect(() => toUnits("abc", 6)).toThrow();
  });
});

describe("1Click answers that are not what Xebra reads", () => {
  /** fake1Click, except that `path` answers 200 with `body` (a string is sent as is). */
  function answering(path: string, body: unknown) {
    const one = fake1Click();
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(url)).pathname !== path) return one.fetch(url, init);
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
    }) as typeof globalThis.fetch;
    return createRebalancer({ xebra: fakeXebra(), fetch, now: () => NOW });
  }

  it("refuses an empty or non-JSON quote body as invalid_response, with the body kept", async () => {
    for (const body of ["", "<html>busy</html>", null]) {
      const err = await answering("/v0/quote", body)
        .estimate(REQ)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OneClickError);
      expect(err).toMatchObject({ code: "invalid_response", status: 200, retryable: false });
      expect((err as OneClickError).body).toBe(body === null ? "null" : body);
    }
  });

  it("refuses a quote without minAmountOut instead of failing on BigInt", async () => {
    const quote = { amountIn: "1", amountOut: "1", timeEstimate: 10 };
    const err = await answering("/v0/quote", { quote })
      .estimate(REQ)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OneClickError);
    expect(err).toMatchObject({ code: "invalid_response", body: { quote } });
  });

  it("stops waitFor at once when a status answer has no status", async () => {
    const rb = answering("/v0/status", { correlationId: "c" });
    await expect(rb.waitFor("0xdep", { intervalMs: 1, timeoutMs: 60_000 })).rejects.toMatchObject({
      code: "invalid_response",
      body: { correlationId: "c" },
    });
  });

  it("refuses a token list that is not a list", async () => {
    await expect(answering("/v0/tokens", { tokens: [] }).estimate(REQ)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});

describe("estimate", () => {
  it("prices withdraw + CCTP + deposit and reports a missing direct swap", async () => {
    const one = fake1Click();
    const rb = createRebalancer({ xebra: fakeXebra(), fetch: one.fetch, now: () => NOW });
    const e = await rb.estimate(REQ);
    expect(e.from).toBe("base");
    expect(e.to).toBe("avalanche");
    expect(e.fromAsset).toBe(BASE);
    expect(e.toAsset).toBe(AVAX);
    expect(e.fees.withdraw).toBe("0.0024");
    expect(e.fees.cctp).toBe("0.0625");
    expect(e.fees.total).toBe("0.0649");
    expect(e.arrives).toBe("99999.9351");
    expect(e.direct).toEqual({ arrives: null, reason: "No liquidity available" });
    expect(e.better).toBe("rebalance");
    // Every quote was dry: nothing issued, nothing to sign.
    for (const c of one.calls.filter((c) => c.path === "/v0/quote")) expect(c.body?.dry).toBe(true);
  });

  it("says when one swap inside NEAR Intents leaves more", async () => {
    const one = fake1Click({ directSwap: "99999990000" });
    const rb = createRebalancer({ xebra: fakeXebra(), fetch: one.fetch, now: () => NOW });
    const e = await rb.estimate(REQ);
    expect(e.direct).toEqual({ arrives: "99999.99" });
    expect(e.better).toBe("direct");
  });

  it("refuses a route Xebra does not run", async () => {
    const one = fake1Click();
    const rb = createRebalancer({ xebra: fakeXebra(), fetch: one.fetch, now: () => NOW });
    await expect(rb.estimate({ ...REQ, from: "avax", to: "base" })).rejects.toThrow(
      /does not move/,
    );
  });

  it("refuses a chain where NEAR Intents lists no Circle USDC", async () => {
    const one = fake1Click();
    const x = fakeXebra();
    x.routes.mockResolvedValue({
      routes: [{ from: "base", to: "polygon", speeds: ["standard"] }],
      complete: true,
    });
    const rb = createRebalancer({ xebra: x, fetch: one.fetch, now: () => NOW });
    await expect(rb.estimate({ ...REQ, to: "polygon" })).rejects.toThrow(
      /no Circle USDC on polygon/,
    );
  });
});

describe("withdrawal", () => {
  it("needs a partner key and asks for nothing before it has one", async () => {
    const one = fake1Click();
    const rb = createRebalancer({ xebra: fakeXebra(), fetch: one.fetch, now: () => NOW });
    const err = await rb.startWithdrawal(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OneClickError);
    expect(err).toMatchObject({ code: "missing_api_key", status: 0, retryable: false });
    expect(one.calls.some((c) => c.path === "/v0/quote")).toBe(false);
  });

  it("tells a quote without a deposit address from a missing key", async () => {
    const one = fake1Click();
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const res = await one.fetch(url, init);
      if (new URL(String(url)).pathname !== "/v0/quote") return res;
      const { quote } = (await res.json()) as { quote: Record<string, unknown> };
      const { depositAddress: _, ...rest } = quote;
      return new Response(JSON.stringify({ quote: rest }), { status: 200 });
    }) as typeof globalThis.fetch;
    const rb = createRebalancer({
      xebra: fakeXebra(),
      fetch,
      now: () => NOW,
      oneClick: { apiKey: "k" },
    });
    const err = await rb.startWithdrawal(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OneClickError);
    expect(err).toMatchObject({ code: "no_deposit_address", status: 0 });
    expect((err as OneClickError).body).toMatchObject({ minAmountOut: "99999997600" });
    await expect(rb.prepareDeposit(REQ)).rejects.toMatchObject({ code: "no_deposit_address" });
  });

  it("keeps 1Click's status and whole body on an HTTP error", async () => {
    const answer = { message: "Invalid API key", correlationId: "c-9" };
    const fetch = (async () =>
      new Response(JSON.stringify(answer), { status: 401 })) as typeof globalThis.fetch;
    const rb = createRebalancer({ xebra: fakeXebra(), fetch, now: () => NOW });
    const err = await rb.status("0xdep").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OneClickError);
    expect(err).toMatchObject({ code: "http_error", status: 401, retryable: false, body: answer });
    expect((err as OneClickError).message).toBe("Invalid API key");

    const text = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
    const err2 = await createRebalancer({ xebra: fakeXebra(), fetch: text, now: () => NOW })
      .status("0xdep")
      .catch((e: unknown) => e);
    expect(err2).toMatchObject({ code: "http_error", status: 502, retryable: true });
    expect((err2 as OneClickError).body).toBe("bad gateway");
  });

  it("quotes same asset out to the market maker's own wallet, refund to its own account", async () => {
    const one = fake1Click();
    const rb = createRebalancer({
      xebra: fakeXebra(),
      fetch: one.fetch,
      now: () => NOW,
      oneClick: { apiKey: "k" },
    });
    const w = await rb.startWithdrawal(REQ);
    expect(w.depositAddress).toBe("dep.intents");
    expect(w.receives).toBe("99999.9976");
    const q = one.calls.find((c) => c.path === "/v0/quote")?.body;
    expect(q).toMatchObject({
      dry: false,
      originAsset: BASE,
      destinationAsset: BASE,
      depositType: "INTENTS",
      recipient: REQ.fromWallet,
      recipientType: "DESTINATION_CHAIN",
      refundTo: "mm.near",
      refundType: "INTENTS",
      amount: "100000000000",
      referral: "xebra",
      slippageTolerance: 0,
    });
    const g = one.calls.find((c) => c.path === "/v0/generate-intent");
    expect(g?.body).toEqual({
      type: "swap_transfer",
      standard: "nep413",
      signerId: "mm.near",
      depositAddress: "dep.intents",
    });
    expect(g?.headers["X-API-Key"]).toBe("k");

    const s = await rb.submitWithdrawal(w, { public_key: "ed25519:P", signature: "ed25519:S" });
    expect(s.intentHash).toBe("H");
    expect(one.calls.at(-1)?.body).toEqual({
      type: "swap_transfer",
      signedData: {
        standard: "nep413",
        payload: { message: "{}" },
        public_key: "ed25519:P",
        signature: "ed25519:S",
      },
    });
  });
});

describe("prepareDeposit", () => {
  it("burns from the market maker's wallet into a deposit address credited to its own account", async () => {
    const one = fake1Click();
    const x = fakeXebra();
    const rb = createRebalancer({ xebra: x, fetch: one.fetch, now: () => NOW });
    const d = await rb.prepareDeposit(REQ, { amount: "99999.9976" });
    expect(d.depositAddress).toBe("0xdep");
    const q = one.calls.find((c) => c.path === "/v0/quote")?.body;
    expect(q).toMatchObject({
      dry: false,
      swapType: "FLEX_INPUT",
      originAsset: AVAX,
      destinationAsset: AVAX,
      depositType: "ORIGIN_CHAIN",
      recipient: "mm.near",
      recipientType: "INTENTS",
      refundTo: REQ.toWallet,
      refundType: "ORIGIN_CHAIN",
      amount: "99999935100",
      deadline: new Date(NOW + 120 * 60_000).toISOString(),
    });
    expect(x.createTransfer).toHaveBeenCalledWith({
      from: "base",
      to: "avalanche",
      amount: "99999.9976",
      sender: REQ.fromWallet,
      recipient: "0xdep",
      maxTotalFee: "0.0625",
    });
  });

  it("refuses when CCTP fees rose above the cap, before any deposit address is issued", async () => {
    const one = fake1Click();
    const rb = createRebalancer({ xebra: fakeXebra(), fetch: one.fetch, now: () => NOW });
    await expect(rb.prepareDeposit({ ...REQ, maxTotalFee: "0.01" })).rejects.toThrow(/exceed/);
    expect(one.calls.some((c) => c.path === "/v0/quote")).toBe(false);
  });
});

describe("waitFor", () => {
  it("returns the settled state", async () => {
    const one = fake1Click();
    const rb = createRebalancer({ xebra: fakeXebra(), fetch: one.fetch, now: () => NOW });
    await expect(rb.waitFor("0xdep", { intervalMs: 1 })).resolves.toBe("SUCCESS");
  });

  /** fake1Click, except that /v0/status answers with each of `first` in turn before its own. */
  function statusFirst(...first: (() => Promise<Response>)[]) {
    const one = fake1Click();
    let n = 0;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(url)).pathname !== "/v0/status") return one.fetch(url, init);
      const next = first[n++];
      return next ? next() : one.fetch(url, init);
    });
    return { fetch: fetch as unknown as typeof globalThis.fetch, polls: () => n };
  }
  const answer = (status: number) => async () => new Response("{}", { status });

  it("rides out a dropped connection, a timeout, a 429 and a 503", async () => {
    const dropped = async () => {
      throw new TypeError("fetch failed");
    };
    const timedOut = async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    const f = statusFirst(dropped, timedOut, answer(429), answer(503));
    const rb = createRebalancer({ xebra: fakeXebra(), fetch: f.fetch, now: () => NOW });
    await expect(rb.waitFor("0xdep", { intervalMs: 1 })).resolves.toBe("SUCCESS");
    expect(f.polls()).toBe(5);
  });

  it("wraps fetch failures as OneClickError network_error or timeout, with the cause", async () => {
    const cause = new TypeError("fetch failed");
    const rb = createRebalancer({
      xebra: fakeXebra(),
      fetch: (async () => {
        throw cause;
      }) as typeof globalThis.fetch,
      now: () => NOW,
    });
    const err = await rb.status("0xdep").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OneClickError);
    expect(err).toMatchObject({ code: "network_error", status: 0, retryable: true, cause });

    const slow = createRebalancer({
      xebra: fakeXebra(),
      fetch: (async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }) as typeof globalThis.fetch,
      now: () => NOW,
    });
    await expect(slow.status("0xdep")).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("still throws at once on an answer that will not change, like a 400", async () => {
    const f = statusFirst(answer(400));
    const rb = createRebalancer({ xebra: fakeXebra(), fetch: f.fetch, now: () => NOW });
    await expect(rb.waitFor("0xdep", { intervalMs: 1 })).rejects.toMatchObject({ status: 400 });
    expect(f.polls()).toBe(1);
  });

  it("honours its deadline while 1Click is down, and says why", async () => {
    let t = NOW;
    const tick = () => {
      t += 1_000;
      return t;
    };
    const f = statusFirst(...Array.from({ length: 50 }, () => answer(503)));
    const rb = createRebalancer({ xebra: fakeXebra(), fetch: f.fetch, now: tick });
    const err = await rb
      .waitFor("0xdep", { intervalMs: 1, timeoutMs: 5_000 })
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/did not settle in time.*check status/);
    expect((err as Error).cause).toMatchObject({ status: 503 });
  });

  it("stops at once when aborted during the wait between polls", async () => {
    const f = statusFirst(async () => new Response(JSON.stringify({ status: "PROCESSING" })));
    const rb = createRebalancer({ xebra: fakeXebra(), fetch: f.fetch, now: () => NOW });
    const ctl = new AbortController();
    const started = Date.now();
    const waiting = rb.waitFor("0xdep", { intervalMs: 60_000, signal: ctl.signal });
    setTimeout(() => ctl.abort(new Error("stop")), 20);
    await expect(waiting).rejects.toThrow("stop");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(f.polls()).toBe(1);
  });
});
