import { HYPERLIQUID_DESTINATIONS } from "@xebra/sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const read = async () => (await GET()).json() as Promise<Record<string, unknown>>;

describe("GET /api/hyperliquid/config", () => {
  beforeEach(() => vi.unstubAllEnvs());

  it("says off by default", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERLIQUID_SOURCE", "");
    expect(await read()).toEqual({ enabled: false });
  });

  it("says unavailable, with a reason, while Xebra's fee address there is not set", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERLIQUID_SOURCE", "true");
    vi.stubEnv("XEBRA_FEE_ADDRESS_HYPERCORE", "");
    const c = await read();
    expect(c.enabled).toBe(true);
    expect(c.available).toBe(false);
    expect(String(c.reason)).toMatch(/fee/);
  });

  it("lists every destination and the cap once it is set up", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERLIQUID_SOURCE", "true");
    vi.stubEnv("XEBRA_FEE_ADDRESS_HYPERCORE", "0x32e95718A4D9B60F2e4Fb1d371189ac5DD28211A");
    vi.stubEnv("HYPERLIQUID_MAX_USDC", "250");
    expect(await read()).toEqual({
      enabled: true,
      available: true,
      destinations: [...HYPERLIQUID_DESTINATIONS],
      maxUsdc: "250",
    });
  });

  it("says unavailable, not a crash, when a setting is malformed", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERLIQUID_SOURCE", "true");
    vi.stubEnv("XEBRA_FEE_ADDRESS_HYPERCORE", "0x1234");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).available).toBe(false);
  });
});
