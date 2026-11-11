/**
 * Base58 decoding and validation for Solana addresses.
 *
 * This is the single most safety-critical value in the bridge UI. `mint_recipient` is where
 * the USDC is minted on the destination chain, and a CCTP burn is **irreversible** — there is
 * no admin unwind, no refund path, and no one to appeal to. A malformed or mistyped address
 * destroys the transfer.
 *
 * The contract catches chain-family confusion: `check_mint_recipient` rejects an EVM-shaped
 * (12-byte zero-prefixed) recipient on a Solana-destination transfer. It cannot catch a
 * well-formed Solana address the user does not control — that is a frontend responsibility,
 * which is why validation lives here and is exercised by tests.
 *
 * Written by hand rather than pulling in `bs58`: the decode is ~30 lines, the project does not
 * already depend on it, and a dependency in the funds path is worth avoiding when the
 * alternative is this small and directly testable.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const INDEX: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) INDEX[ALPHABET[i] as string] = i;

export class InvalidSolanaAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSolanaAddressError";
  }
}

/**
 * Decodes a base58 string to bytes. Big-endian base-256 accumulation; leading '1's encode
 * leading zero bytes, which matters because a Solana pubkey may legitimately start with them.
 */
export function base58Decode(input: string): Uint8Array {
  if (input.length === 0) throw new InvalidSolanaAddressError("address is empty");

  // Starts EMPTY, not [0]. A [0] seed is harmless for non-zero values (the first iteration
  // overwrites it) but contributes a spurious extra byte when the decoded value is zero —
  // 32 leading '1's then decoded to 33 bytes instead of 32, which would have rejected a
  // legitimate leading-zero pubkey as malformed.
  const bytes: number[] = [];
  for (const char of input) {
    const value = INDEX[char];
    if (value === undefined) {
      throw new InvalidSolanaAddressError(
        `"${char}" is not a valid base58 character (0, O, I and l are excluded to avoid lookalikes)`,
      );
    }
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] as number) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Each leading '1' is one leading zero byte.
  for (const char of input) {
    if (char !== "1") break;
    bytes.push(0);
  }

  return Uint8Array.from(bytes.reverse());
}

/**
 * Decodes and validates a Solana address, returning exactly 32 bytes.
 *
 * Rejects anything that is not 32 bytes, and rejects the all-zero address (the Solana system
 * program / default pubkey — a real value that nobody controls, and a plausible paste error).
 */
export function solanaAddressToBytes32(address: string): Uint8Array {
  const trimmed = address.trim();
  if (trimmed === "") throw new InvalidSolanaAddressError("address is empty");

  const decoded = base58Decode(trimmed);
  if (decoded.length !== 32) {
    throw new InvalidSolanaAddressError(
      `a Solana address decodes to 32 bytes, this one decodes to ${decoded.length}`,
    );
  }
  if (decoded.every((b) => b === 0)) {
    throw new InvalidSolanaAddressError("that is the all-zero address; nobody controls it");
  }
  return decoded;
}

/**
 * An EVM address left-padded into 32 bytes has 12 leading zero bytes. A real Solana pubkey
 * has them with probability 2^-96. Mirrors the contract's `check_mint_recipient` so the user
 * gets a clear message in the browser instead of an opaque `MintRecipientShape` panic after
 * signing.
 */
export function looksLikeEvmAddress(bytes: Uint8Array): boolean {
  return bytes.length === 32 && bytes.slice(0, 12).every((b) => b === 0);
}

export interface AddressCheck {
  ok: boolean;
  bytes?: Uint8Array;
  error?: string;
}

/** Non-throwing form, for live validation as the user types. */
export function checkSolanaAddress(address: string): AddressCheck {
  if (address.trim() === "") return { ok: false };
  try {
    const bytes = solanaAddressToBytes32(address);
    if (looksLikeEvmAddress(bytes)) {
      return { ok: false, error: "That looks like an Ethereum address, not a Solana one." };
    }
    return { ok: true, bytes };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "That is not a valid Solana address.",
    };
  }
}

export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return `0x${out}`;
}
