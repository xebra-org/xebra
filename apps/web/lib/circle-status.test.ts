import { afterEach, describe, expect, it, vi } from "vitest";
import { getDelivery, getRouteHealth, requestReattest } from "./circle-status";
import { getWrapperSettings } from "./evm-wrapper";

const reply = (body: unknown, status = 200) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body, { status })),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getDelivery", () => {
  it("passes a known state through", async () => {
    reply({ status: "known", state: "delivered", forwardTxHash: "0x1", reason: null });
    expect(await getDelivery("ab")).toMatchObject({ status: "known", state: "delivered" });
  });

  it("reports unknown, never waiting, when the server cannot say", async () => {
    reply({ status: "unknown", reason: "paused" });
    expect((await getDelivery("ab")).status).toBe("unknown");
    reply({}, 502);
    expect((await getDelivery("ab")).status).toBe("unknown");
    reply({ status: "known" }); // known without a state is not an answer
    expect((await getDelivery("ab")).status).toBe("unknown");
  });

  it("does not throw when the network fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    expect((await getDelivery("ab")).status).toBe("unknown");
  });
});

describe("naming the source of a burn", () => {
  const spy = () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ status: "known", state: "waiting", forwardTxHash: null, reason: null }),
    );
    vi.stubGlobal("fetch", f);
    return f;
  };

  it("sends a bare hash for a Stellar burn, exactly as before", async () => {
    const f = spy();
    await getDelivery("ab");
    expect(f.mock.calls[0]?.[0]).toBe("/api/delivery?tx=ab");
  });

  it("names the chain for an EVM burn, zero included", async () => {
    const f = spy();
    await getDelivery("0xab", 6);
    expect(f.mock.calls[0]?.[0]).toBe("/api/delivery?tx=0xab&src=6");
    await getDelivery("0xab", 0);
    expect(f.mock.calls[1]?.[0]).toBe("/api/delivery?tx=0xab&src=0");
  });
});

describe("getRouteHealth", () => {
  it("asks by the two domains and returns the verdict", async () => {
    const f = vi.fn(async (_url: string) => Response.json({ status: "ok", reasons: [] }));
    vi.stubGlobal("fetch", f);
    expect((await getRouteHealth(6, 26))?.status).toBe("ok");
    expect(f.mock.calls[0]?.[0]).toBe("/api/circle-health?src=6&dst=26");
    await getRouteHealth(26, 5, true);
    expect(f.mock.calls[1]?.[0]).toBe("/api/circle-health?src=26&dst=5&newAccount=1");
    // A Stellar burn names Stellar's domain, the same way.
    await getRouteHealth(27, 5, true);
    expect(f.mock.calls[2]?.[0]).toBe("/api/circle-health?src=27&dst=5&newAccount=1");
  });

  it("is null, not down, when the check itself could not run", async () => {
    reply({}, 500);
    expect(await getRouteHealth(6, 26)).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    expect(await getRouteHealth(6, 26)).toBeNull();
    reply({ status: "banana" });
    expect(await getRouteHealth(6, 26)).toBeNull();
  });
});

describe("requestReattest", () => {
  it("posts the nonce and reports that it was asked", async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ status: "requested" }),
    );
    vi.stubGlobal("fetch", f);
    expect(await requestReattest("0xabc")).toEqual({ ok: true });
    expect(f.mock.calls[0]?.[0]).toBe("/api/reattest");
    expect(f.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ nonce: "0xabc" }));
  });

  it("gives the reason when Circle says no, and never throws", async () => {
    reply({ status: "failed", reason: "nonce not found" }, 404);
    expect(await requestReattest("0xabc")).toEqual({ ok: false, reason: "nonce not found" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    expect((await requestReattest("0xabc")).ok).toBe(false);
  });
});

describe("status fetch timeouts", () => {
  const hangingFetch = () =>
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

  it("aborts a hanging delivery fetch with a 10-15s timeout and reports unknown", async () => {
    const origTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBeGreaterThanOrEqual(10_000);
      expect(ms).toBeLessThanOrEqual(15_000);
      return origTimeout(10);
    });
    vi.stubGlobal("fetch", hangingFetch());

    const view = await getDelivery("ab");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(view).toEqual({ status: "unknown", reason: "could not reach the status service" });
  });

  it("aborts a hanging route-health fetch and returns null", async () => {
    const origTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBeGreaterThanOrEqual(10_000);
      expect(ms).toBeLessThanOrEqual(15_000);
      return origTimeout(10);
    });
    vi.stubGlobal("fetch", hangingFetch());

    expect(await getRouteHealth(6, 26)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("aborts a hanging wrapper-settings fetch and returns null", async () => {
    const origTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBeGreaterThanOrEqual(10_000);
      expect(ms).toBeLessThanOrEqual(15_000);
      return origTimeout(10);
    });
    vi.stubGlobal("fetch", hangingFetch());

    expect(await getWrapperSettings(1)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
