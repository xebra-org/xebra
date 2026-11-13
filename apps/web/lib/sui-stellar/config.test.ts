import { EVM_CHAINS } from "@xebra/sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseSuiSendsToEvm,
  suiEvmDestinations,
  suiSendsToDomain,
  suiSendsToSolana,
} from "./config";

const ids = (value: string | undefined) => parseSuiSendsToEvm(value).map((c) => c.id);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SUI_SENDS_TO_EVM", () => {
  it("is Monad when unset, as it has been since the route went live", () => {
    expect(ids(undefined)).toEqual(["monad"]);
  });

  it("is nothing for none or an empty value", () => {
    expect(ids("none")).toEqual([]);
    expect(ids("")).toEqual([]);
    expect(ids("  ")).toEqual([]);
  });

  it("is every chain in the EVM table for all, in table order, Arc included", () => {
    const all = ids("all");
    expect(all).toEqual(Object.keys(EVM_CHAINS));
    expect(all).toContain("arc");
    expect(ids(" ALL ")).toEqual(all);
  });

  it("keeps the order named, drops repeats, and ignores names it does not know", () => {
    expect(ids("base, monad,base,nonsense,solana")).toEqual(["base", "monad"]);
    // `all` only means every chain on its own; inside a list it is just an unknown name.
    expect(ids("monad,all")).toEqual(["monad"]);
  });

  it("is nothing while the Sui page is off", () => {
    vi.stubEnv("SUI_STELLAR_ENABLED", "");
    vi.stubEnv("SUI_SENDS_TO_EVM", "all");
    expect(suiEvmDestinations()).toEqual([]);
  });
});

describe("SUI_SENDS_TO_SOLANA", () => {
  it("is off unless set to true", () => {
    vi.stubEnv("SUI_STELLAR_ENABLED", "true");
    for (const off of [undefined, "", "1", "yes", "false"]) {
      vi.stubEnv("SUI_SENDS_TO_SOLANA", off as unknown as string);
      expect(suiSendsToSolana(), String(off)).toBe(false);
      expect(suiSendsToDomain(5), String(off)).toBe(false);
    }
    vi.stubEnv("SUI_SENDS_TO_SOLANA", "true");
    expect(suiSendsToSolana()).toBe(true);
    expect(suiSendsToDomain(5)).toBe(true);
  });

  it("is not switched on by SUI_SENDS_TO_EVM=all", () => {
    vi.stubEnv("SUI_STELLAR_ENABLED", "true");
    vi.stubEnv("SUI_SENDS_TO_EVM", "all");
    vi.stubEnv("SUI_SENDS_TO_SOLANA", "");
    expect(suiSendsToDomain(5)).toBe(false);
    expect(suiSendsToDomain(EVM_CHAINS.base.cctpDomainId)).toBe(true);
  });

  it("is off while the Sui page is off", () => {
    vi.stubEnv("SUI_STELLAR_ENABLED", "");
    vi.stubEnv("SUI_SENDS_TO_SOLANA", "true");
    expect(suiSendsToSolana()).toBe(false);
  });
});
