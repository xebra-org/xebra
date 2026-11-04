"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WalletProvider } from "../components/wallet/wallet-provider";

/**
 * `WagmiProvider` used to wrap this tree. It has been removed.
 *
 * Wagmi existed solely for corridor 1 (Arc, an EVM chain) at a time when the product was a USDC
 * bridge from Stellar to Solana alone. The Stellar flow uses Stellar Wallets Kit and never
 * touched wagmi. EVM chains are sources now, and still without it: `lib/evm-rpc.ts` is the few
 * JSON-RPC calls that takes, made on the wallet's own EIP-1193 provider.
 *
 * Keeping it was actively harmful. Wagmi requires at least one chain, and with the Arc
 * variables unset the config fell back to a fabricated chain with `rpcUrls.default.http: []`
 * and `transports: { 1: http() }` — and `http()` with no URL resolves to
 * `rpcUrls.default.http[0]`, i.e. `undefined`. That is a provider that cannot serve a single
 * request, mounted on every page, in service of a chain the product does not use.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <WalletProvider>{children}</WalletProvider>
    </QueryClientProvider>
  );
}
