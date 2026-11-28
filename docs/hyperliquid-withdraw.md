# Withdraw from Hyperliquid: what Hyperliquid's own button reaches

Checked 2026-11-28. This note is the reason for the copy on Xebra's "From: Hyperliquid" form.

## Hyperliquid's own Withdraw button, today

For **USDC**, the button at app.hyperliquid.xyz reaches four chains and the user's own HyperEVM address:

| Destination | Who carries it | Fee |
|---|---|---|
| Arbitrum | Circle CCTP (`sendToEvmWithData`, domain 3), or the legacy bridge (`withdraw3`) | flat 0.20 USDC (legacy: 1 USDC, ~5 min) |
| Base, Ethereum, Polygon | Across | the higher of 0.20 USDC or 0.05% |
| Your own HyperEVM address | Hyperliquid | none (HyperEVM gas) |

Other assets (BTC, ETH, SOL and some Solana tokens, MON, XPL, AVAX, ZEC) go out through Unit, a separate team, as
those assets. USDC to Solana, Avalanche, OP Mainnet, Arc, Monad, Sonic, World Chain, Unichain and the other CCTP
chains is not offered.

### Evidence

- **Hyperliquid's app code.** The production bundle (`app.hyperliquid.xyz/assets/…js`, fetched 2026-11-28) builds its
  one CCTP withdrawal with the destination fixed: `{type: "sendToEvmWithData", token: "USDC", sourceDex: spot ? "spot" :
  "", destinationRecipient: address.toLowerCase(), addressEncoding: "hex", destinationChainId: 3, gasLimit: 200000,
  data: "0x"}`. The only other withdraw action in the bundle is `withdraw3` (the legacy bridge, Arbitrum only). The
  bundle also links to Across's Hyperliquid fee page and to Unit's support page for the other assets.
- **Across's Hyperliquid fee page** (docs.across.to/hyperliquid/fees): withdrawals reach Arbitrum (flat 0.20 USDC),
  Base, Ethereum or Polygon (the higher of 0.20 USDC or 0.05%), and the user's own HyperEVM address. It also says
  HyperCore gas and the one-time activation fee "are paid separately from your account balance".
- **Hyperliquid's FAQ**: "You withdrew USDC over Arbitrum to your Phantom wallet but cannot find it… they are on the
  Arbitrum network"; BTC, ETH and SOL withdrawals are "managed by Unit".
- **Circle** (`cctp/howtos/withdraw-usdc-from-hypercore-to-evm`, `…-to-solana`): the same signed action can name any
  CCTP domain, Solana included, and Circle's Forwarding Service delivers it. Hyperliquid's app just does not offer it.

Not checked: the app's screens with a funded account (we read its code, not its rendered modal). The Across part is
an integration in Hyperliquid's app, so it can change without a Hyperliquid release note.

## What Xebra's copy leads with

- **Straight to 22 chains, Solana and Arc included** (every EVM chain Circle delivers to, 21 with Arc, plus Solana;
  the form counts them from the server's list). Hyperliquid's own button sends USDC to Arbitrum, Base, Ethereum and
  Polygon only.
- **Circle's own USDC, end to end.** No bridge in the middle: Circle burns it on HyperEVM and mints it on the chain
  you pick. One gas-free signature for the withdrawal, one for Xebra's fee.
- **The price, said honestly.** Circle takes 0.20 USDC to most chains (1.20 to Ethereum, 0.50 to Solana), Xebra
  0.01% + 0.01 USDC, plus Hyperliquid's one-time 1 USDC on an account's first withdrawal. To Arbitrum, Hyperliquid's
  own button is a cent cheaper; to Ethereum below about 2,600 USDC, Across through Hyperliquid's button is cheaper.
  We do not claim otherwise.

## Where it does not go (phase 1)

- **Stellar**: refused. Circle's Hyperliquid contract always burns with an open `destinationCaller` and its own hook
  layout; Stellar's forwarder needs both to name it, so USDC sent there would be stuck for good. A two-step path
  (Hyperliquid -> your HyperEVM wallet -> Xebra's EVM -> Stellar) is planned.
- **Sui, Aptos**: not yet. Circle does not deliver there, and nobody has shown that Hyperliquid accepts a 32-byte
  recipient for those domains. One 1 USDC test first.
- **Injective, Morph, Pharos**: not offered. Circle does not deliver there.
