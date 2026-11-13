import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APTOS_ALL_DESTINATIONS,
  aptosDestinationDomain,
  aptosDestinations,
  aptosMaxUsdcBase,
  aptosSendsToDomain,
  parseAptosSendsTo,
} from "./config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseAptosSendsTo", () => {
  it("is nothing when unset or empty", () => {
    expect(parseAptosSendsTo(undefined)).toEqual([]);
    expect(parseAptosSendsTo("")).toEqual([]);
    expect(parseAptosSendsTo(" , ")).toEqual([]);
  });

  it("takes EVM ids, solana and stellar, in the page's order, ignoring unknown names", () => {
    expect(parseAptosSendsTo("solana, BASE ,stellar,ethereum,sui,arc")).toEqual([
      "stellar",
      "arc",
      "base",
      "solana",
    ]);
  });

  it("`all` is every EVM chain in the table, Arc, Solana and Stellar", () => {
    const all = parseAptosSendsTo("all");
    expect(all).toEqual([...APTOS_ALL_DESTINATIONS]);
    expect(all).toHaveLength(17);
    expect(all.map(aptosDestinationDomain).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 5, 6, 7, 10, 12, 13, 14, 15, 16, 18, 19, 21, 26, 27,
    ]);
  });
});

describe("the switches", () => {
  it("offer nothing unless APTOS_ENABLED is exactly true", () => {
    vi.stubEnv("APTOS_SENDS_TO", "all");
    for (const v of ["", "1", "yes", "TRUE"]) {
      vi.stubEnv("APTOS_ENABLED", v);
      expect(aptosDestinations(), v).toEqual([]);
      expect(aptosSendsToDomain(6)).toBe(false);
    }
    vi.stubEnv("APTOS_ENABLED", "true");
    expect(aptosSendsToDomain(6)).toBe(true);
    expect(aptosSendsToDomain(27)).toBe(true);
    expect(aptosSendsToDomain(8)).toBe(false);
  });

  it("reads the cap in USDC, and none when unset or nonsense", () => {
    vi.stubEnv("APTOS_MAX_USDC", "");
    expect(aptosMaxUsdcBase()).toBeNull();
    vi.stubEnv("APTOS_MAX_USDC", "-3");
    expect(aptosMaxUsdcBase()).toBeNull();
    vi.stubEnv("APTOS_MAX_USDC", "25.5");
    expect(aptosMaxUsdcBase()).toBe(25_500_000n);
  });
});
