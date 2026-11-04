# @xebra/web

Next.js (App Router) app for the USDC routes over Circle's CCTP, deployed on Vercel. How a transfer
works is in the root [README](../../README.md); deploying is in
[`docs/deploying.md`](../../docs/deploying.md).

- `/` — the bridge. Stellar → Solana, Arc, and each EVM chain the wrapper has committed and
  `NEXT_PUBLIC_STELLAR_SENDS_TO` names, through wrapper v2, signed in Freighter
  (`components/bridge/stellar-bridge-form.tsx`). When the build switches them on
  (`NEXT_PUBLIC_ARC_SENDS_TO`, `NEXT_PUBLIC_ARC_RECEIVES_FROM`), Arc → EVM chains and Solana, and EVM
  chains → Arc, through Circle's `TokenMessengerV2` directly, or through Xebra's EVM fee wrapper
  where one is pinned and `NEXT_PUBLIC_ARC_USE_WRAPPER=1` (`components/bridge/evm-bridge-form.tsx`).
- `/claim` — completes a transfer whose forward failed, from the owner's wallet.
- `/admin` — console for the v2 wrapper ([`docs/admin-panel.md`](../../docs/admin-panel.md)).
- `/recover` — countersigns the rescue of a v1 burn that named a wallet instead of a token account
  (`scripts/recover-stranded-mint.mjs` builds the transactions).

Server routes in `app/api/`: `circle-health` (pre-flight), `delivery` (Circle's forward state for a
burn), `attestation`, `reattest`, `recipient` and `solana-rpc`. `convex/` holds the shared Iris rate
counter ([`convex/README.md`](./convex/README.md)). Wallets connect through one modal
(`components/wallet/`): Stellar Wallets Kit for Freighter, EIP-6963 for EVM wallets, the Wallet
Standard for Solana. There is no wagmi.

`lib/open-intent.ts` and `lib/build-open-intent-params.ts` are escrow-rail leftovers no page imports.

## Build

```bash
pnpm build
```

Writes to `.next-build`, so a production build cannot wipe the directory a running `next dev` is
serving from. Vercel runs `build:vercel` instead, which writes `.next`. Both run
`scripts/check-build-network.mjs` first, which refuses anything but a coherent mainnet configuration.

## Run

```bash
cp ../../.env.production.example ../../.env.production   # once; public mainnet constants
pnpm dev
```

This points at mainnet. Browsing is safe — quotes are read-only and nothing moves until a
signature — but a signed transaction spends real USDC.
