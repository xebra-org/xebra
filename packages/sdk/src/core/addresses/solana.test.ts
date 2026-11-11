import { describe, expect, it } from "vitest";
import {
  base58Decode,
  bytesToHex,
  checkSolanaAddress,
  looksLikeEvmAddress,
  solanaAddressToBytes32,
} from "./solana.js";

// Real mainnet USDC mint — a known-good 32-byte Solana pubkey.
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// Real devnet USDC mint.
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
// The system program / default pubkey: all 32 bytes zero, encoded as 32 '1's.
const ALL_ZERO = "1".repeat(32);

describe("base58Decode", () => {
  it("decodes a real Solana pubkey to exactly 32 bytes", () => {
    expect(base58Decode(USDC_MINT)).toHaveLength(32);
    expect(base58Decode(DEVNET_USDC)).toHaveLength(32);
  });

  it("preserves leading zero bytes encoded as leading '1's", () => {
    // A Solana pubkey may legitimately begin with zero bytes; dropping them would silently
    // produce a different, shorter key.
    const decoded = base58Decode(ALL_ZERO);
    expect(decoded).toHaveLength(32);
    expect(decoded.every((b) => b === 0)).toBe(true);
  });

  it("round-trips a known vector", () => {
    // "Hello World!" is a standard base58 test vector.
    expect(new TextDecoder().decode(base58Decode("2NEpo7TZRRrLZSi2U"))).toBe("Hello World!");
  });

  it("rejects the lookalike characters base58 deliberately excludes", () => {
    // 0/O and I/l are excluded precisely because they are easy to mistype.
    for (const bad of ["0", "O", "I", "l"]) {
      expect(() => base58Decode(`${USDC_MINT.slice(0, 43)}${bad}`)).toThrow(/not a valid base58/);
    }
  });

  it("rejects an empty string", () => {
    expect(() => base58Decode("")).toThrow(/empty/);
  });
});

describe("solanaAddressToBytes32", () => {
  it("accepts real mints and tolerates surrounding whitespace", () => {
    expect(solanaAddressToBytes32(`  ${USDC_MINT}  `)).toHaveLength(32);
  });

  it("rejects an address that does not decode to 32 bytes", () => {
    expect(() => solanaAddressToBytes32("abc")).toThrow(/32 bytes/);
  });

  it("rejects the all-zero address", () => {
    // A real value nobody controls, and a plausible paste error. The contract rejects it too
    // (MintRecipientZero) but a CCTP burn is irreversible, so catch it before signing.
    expect(() => solanaAddressToBytes32(ALL_ZERO)).toThrow(/nobody controls it/);
  });
});

describe("looksLikeEvmAddress", () => {
  it("flags a left-padded EVM address", () => {
    const bytes = new Uint8Array(32);
    bytes.fill(0xab, 12); // 20 significant bytes, 12 leading zeros
    expect(looksLikeEvmAddress(bytes)).toBe(true);
  });

  it("does not flag a real Solana pubkey", () => {
    expect(looksLikeEvmAddress(solanaAddressToBytes32(USDC_MINT))).toBe(false);
    expect(looksLikeEvmAddress(solanaAddressToBytes32(DEVNET_USDC))).toBe(false);
  });
});

describe("checkSolanaAddress", () => {
  it("is quiet on an empty field rather than shouting at an untouched form", () => {
    expect(checkSolanaAddress("")).toEqual({ ok: false });
    expect(checkSolanaAddress("   ")).toEqual({ ok: false });
  });

  it("accepts a valid address and returns its bytes", () => {
    const result = checkSolanaAddress(USDC_MINT);
    expect(result.ok).toBe(true);
    expect(result.bytes).toHaveLength(32);
  });

  it("names the specific problem for an EVM address", () => {
    // 0x + 40 hex chars, left-padded to 32 bytes, re-encoded — the realistic paste mistake is
    // a user copying an Ethereum address, so the message should say exactly that.
    const evm = new Uint8Array(32);
    evm.fill(0x11, 12);
    // Encode those bytes back to base58 to simulate what the user would paste.
    const encoded = encodeBase58(evm);
    const result = checkSolanaAddress(encoded);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Ethereum address/);
  });

  it("explains a bad character instead of failing generically", () => {
    const result = checkSolanaAddress(`${USDC_MINT.slice(0, 43)}0`);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/base58/);
  });
});

describe("bytesToHex", () => {
  it("pads each byte to two hex digits", () => {
    expect(bytesToHex(Uint8Array.from([0, 1, 15, 16, 255]))).toBe("0x00010f10ff");
  });
});

/** Test-only base58 encoder, so the EVM-shape case can be expressed as a pasteable string. */
function encodeBase58(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i] as number];
  return out;
}
