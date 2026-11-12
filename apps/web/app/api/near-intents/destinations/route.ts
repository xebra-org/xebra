import * as oneclick from "../../../../lib/near-intents/oneclick";

/**
 * The destinations the demo offers: a short list of what people actually ask for, looked up in
 * NEAR Intents' live token list so an asset id is never stale. An entry Intents stops listing
 * simply drops out.
 */
export const dynamic = "force-dynamic";

const WANTED: { blockchain: string; symbol: string; chain: string; recipientHint: string }[] = [
  { blockchain: "near", symbol: "USDC", chain: "NEAR", recipientHint: "alice.near" },
  { blockchain: "near", symbol: "wNEAR", chain: "NEAR", recipientHint: "alice.near" },
  { blockchain: "sol", symbol: "USDC", chain: "Solana", recipientHint: "Solana address" },
  { blockchain: "sol", symbol: "SOL", chain: "Solana", recipientHint: "Solana address" },
  { blockchain: "arb", symbol: "USDC", chain: "Arbitrum", recipientHint: "0x address" },
  { blockchain: "eth", symbol: "ETH", chain: "Ethereum", recipientHint: "0x address" },
  { blockchain: "btc", symbol: "BTC", chain: "Bitcoin", recipientHint: "bc1 address" },
  { blockchain: "zec", symbol: "ZEC", chain: "Zcash", recipientHint: "t1 address" },
  { blockchain: "tron", symbol: "USDT", chain: "Tron", recipientHint: "T address" },
  { blockchain: "ton", symbol: "USDT", chain: "TON", recipientHint: "TON address" },
];

export interface Destination {
  assetId: string;
  symbol: string;
  chain: string;
  decimals: number;
  recipientHint: string;
}

export async function GET(): Promise<Response> {
  try {
    const list = await oneclick.tokens();
    const destinations: Destination[] = [];
    for (const w of WANTED) {
      const t = list.find((x) => x.blockchain === w.blockchain && x.symbol === w.symbol);
      if (t) {
        destinations.push({
          assetId: t.assetId,
          symbol: t.symbol,
          chain: w.chain,
          decimals: t.decimals,
          recipientHint: w.recipientHint,
        });
      }
    }
    return Response.json({ destinations }, { headers: { "cache-control": "s-maxage=300" } });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "NEAR Intents could not be reached." },
      { status: 502 },
    );
  }
}
