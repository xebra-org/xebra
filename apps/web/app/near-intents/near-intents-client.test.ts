import { describe, expect, it, vi } from "vitest";
import { parseTracked } from "./near-intents-client";

// Stub out browser-only wallet-provider and env required for build
vi.mock("../../components/wallet/wallet-provider", () => ({
  useWallets: () => ({}),
}));

vi.mock("../../lib/env", () => ({
  env: { evmRoutes: {} },
}));

const VALID_TRACKED = {
  from: "arc",
  depositAddress: "0x1111111111111111111111111111111111111111",
  tx: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  hub: "base",
  expectOut: "25.0",
  symbol: "NEAR",
};

describe("parseTracked", () => {
  it("parses a valid tracked transfer with an EVM source chain", () => {
    const raw = JSON.stringify(VALID_TRACKED);
    expect(parseTracked(raw)).toEqual(VALID_TRACKED);
  });

  it("parses a valid tracked transfer with Stellar as source chain", () => {
    const raw = JSON.stringify({ ...VALID_TRACKED, from: "stellar" });
    expect(parseTracked(raw)).toEqual({ ...VALID_TRACKED, from: "stellar" });
  });

  it("parses a legacy transfer saved before other chains existed (absent from field)", () => {
    const { from: _, ...legacy } = VALID_TRACKED;
    const raw = JSON.stringify(legacy);
    expect(parseTracked(raw)).toEqual(legacy);
  });

  it("rejects a bad or unsupported chain id", () => {
    expect(parseTracked(JSON.stringify({ ...VALID_TRACKED, from: "dogechain" }))).toBeNull();
    expect(
      parseTracked(JSON.stringify({ ...VALID_TRACKED, from: "unknown-chain-999" })),
    ).toBeNull();
    expect(parseTracked(JSON.stringify({ ...VALID_TRACKED, from: 12345 }))).toBeNull();
  });

  it("rejects when any required field is missing or empty", () => {
    for (const field of ["depositAddress", "tx", "hub", "expectOut", "symbol"]) {
      const omitted = { ...VALID_TRACKED };
      delete (omitted as Record<string, unknown>)[field];
      expect(parseTracked(JSON.stringify(omitted))).toBeNull();

      const empty = { ...VALID_TRACKED, [field]: "" };
      expect(parseTracked(JSON.stringify(empty))).toBeNull();

      const whitespaceOnly = { ...VALID_TRACKED, [field]: "   " };
      expect(parseTracked(JSON.stringify(whitespaceOnly))).toBeNull();
    }
  });

  it("rejects non-JSON input", () => {
    expect(parseTracked("not-valid-json")).toBeNull();
    expect(parseTracked("{unclosed-json")).toBeNull();
    expect(parseTracked("undefined")).toBeNull();
  });

  it("rejects null, empty string, or non-object JSON values", () => {
    expect(parseTracked(null)).toBeNull();
    expect(parseTracked("")).toBeNull();
    expect(parseTracked("null")).toBeNull();
    expect(parseTracked("12345")).toBeNull();
    expect(parseTracked('"a string"')).toBeNull();
    expect(parseTracked("[]")).toBeNull();
  });
});
