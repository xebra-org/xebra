import { type AddressCheck, looksLikeEvmAddress } from "./solana.js";

/**
 * A Sui address as a CCTP `mintRecipient`: the 32 bytes themselves. Circle's Sui mint pays the
 * USDC to that address directly; there is no token account to derive.
 *
 * Refused, besides anything that is not `0x` and 64 hex characters:
 *   - an EVM address (`0x` and 40 hex), the likeliest thing to be pasted by mistake;
 *   - an address whose first 12 bytes are zero. Those are Sui's system objects (`0x2`, `0x6`, ...),
 *     never a person's wallet, and the Stellar wrapper refuses that shape for a non-EVM domain
 *     anyway (`MintRecipientShape`), so it is said here instead of at signing.
 */
export function checkSuiAddress(input: string): AddressCheck {
  const value = input.trim();
  if (value === "") return { ok: false };
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return { ok: false, error: "That looks like an EVM address, not a Sui one." };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    return { ok: false, error: "A Sui address is 0x followed by 64 hex characters." };
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(value.slice(2 + i * 2, 4 + i * 2), 16);
  if (looksLikeEvmAddress(bytes)) {
    return { ok: false, error: "That is a Sui system address, not a wallet." };
  }
  return { ok: true, bytes };
}
