import { isAddress } from "viem";
import type { EvmChain } from "../chains/evm.js";
import type { AddressCheck } from "./solana.js";

/**
 * Validation for a recipient on an EVM chain, whichever one the dollars land on.
 *
 * The same stakes as `solana-address.ts`: the mint goes to whatever this produces, a CCTP burn is
 * irreversible, and the Stellar wrapper can only check the *shape* (`check_mint_recipient` accepts
 * any non-zero, left-padded 20-byte value). On the routes that call Circle directly there is no
 * contract checking even that. Neither can tell a wallet from a mistake; that is this file's job.
 *
 * # What it refuses beyond "is it hex"
 *
 *   - **A bad checksum.** A mixed-case address carries an EIP-55 checksum; one that fails it has a
 *     typo in it, and would otherwise be a perfectly valid address that nobody controls. An
 *     all-lowercase or all-uppercase address has no checksum to fail and is accepted, because
 *     refusing what most explorers and wallets copy would be its own failure.
 *   - **Addresses that can never hold a balance for a person:** the zero address, the low
 *     "precompile" range and burn addresses like `0x…dEaD`, and the contracts USDC itself would
 *     be minted *into* on that chain — the USDC token, and Circle's messenger, transmitter and
 *     minter. A mint to any of these is unrecoverable, and each is a plausible paste from an
 *     explorer page.
 *
 * It does not, and cannot, check that the recipient is a wallet rather than a contract that
 * refuses tokens, or that USDC's blocklist does not hold it. Both make the mint revert; the burn
 * is already done by then, which is what `/claim` exists for.
 */

const EVM_HEX = /^0x[0-9a-fA-F]{40}$/;
/** A Solana pubkey is 32–44 base58 characters. */
const LOOKS_LIKE_SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface EvmAddressRules {
  /** As it reads in a sentence: "Arc", "Base". */
  chainName: string;
  /** Lower-cased address to what it is, for addresses a mint could never be recovered from. */
  unsafe: Record<string, string>;
}

const article = (name: string) => (/^[AEIOU]/.test(name) ? "an" : "a");

export function checkEvmAddress(input: string, rules: EvmAddressRules): AddressCheck {
  const address = input.trim();
  if (address === "") return { ok: false };
  const { chainName } = rules;

  if (!address.startsWith("0x") && LOOKS_LIKE_SOLANA.test(address)) {
    return {
      ok: false,
      error: `That looks like a Solana address, not ${article(chainName)} ${chainName} one.`,
    };
  }
  if (!EVM_HEX.test(address)) {
    const a = article(chainName);
    return {
      ok: false,
      error: `${a[0]?.toUpperCase()}${a.slice(1)} ${chainName} address is 0x followed by 40 hex characters.`,
    };
  }

  const body = address.slice(2);
  const mixedCase = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixedCase && !isAddress(address, { strict: true })) {
    return {
      ok: false,
      error: "The checksum does not match. There is a typo in this address — check it again.",
    };
  }

  const lower = address.toLowerCase();
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 20; i++) {
    bytes[12 + i] = Number.parseInt(lower.slice(2 + i * 2, 4 + i * 2), 16);
  }

  if (bytes.every((b) => b === 0)) {
    return { ok: false, error: "That is the zero address; nobody controls it." };
  }
  // Twelve padding bytes plus six more: an address below 2^112. Precompiles live here, and so
  // does 0x…dEaD.
  if (bytes.slice(0, 18).every((b) => b === 0)) {
    return {
      ok: false,
      error: "That is a system or burn address, not a wallet. USDC sent there is gone.",
    };
  }
  const unsafe = rules.unsafe[lower];
  if (unsafe) {
    return { ok: false, error: `That is ${unsafe}. USDC minted there could never be recovered.` };
  }

  return { ok: true, bytes };
}

/** The contracts USDC would be minted *into* on `chain`: the token, and Circle's three. */
export function unsafeRecipientsFor(chain: EvmChain): Record<string, string> {
  return {
    [chain.usdcAddress.toLowerCase()]: "the USDC token contract itself",
    [chain.tokenMessengerAddress.toLowerCase()]: "Circle's TokenMessenger contract",
    [chain.messageTransmitterAddress.toLowerCase()]: "Circle's MessageTransmitter contract",
    [chain.tokenMinterAddress.toLowerCase()]: "Circle's TokenMinter contract",
  };
}

export function checkAddressOn(chain: EvmChain, input: string): AddressCheck {
  return checkEvmAddress(input, { chainName: chain.name, unsafe: unsafeRecipientsFor(chain) });
}
