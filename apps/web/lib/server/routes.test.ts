import { afterEach, describe, expect, it, vi } from "vitest";
import { isOfferedRoute, normaliseTxHash, readDomain, readSource } from "./routes";

const STELLAR = 27;
const HEX = "ab".repeat(32);
/** A real Sui digest (the first Sui to Stellar burn): base58, mixed case. */
const SUI_TX = "37cRcRxVbwscXJAjLfqmXh19CDdKeHMBVJ1GMSqJKEE7";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readSource", () => {
  it("means Stellar when no source is named, so every existing link still works", () => {
    expect(readSource(null, STELLAR)).toEqual({ domain: 27, kind: "stellar" });
    expect(readSource("", STELLAR)).toEqual({ domain: 27, kind: "stellar" });
    expect(readSource("27", STELLAR)).toEqual({ domain: 27, kind: "stellar" });
  });

  it("accepts the EVM chains this product burns on", () => {
    for (const domain of [1, 2, 3, 6, 7, 10, 12, 13, 14, 15, 16, 18, 19, 21, 26]) {
      expect(readSource(String(domain), STELLAR)).toEqual({ domain, kind: "evm" });
    }
  });

  it("refuses a chain we do not burn on, and anything that is not a domain", () => {
    // 5 is Solana: a destination here, never a source. 8 (Sui) and 29 are Circle domains we do
    // not burn on.
    // 0, 11, 22 and 28 (Ethereum, Linea, Plume, EDGE) are Circle chains left out on purpose.
    for (const bad of [
      "0",
      "11",
      "22",
      "28",
      "5",
      "8",
      "29",
      "999",
      "-1",
      "0x6",
      "base",
      "6;",
      " 6",
    ]) {
      expect(readSource(bad, STELLAR), bad).toBeNull();
    }
  });
});

describe("normaliseTxHash", () => {
  it("takes a Stellar hash bare and an EVM hash with 0x, lower-cased", () => {
    expect(normaliseTxHash("stellar", ` ${HEX.toUpperCase()} `)).toBe(HEX);
    expect(normaliseTxHash("evm", `0x${HEX.toUpperCase()}`)).toBe(`0x${HEX}`);
  });

  it("does not accept either in the other's form", () => {
    expect(normaliseTxHash("stellar", `0x${HEX}`)).toBeNull();
    expect(normaliseTxHash("evm", HEX)).toBeNull();
  });

  it("refuses the wrong length, non-hex and nothing", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "zz",
      HEX.slice(2),
      `${HEX}00`,
      `0x${"zz".repeat(32)}`,
    ]) {
      expect(normaliseTxHash("stellar", bad)).toBeNull();
      expect(normaliseTxHash("evm", bad)).toBeNull();
    }
  });
});

describe("isOfferedRoute", () => {
  it("offers Stellar to Solana and to every EVM chain in the table, and nothing else", () => {
    expect(isOfferedRoute(27, 5, STELLAR)).toBe(true);
    for (const domain of [1, 2, 3, 6, 7, 10, 12, 13, 14, 15, 16, 18, 19, 21, 26]) {
      expect(isOfferedRoute(27, domain, STELLAR), String(domain)).toBe(true);
    }
    // The chains left out on purpose, Stellar itself, and a Circle domain we do not serve (Sui).
    for (const no of [0, 11, 22, 28, 27, 8]) {
      expect(isOfferedRoute(27, no, STELLAR), String(no)).toBe(false);
    }
  });

  it("offers each EVM peer with Arc, both ways, and nothing between peers", () => {
    expect(isOfferedRoute(6, 26, STELLAR)).toBe(true);
    expect(isOfferedRoute(26, 7, STELLAR)).toBe(true);
    expect(isOfferedRoute(6, 3, STELLAR)).toBe(false);
    expect(isOfferedRoute(6, 5, STELLAR)).toBe(false);
    // Arc sends to Solana; Solana is never a source here.
    expect(isOfferedRoute(26, 5, STELLAR)).toBe(true);
    expect(isOfferedRoute(5, 26, STELLAR)).toBe(false);
    // Ink (21) and Sei (16), both directions; the chains left out, neither.
    expect(isOfferedRoute(21, 26, STELLAR)).toBe(true);
    expect(isOfferedRoute(26, 16, STELLAR)).toBe(true);
    for (const left of [0, 11, 22, 28]) {
      expect(isOfferedRoute(26, left, STELLAR)).toBe(false);
      expect(isOfferedRoute(left, 26, STELLAR)).toBe(false);
    }
    expect(isOfferedRoute(26, 27, STELLAR)).toBe(false);
  });
});

describe("the EVM mesh", () => {
  it("offers any two different chains named in NEXT_PUBLIC_EVM_MESH, and nothing else", () => {
    vi.stubEnv("NEXT_PUBLIC_EVM_MESH", "unichain,base");
    expect(isOfferedRoute(10, 6, STELLAR)).toBe(true);
    expect(isOfferedRoute(6, 10, STELLAR)).toBe(true);
    expect(isOfferedRoute(10, 3, STELLAR)).toBe(false);
    expect(isOfferedRoute(6, 6, STELLAR)).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_EVM_MESH", "all");
    expect(isOfferedRoute(6, 3, STELLAR)).toBe(true);
    expect(isOfferedRoute(6, 5, STELLAR)).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_EVM_MESH", "bsae");
    expect(isOfferedRoute(6, 3, STELLAR)).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("readDomain", () => {
  it("reads digits only", () => {
    expect(readDomain("26")).toBe(26);
    expect(readDomain("0")).toBe(0);
    expect(readDomain(null)).toBeNull();
    expect(readDomain("2 6")).toBeNull();
    expect(readDomain("1e2")).toBeNull();
  });
});

describe("Sui as a source", () => {
  it("is refused while the Sui page is off", () => {
    vi.stubEnv("SUI_STELLAR_ENABLED", "");
    expect(readSource("8", STELLAR)).toBeNull();
    expect(isOfferedRoute(8, 15, STELLAR)).toBe(false);
  });

  it("is read once the page is on, and sends to Monad by default and nowhere else", () => {
    vi.stubEnv("SUI_STELLAR_ENABLED", "true");
    vi.stubEnv("SUI_SENDS_TO_EVM", undefined as unknown as string);
    expect(readSource("8", STELLAR)).toEqual({ domain: 8, kind: "sui" });
    expect(isOfferedRoute(8, 15, STELLAR)).toBe(true);
    for (const no of [6, 26, 27, 5, 0]) {
      expect(isOfferedRoute(8, no, STELLAR), String(no)).toBe(false);
    }
  });

  it("follows SUI_SENDS_TO_EVM, ignoring names it does not know", () => {
    vi.stubEnv("SUI_STELLAR_ENABLED", "true");
    vi.stubEnv("SUI_SENDS_TO_EVM", "base, nonsense");
    expect(isOfferedRoute(8, 6, STELLAR)).toBe(true);
    expect(isOfferedRoute(8, 15, STELLAR)).toBe(false);
    vi.stubEnv("SUI_SENDS_TO_EVM", "none");
    expect(isOfferedRoute(8, 15, STELLAR)).toBe(false);
  });

  it("keeps a digest's case, and refuses hex hashes", () => {
    expect(normaliseTxHash("sui", ` ${SUI_TX} `)).toBe(SUI_TX);
    for (const bad of [null, "", `0x${HEX}`, "0OIl".repeat(10), `${SUI_TX}!`]) {
      expect(normaliseTxHash("sui", bad), String(bad)).toBeNull();
    }
  });
});

describe("Aptos as a source", () => {
  it("is refused while its switch is off, whatever APTOS_SENDS_TO says", () => {
    vi.stubEnv("APTOS_ENABLED", "");
    vi.stubEnv("APTOS_SENDS_TO", "all");
    expect(readSource("9", STELLAR)).toBeNull();
    expect(isOfferedRoute(9, 6, STELLAR)).toBe(false);
  });

  it("is read once switched on, and offers nothing until APTOS_SENDS_TO names a chain", () => {
    vi.stubEnv("APTOS_ENABLED", "true");
    vi.stubEnv("APTOS_SENDS_TO", undefined as unknown as string);
    expect(readSource("9", STELLAR)).toEqual({ domain: 9, kind: "aptos" });
    for (const d of [6, 26, 5, 27]) expect(isOfferedRoute(9, d, STELLAR), String(d)).toBe(false);
  });

  it("quotes the chains Circle forwards to, never Stellar (nothing forwards into it)", () => {
    vi.stubEnv("APTOS_ENABLED", "true");
    vi.stubEnv("APTOS_SENDS_TO", "all");
    for (const d of [1, 2, 3, 6, 7, 10, 12, 13, 14, 15, 16, 18, 19, 21, 26, 5]) {
      expect(isOfferedRoute(9, d, STELLAR), String(d)).toBe(true);
    }
    // Stellar, Sui, Aptos itself, and Circle chains outside the table (Ethereum, Linea).
    for (const d of [27, 8, 9, 0, 11]) expect(isOfferedRoute(9, d, STELLAR), String(d)).toBe(false);
    vi.stubEnv("APTOS_SENDS_TO", "base, solana, nonsense");
    expect(isOfferedRoute(9, 6, STELLAR)).toBe(true);
    expect(isOfferedRoute(9, 5, STELLAR)).toBe(true);
    expect(isOfferedRoute(9, 26, STELLAR)).toBe(false);
  });

  it("reads hashes as 0x and 64 hex, lower-cased like Circle indexes them", () => {
    expect(normaliseTxHash("aptos", ` 0x${HEX.toUpperCase()} `)).toBe(`0x${HEX}`);
    for (const bad of [null, "", HEX, SUI_TX, `0x${HEX}00`]) {
      expect(normaliseTxHash("aptos", bad), String(bad)).toBeNull();
    }
  });
});
