/**
 * Server-side switches for the Sui to Stellar page. All read at request time, so turning the feature
 * on or off, or changing the cap, is a Vercel env change and a redeploy, not a rebuild of the bundle.
 *
 *  - `SUI_STELLAR_ENABLED=true`  the page and its routes answer; anything else and they 404.
 *  - `SUI_STELLAR_MAX_USDC`      per-transfer cap enforced when the burn is built (default 10).
 *  - `SUI_STELLAR_RELAYER_SECRET` the funded Stellar account that pays the fee to complete a burn.
 *                                 Without it the page still builds burns, but nothing completes them.
 *  - `SUI_RPC_URL`               Sui fullnode (gRPC-web). Defaults to Mysten's public mainnet node.
 */
export function suiStellarEnabled(): boolean {
  return process.env.SUI_STELLAR_ENABLED === "true";
}

export function maxUsdcBase(): bigint {
  const raw = Number(process.env.SUI_STELLAR_MAX_USDC ?? "10");
  const usdc = Number.isFinite(raw) && raw > 0 ? raw : 10;
  return BigInt(Math.round(usdc * 1_000_000));
}

export function relayerSecret(): string | null {
  const v = process.env.SUI_STELLAR_RELAYER_SECRET?.trim();
  return v ? v : null;
}

export function suiRpcUrl(): string {
  return process.env.SUI_RPC_URL?.trim() || "https://fullnode.mainnet.sui.io:443";
}

export function notFound(): Response {
  return Response.json({ error: "not available" }, { status: 404 });
}
