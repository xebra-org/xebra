import type { IntentsToken } from "@xebra/sdk/intents";

/**
 * The destinations /near-intents offers: what people ask for, looked up in NEAR Intents' live token
 * list so an asset id is never stale. An entry Intents stops listing simply drops out.
 *
 * Every entry is delivered by NEAR Intents, not by Circle: Xebra's CCTP leg ends at a 1Click
 * deposit address on Base, and NEAR Intents' solvers and bridges carry it the rest of the way. The
 * chains Circle's CCTP does not reach are in `NON_CCTP_BLOCKCHAINS`; each one quoted from Base USDC
 * on 2026-11-28 (evidence in docs/near-intents-destinations.md).
 */
export interface WantedDestination {
  /** 1Click's `blockchain` name. */
  blockchain: string;
  /** 1Click's `symbol`, matched exactly, so a retired "(DEPRECATED)" asset never matches. */
  symbol: string;
  /** The chain as people call it. */
  chain: string;
  /** Placeholder for the recipient field. */
  recipientHint: string;
  /** A warning shown under the recipient field, where a wrong kind of address loses money. */
  note?: string;
}

const NO_TAG =
  "Use an XRP wallet you control. NEAR Intents can't add a destination tag, so an exchange deposit that asks for one won't be credited.";
const NO_MEMO =
  "Use a TON wallet you control. NEAR Intents can't add a memo (comment), so an exchange deposit that asks for one won't be credited.";

export const WANTED: readonly WantedDestination[] = [
  // Offered since the page opened (2026-11-12), kept in front in the same order.
  { blockchain: "near", symbol: "USDC", chain: "NEAR", recipientHint: "alice.near" },
  { blockchain: "near", symbol: "wNEAR", chain: "NEAR", recipientHint: "alice.near" },
  { blockchain: "sol", symbol: "USDC", chain: "Solana", recipientHint: "Solana address" },
  { blockchain: "sol", symbol: "SOL", chain: "Solana", recipientHint: "Solana address" },
  { blockchain: "arb", symbol: "USDC", chain: "Arbitrum", recipientHint: "0x address" },
  { blockchain: "eth", symbol: "ETH", chain: "Ethereum", recipientHint: "0x address" },
  { blockchain: "btc", symbol: "BTC", chain: "Bitcoin", recipientHint: "bc1 address" },
  { blockchain: "zec", symbol: "ZEC", chain: "Zcash", recipientHint: "t1 address" },
  { blockchain: "tron", symbol: "USDT", chain: "Tron", recipientHint: "T address" },
  { blockchain: "ton", symbol: "USDT", chain: "TON", recipientHint: "TON address", note: NO_MEMO },
  // Added 2026-11-28: chains Circle's CCTP does not reach, stablecoins first.
  { blockchain: "bsc", symbol: "USDT", chain: "BNB Chain", recipientHint: "0x address" },
  { blockchain: "gnosis", symbol: "USDC", chain: "Gnosis", recipientHint: "0x address" },
  { blockchain: "bera", symbol: "USDT0", chain: "Berachain", recipientHint: "0x address" },
  { blockchain: "scroll", symbol: "USDT", chain: "Scroll", recipientHint: "0x address" },
  { blockchain: "hood", symbol: "USDG", chain: "Robinhood Chain", recipientHint: "0x address" },
  { blockchain: "aleo", symbol: "USDCx", chain: "Aleo", recipientHint: "aleo1 address" },
  {
    blockchain: "xrp",
    symbol: "XRP",
    chain: "XRP Ledger",
    recipientHint: "r address",
    note: NO_TAG,
  },
  { blockchain: "cardano", symbol: "ADA", chain: "Cardano", recipientHint: "addr1 address" },
  { blockchain: "doge", symbol: "DOGE", chain: "Dogecoin", recipientHint: "D address" },
  { blockchain: "ltc", symbol: "LTC", chain: "Litecoin", recipientHint: "L, M or ltc1 address" },
  {
    blockchain: "bch",
    symbol: "BCH",
    chain: "Bitcoin Cash",
    recipientHint: "bitcoincash:q address",
  },
  { blockchain: "dash", symbol: "DASH", chain: "Dash", recipientHint: "X address" },
  { blockchain: "fogo", symbol: "FOGO", chain: "Fogo", recipientHint: "Fogo address" },
  { blockchain: "adi", symbol: "ADI", chain: "ADI Chain", recipientHint: "0x address" },
];

/**
 * The offered chains Circle's CCTP does not reach. They count toward "chains in total", never
 * toward "chains on Circle's own rails": NEAR Intents delivers them.
 */
export const NON_CCTP_BLOCKCHAINS: ReadonlySet<string> = new Set([
  "near",
  "btc",
  "zec",
  "tron",
  "ton",
  "bsc",
  "gnosis",
  "bera",
  "scroll",
  "hood",
  "aleo",
  "xrp",
  "cardano",
  "doge",
  "ltc",
  "bch",
  "dash",
  "fogo",
  "adi",
]);

export interface Destination {
  assetId: string;
  symbol: string;
  chain: string;
  decimals: number;
  recipientHint: string;
  note?: string;
}

/** The offered destinations 1Click lists right now, with their live asset ids. */
export function pickDestinations(list: readonly IntentsToken[]): Destination[] {
  const out: Destination[] = [];
  for (const w of WANTED) {
    const t = list.find((x) => x.blockchain === w.blockchain && x.symbol === w.symbol);
    if (!t) continue;
    out.push({
      assetId: t.assetId,
      symbol: t.symbol,
      chain: w.chain,
      decimals: t.decimals,
      recipientHint: w.recipientHint,
      ...(w.note ? { note: w.note } : {}),
    });
  }
  return out;
}
