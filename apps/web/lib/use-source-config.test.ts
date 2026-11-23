import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_NETWORK = "mainnet";

vi.mock("../components/wallet/wallet-provider", () => ({
  useWallets: () => ({ connections: {} }),
}));
vi.mock("./stellar-wallet", () => ({
  createStellarWalletKit: vi.fn(),
  probeStellarWallet: vi.fn(),
}));

import { recallSuiDigest } from "../app/sui/sui-client";
import { MAX_CONFIG_RETRIES, SourceConfigLoader } from "./use-source-config";

describe("SourceConfigLoader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads config successfully and fires onSelect", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true, foo: "bar" }),
    });

    let selected = 0;
    const loader = new SourceConfigLoader({
      url: "/api/test",
      remembered: { tx: "0x123" },
      parse: (json: unknown) => {
        const c = json as { enabled?: boolean; foo?: string };
        return c?.enabled ? { foo: c.foo } : null;
      },
      onSelect: () => {
        selected += 1;
      },
      fetchFn: fetchMock as never,
    });

    const promise = loader.load();
    await promise;

    expect(fetchMock).toHaveBeenCalledWith("/api/test", { cache: "no-store" });
    expect(loader.state.config).toEqual({ foo: "bar" });
    expect(loader.state.error).toBe(false);
    expect(selected).toBe(1);
  });

  it("sets config to null when server responds with enabled: false", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: false }),
    });

    let selected = 0;
    const loader = new SourceConfigLoader({
      url: "/api/test",
      remembered: { tx: "0x123" },
      parse: (json: unknown) => {
        const c = json as { enabled?: boolean };
        return c?.enabled ? c : null;
      },
      onSelect: () => {
        selected += 1;
      },
      fetchFn: fetchMock as never,
    });

    await loader.load();

    expect(loader.state.config).toBeNull();
    expect(loader.state.error).toBe(false);
    expect(selected).toBe(0);
  });

  it("caps retries at MAX_CONFIG_RETRIES (5) and triggers error on remembered transfer", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Network offline"));

    let selected = 0;
    const loader = new SourceConfigLoader({
      url: "/api/test/fail",
      remembered: { tx: "0xabc" },
      parse: (json: unknown) => json,
      onSelect: () => {
        selected += 1;
      },
      fetchFn: fetchMock as never,
    });

    await loader.load();

    // 1st attempt failed immediately
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loader.state.error).toBe(true);
    expect(selected).toBe(1); // selected on error when remembered

    // Advance timers through all remaining 4 retries
    for (let i = 1; i < MAX_CONFIG_RETRIES; i++) {
      await vi.runAllTimersAsync();
    }

    expect(fetchMock).toHaveBeenCalledTimes(MAX_CONFIG_RETRIES);
    expect(loader.state.attempts).toBe(MAX_CONFIG_RETRIES);

    // Further timer advances do not trigger any more retries
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(MAX_CONFIG_RETRIES);
  });

  it("does not flag error if nothing is remembered", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Offline"));

    const loader = new SourceConfigLoader({
      url: "/api/test/fail",
      remembered: null,
      parse: (json: unknown) => json,
      fetchFn: fetchMock as never,
    });

    await loader.load();

    expect(loader.state.error).toBe(false);
  });
});

describe("recallSuiDigest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recalls digest from localStorage", () => {
    const digest = "5P3K46Xv6sUvhqjP2h6H2NqV5p3K46Xv6sUvhqjP2h6H";
    const getItem = vi.fn().mockReturnValue(digest);
    vi.stubGlobal("window", {
      location: { search: "" },
      localStorage: { getItem },
    });

    expect(recallSuiDigest()).toBe(digest);
  });

  it("recalls digest from URL search parameter", () => {
    const digest = "5P3K46Xv6sUvhqjP2h6H2NqV5p3K46Xv6sUvhqjP2h6H";
    vi.stubGlobal("window", {
      location: { search: `?tx=${digest}` },
      localStorage: { getItem: () => null },
    });

    expect(recallSuiDigest()).toBe(digest);
  });
});
