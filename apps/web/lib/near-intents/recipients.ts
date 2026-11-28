import {
  base58,
  base58xrp,
  base64,
  base64url,
  bech32,
  bech32m,
  createBase58check,
} from "@scure/base";
import { isAddress, sha256 as viemSha256 } from "viem";

/**
 * Who can receive on each chain NEAR Intents delivers to, checked before the user signs.
 *
 * 1Click checks most recipients itself and answers "recipient is not valid", but not all: on
 * 2026-11-28 it quoted a Dogecoin address with a broken checksum, and it answers a bare "Internal
 * server error" for an XRP address that carries a destination tag. A swap to a bad address is
 * refunded at best, so Xebra checks the format and checksum itself and says in plain words what
 * is wrong. 1Click's own check still runs after this one.
 *
 * Keys are 1Click's `blockchain` names. A chain with no rule here is refused, never sent blind.
 */

const sha256 = (data: Uint8Array): Uint8Array => viemSha256(data, "bytes");
const base58check = createBase58check(sha256);

/** The version bytes of a Base58Check address, or null if it is not one (bad checksum included). */
function base58checkVersion(
  s: string,
  versionLength: number,
  payloadLength: number,
): number | null {
  try {
    const bytes = base58check.decode(s);
    if (bytes.length !== versionLength + payloadLength) return null;
    let v = 0;
    for (let i = 0; i < versionLength; i++) v = (v << 8) | (bytes[i] ?? 0);
    return v;
  } catch {
    return null;
  }
}

/** A Base58Check address (20-byte hash) with one of `versions`. */
function legacy(s: string, versions: number[], versionLength = 1): boolean {
  const v = base58checkVersion(s, versionLength, 20);
  return v !== null && versions.includes(v);
}

/** A native SegWit address (BIP-173 / BIP-350) for `hrp`. */
function segwit(s: string, hrp: string): boolean {
  if (!s.toLowerCase().startsWith(`${hrp}1`)) return false;
  for (const coder of [bech32, bech32m]) {
    try {
      const { prefix, words } = coder.decode(s as `${string}1${string}`);
      if (prefix !== hrp || words.length === 0) continue;
      const version = words[0] as number;
      const program = coder.fromWords(words.slice(1));
      // v0 uses bech32 and a 20- or 32-byte program; v1 and later use bech32m.
      if (version === 0)
        return coder === bech32 && (program.length === 20 || program.length === 32);
      if (version > 16 || coder !== bech32m) return false;
      return (
        program.length >= 2 && program.length <= 40 && (version !== 1 || program.length === 32)
      );
    } catch {
      // try the other checksum
    }
  }
  return false;
}

/** A classic XRP Ledger account: Base58Check in Ripple's alphabet, version 0, 20 bytes. */
function xrpClassic(s: string): boolean {
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s)) return false;
  try {
    const bytes = base58xrp.decode(s);
    if (bytes.length !== 25 || bytes[0] !== 0) return false;
    const check = sha256(sha256(bytes.slice(0, 21)));
    return check.slice(0, 4).every((b, i) => b === bytes[21 + i]);
  } catch {
    return false;
  }
}

const CASHADDR_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const CASHADDR_GENERATORS = [
  0x98f2bc8e61n,
  0x79b76d99e2n,
  0xf33e5fb3c4n,
  0xae2eabe2a8n,
  0x1e4f43e470n,
];

function cashaddrPolymod(values: number[]): bigint {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) {
      if ((c0 >> BigInt(i)) & 1n) c ^= CASHADDR_GENERATORS[i] as bigint;
    }
  }
  return c ^ 1n;
}

/**
 * A Bitcoin Cash pay-to-key address in CashAddr form, with or without its `bitcoincash:` prefix.
 * The old Base58 form is refused on purpose: it is also a valid Bitcoin address, the commonest
 * way to paste the wrong chain's address.
 */
function cashaddr(input: string): boolean {
  if (input !== input.toLowerCase() && input !== input.toUpperCase()) return false;
  const s = input.toLowerCase();
  const [prefix, payload] = s.includes(":") ? s.split(":", 2) : ["bitcoincash", s];
  if (prefix !== "bitcoincash" || !payload) return false;
  const words: number[] = [];
  for (const ch of payload) {
    const w = CASHADDR_CHARSET.indexOf(ch);
    if (w < 0) return false;
    words.push(w);
  }
  if (words.length <= 8) return false;
  const prefixWords = [...prefix].map((ch) => ch.charCodeAt(0) & 0x1f);
  if (cashaddrPolymod([...prefixWords, 0, ...words]) !== 0n) return false;
  try {
    const bytes = bech32.fromWords(words.slice(0, -8));
    // Version byte 0: pay-to-key ("q"), 20-byte hash.
    return bytes.length === 21 && bytes[0] === 0;
  } catch {
    return false;
  }
}

/** CRC-16/XMODEM, the checksum of a user-friendly TON address. */
function crc16(data: Uint8Array): number {
  let reg = 0;
  for (const b of data) {
    reg ^= b << 8;
    for (let i = 0; i < 8; i++) {
      reg = reg & 0x8000 ? ((reg << 1) ^ 0x1021) & 0xffff : (reg << 1) & 0xffff;
    }
  }
  return reg;
}

/** A TON mainnet address: user-friendly (EQ.../UQ..., checksum checked) or raw (`0:` + 64 hex). */
function ton(s: string): boolean {
  if (/^(0|-1):[0-9a-fA-F]{64}$/.test(s)) return true;
  if (s.length !== 48) return false;
  let bytes: Uint8Array;
  try {
    bytes = /[-_]/.test(s) ? base64url.decode(s) : base64.decode(s);
  } catch {
    return false;
  }
  if (bytes.length !== 36) return false;
  // 0x11 bounceable, 0x51 non-bounceable. The 0x80 bit marks a testnet address: refused.
  if (bytes[0] !== 0x11 && bytes[0] !== 0x51) return false;
  if (bytes[1] !== 0x00 && bytes[1] !== 0xff) return false;
  const crc = crc16(bytes.slice(0, 34));
  return bytes[34] === crc >> 8 && bytes[35] === (crc & 0xff);
}

/** A Cardano mainnet payment address (Shelley `addr1...`: base, pointer or enterprise). */
function cardano(s: string): boolean {
  try {
    const { prefix, words } = bech32.decode(s as `${string}1${string}`, 200);
    if (prefix !== "addr") return false;
    const bytes = bech32.fromWords(words);
    const header = bytes[0] ?? 0xff;
    const type = header >> 4;
    if ((header & 0x0f) !== 1) return false; // network 1 = mainnet
    if (type <= 3) return bytes.length === 57;
    if (type <= 5) return bytes.length > 29 && bytes.length <= 64;
    if (type <= 7) return bytes.length === 29;
    return false;
  } catch {
    return false;
  }
}

/** An Aleo account address: bech32m, `aleo1`, 32 bytes. */
function aleo(s: string): boolean {
  try {
    const { prefix, words } = bech32m.decode(s as `${string}1${string}`);
    return prefix === "aleo" && bech32m.fromWords(words).length === 32;
  } catch {
    return false;
  }
}

/** A NEAR account: a named account (alice.near), an implicit one (64 hex), or an EVM-style one. */
function near(s: string): boolean {
  if (/^[0-9a-f]{64}$/.test(s) || /^0x[0-9a-f]{40}$/.test(s)) return true;
  return (
    s.length >= 2 &&
    s.length <= 64 &&
    /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s)
  );
}

/** A Solana-style (SVM) public key: base58, 32 bytes. */
function svm(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return base58.decode(s).length === 32;
  } catch {
    return false;
  }
}

export interface RecipientRule {
  /** The sentence shown when the recipient is not an address on this chain. */
  invalid: string;
  valid(recipient: string): boolean;
  /** A more specific sentence for a known near miss, checked first. */
  nearMiss?(recipient: string): string | null;
}

function evm(name: string): RecipientRule {
  return {
    invalid: `That isn't a ${name} address. ${name} addresses start with 0x and have 40 more letters and numbers.`,
    valid: (r) => isAddress(r),
    nearMiss: (r) =>
      /^0x[0-9a-fA-F]{40}$/.test(r) && !isAddress(r)
        ? "That 0x address has a typo: its capital letters don't match its checksum. Copy it again from the wallet."
        : null,
  };
}

export const RECIPIENT_RULES: Record<string, RecipientRule> = {
  near: {
    invalid:
      "That isn't a NEAR account. NEAR accounts look like alice.near, or are 64 letters and numbers.",
    valid: near,
  },
  sol: {
    invalid: "That isn't a Solana address. Solana addresses are 32 to 44 letters and numbers.",
    valid: svm,
  },
  fogo: {
    invalid:
      "That isn't a Fogo address. Fogo uses Solana-style addresses: 32 to 44 letters and numbers.",
    valid: svm,
  },
  arb: evm("Arbitrum"),
  eth: evm("Ethereum"),
  bsc: evm("BNB Chain"),
  gnosis: evm("Gnosis"),
  bera: evm("Berachain"),
  scroll: evm("Scroll"),
  hood: evm("Robinhood Chain"),
  adi: evm("ADI Chain"),
  btc: {
    invalid: "That isn't a Bitcoin address. Bitcoin addresses start with 1, 3 or bc1.",
    valid: (r) => legacy(r, [0x00, 0x05]) || segwit(r, "bc"),
  },
  ltc: {
    invalid: "That isn't a Litecoin address. Litecoin addresses start with L, M or ltc1.",
    valid: (r) => legacy(r, [0x30, 0x32]) || segwit(r, "ltc"),
  },
  // 1Click refuses Dogecoin script addresses (9... and A...), so only D... is offered.
  doge: {
    invalid: "That isn't a Dogecoin address. Dogecoin addresses start with D.",
    valid: (r) => legacy(r, [0x1e]),
  },
  dash: {
    invalid: "That isn't a Dash address. Dash addresses start with X or 7.",
    valid: (r) => legacy(r, [0x4c, 0x10]),
  },
  bch: {
    invalid:
      "That isn't a Bitcoin Cash address. Bitcoin Cash addresses start with bitcoincash:q, or just q.",
    valid: cashaddr,
    nearMiss: (r) =>
      legacy(r, [0x00, 0x05])
        ? "That looks like an old-style address, which Bitcoin uses too. Copy the address that starts with bitcoincash:q from the Bitcoin Cash wallet instead."
        : null,
  },
  zec: {
    invalid:
      "That isn't a Zcash address NEAR Intents can pay. Use a transparent address: it starts with t1 or t3.",
    valid: (r) => legacy(r, [0x1cb8, 0x1cbd], 2),
  },
  xrp: {
    invalid: "That isn't an XRP address. XRP addresses start with r.",
    valid: xrpClassic,
    nearMiss: (r) =>
      /^[XT][1-9A-HJ-NP-Za-km-z]{46}$/.test(r)
        ? "That address has a destination tag built in (it starts with X). NEAR Intents can't deliver to a destination tag yet, so use the r address of an XRP wallet you control."
        : null,
  },
  cardano: {
    invalid: "That isn't a Cardano address. Cardano addresses start with addr1.",
    valid: cardano,
    nearMiss: (r) =>
      r.startsWith("stake1")
        ? "That's a Cardano stake address. Paste the payment address instead: it starts with addr1."
        : null,
  },
  aleo: {
    invalid:
      "That isn't an Aleo address. Aleo addresses start with aleo1 and are 63 characters long.",
    valid: aleo,
  },
  tron: {
    invalid: "That isn't a Tron address. Tron addresses start with T.",
    valid: (r) => base58checkVersion(r, 1, 20) === 0x41,
  },
  ton: {
    invalid:
      "That isn't a TON address. TON addresses start with UQ or EQ and are 48 characters long.",
    valid: ton,
  },
};

/**
 * Why `recipient` cannot receive on `blockchain` (1Click's name for the chain), in a sentence for
 * the person typing it, or null when it can.
 */
export function recipientProblem(blockchain: string, recipient: string): string | null {
  const r = recipient.trim();
  if (!r) return "Enter who receives.";
  const rule = Object.hasOwn(RECIPIENT_RULES, blockchain) ? RECIPIENT_RULES[blockchain] : undefined;
  if (!rule) return "Xebra doesn't send to that chain through NEAR Intents yet.";
  const miss = rule.nearMiss?.(r);
  if (miss) return miss;
  return rule.valid(r) ? null : rule.invalid;
}
