import { afterEach, describe, expect, it, vi } from "vitest";
import { logFailure } from "./log";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logFailure", () => {
  it("writes one JSON line with route, request_id, message, name, cause, and safe ctx", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cause = new Error("ECONNRESET");
    const err = new Error("Circle timed out", { cause });
    err.name = "UpstreamError";
    const req = new Request("https://xebra.exchange/api/delivery", {
      headers: { "x-vercel-id": "iad1::abc123" },
    });

    logFailure("/api/delivery", err, { chain: "stellar", txHash: "0xabc", attempt: 2 }, req);

    expect(spy).toHaveBeenCalledTimes(1);
    const rawLine = spy.mock.calls[0]?.[0];
    expect(typeof rawLine).toBe("string");
    expect(rawLine).not.toContain("\n");

    const parsed = JSON.parse(rawLine as string);
    expect(parsed).toEqual({
      route: "/api/delivery",
      request_id: "iad1::abc123",
      message: "Circle timed out",
      name: "UpstreamError",
      cause: { name: "Error", message: "ECONNRESET" },
      chain: "stellar",
      txHash: "0xabc",
      attempt: 2,
    });
  });

  it("sets request_id to null when no request or x-vercel-id header is present", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logFailure("/api/attestation", new Error("bad gateway"));
    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(parsed.request_id).toBeNull();
    expect(parsed.cause).toBeNull();
  });

  it("drops ctx keys matching /secret|key|token|seed/i (including nested keys)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logFailure("/api/sui-stellar/complete", new Error("rpc down"), {
      relayerSecret: "S-PRIVATE",
      apiKey: "xk_live_123",
      access_token: "tok_999",
      mnemonicSeed: "word1 word2",
      nested: { bearerToken: "abc", okField: "kept" },
      digest: "37cRcRxVbwscXJAjLfqmXh19CDdKeHMBVJ1GMSqJKEE7",
    });

    const rawLine = spy.mock.calls[0]?.[0] as string;
    expect(rawLine).not.toContain("S-PRIVATE");
    expect(rawLine).not.toContain("xk_live_123");
    expect(rawLine).not.toContain("tok_999");
    expect(rawLine).not.toContain("word1 word2");
    expect(rawLine).not.toContain("bearerToken");

    const parsed = JSON.parse(rawLine);
    expect(parsed.nested).toEqual({ okField: "kept" });
    expect(parsed.digest).toBe("37cRcRxVbwscXJAjLfqmXh19CDdKeHMBVJ1GMSqJKEE7");
  });

  it("handles non-Error thrown values cleanly", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logFailure("/api/recipient", "network unreachable");
    logFailure("/api/recipient", { code: 503, detail: "unavailable" });
    logFailure("/api/recipient", null);

    expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toMatchObject({
      route: "/api/recipient",
      message: "network unreachable",
      name: null,
      cause: null,
    });
    expect(JSON.parse(spy.mock.calls[1]?.[0] as string)).toMatchObject({
      route: "/api/recipient",
      name: null,
    });
    expect(JSON.parse(spy.mock.calls[2]?.[0] as string)).toMatchObject({
      route: "/api/recipient",
      message: "null",
      name: null,
    });
  });

  it("never throws on circular ctx, bigint values, or broken request/console", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const circular: Record<string, unknown> = { amount: 100n };
    circular.self = circular;

    expect(() => logFailure("/api/delivery", new Error("boom"), circular)).not.toThrow();
    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(parsed.amount).toBe("100");
    expect(parsed.self).toBe("[Circular]");

    spy.mockImplementation(() => {
      throw new Error("console exploded");
    });
    expect(() => logFailure("/api/delivery", new Error("boom"))).not.toThrow();
  });
});
