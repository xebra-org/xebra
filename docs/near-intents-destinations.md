# NEAR Intents destinations

What `/near-intents` offers as "You get", why each entry is there, and the evidence that it worked on the day it
was added. The list lives in `apps/web/lib/near-intents/destinations.ts` (`WANTED`); the recipient checks in
`apps/web/lib/near-intents/recipients.ts` and, for XRP, `xrpl.ts`.

## Who delivers what

Every destination on this page is delivered by **NEAR Intents**, not by Circle. Xebra's part ends when Circle mints
USDC into the 1Click deposit address on Base; from there NEAR Intents' solvers and bridges (POA, Omni, HOT) carry it
to the far chain, and their rules and refunds apply.

So count them honestly:

- **29 chains on Circle's own rails** (CCTP), as Xebra serves them today.
- **19 more through NEAR Intents** (the table below), chains CCTP does not reach.
- **48 in total.** Say "29 chains on Circle's own rails, 48 in total with NEAR Intents", never "48 chains over
  CCTP". The research's longer count ("31 on Circle's rails, 79 in total") adds HyperCore, Starknet, xReserve and
  Relay, none of which is built yet.

## Evidence, 2026-11-28

Method: `GET https://1click.chaindefuser.com/v0/tokens` (234 assets on 39 chains at 12:46 UTC), then one
`POST /v0/quote` per asset with `dry: true`, `swapType: EXACT_INPUT`, origin **USDC on Base**
(`nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near`), amount **25 USDC** (`25000000`),
`slippageTolerance: 100`, `referral: xebra`, no API key. A dry quote reserves nothing and issues no deposit address.
Nothing was signed or sent.

| Chain | Asset | 1Click asset id | amountOut (base units) | Formatted | USD | Time estimate | Quoted (UTC) |
|---|---|---|---|---|---|---|---|
| XRP Ledger | XRP | `nep141:xrp.omft.near` | 26522730 | 26.52273 XRP | 24.93 | 70 s | 12:47:23 |
| Dogecoin | DOGE | `nep141:doge.omft.near` | 44000603434 | 440.00603434 DOGE | 24.91 | 177 s | 12:47:25 |
| Litecoin | LTC | `nep141:ltc.omft.near` | 56680997 | 0.56680997 LTC | 24.94 | 177 s | 12:47:26 |
| Bitcoin Cash | BCH | `nep141:bch.omft.near` | 12115237 | 0.12115237 BCH | 24.91 | 152 s | 12:47:28 |
| Dash | DASH | `nep141:dash.omft.near` | 70545127 | 0.70545127 DASH | 24.92 | 177 s | 12:47:29 |
| Cardano | ADA | `nep141:cardano.omft.near` | 170348698 | 170.348698 ADA | 24.90 | 52 s | 12:47:30 |
| BNB Chain | USDT | `nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near` | 24979666923139922868 | 24.9797 USDT | 24.96 | 38 s | 12:47:31 |
| Gnosis | USDC | `nep141:gnosis-0x2a22f9c3b484c3629090feed35f17ff8f88f76f0.omft.near` | 24992413 | 24.992413 USDC | 24.98 | 41 s | 12:47:33 |
| Berachain | USDT0 | `nep141:bera-0x779ded0c9e1022225f8e0630b35a9b54be713736.omft.near` | 24958396 | 24.958396 USDT0 | 24.93 | 40 s | 12:47:34 |
| Scroll | USDT | `nep245:v2_1.omni.hot.tg:534352_4RG3Q2wFsMQmd45m5m89RjsLfupA` | 24961342 | 24.961342 USDT | 24.94 | 39 s | 12:47:35 |
| Robinhood Chain | USDG | `nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near` | 24857476 | 24.857476 USDG | 24.86 | 36 s | 12:47:37 |
| ADI Chain | ADI | `nep245:v2_1.omni.hot.tg:36900_11111111111111111111` | 3421364456784038885 | 3.4214 ADI | 24.50 | 39 s | 12:47:38 |
| Fogo | FOGO | `nep141:fogo.omdep.near` | 17308444162897 | 17308.444 FOGO | 24.87 | 34 s | 12:47:40 |
| Aleo | USDCx | `nep141:aleo-usdcx.omft.near` | 24682602 | 24.682602 USDCx | 24.67 | 47 s | 12:47:41 |
| NEAR | USDC | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | 24993138 | 24.993138 USDC | 24.98 | 35 s | 12:47:43 |
| Bitcoin | BTC | `nep141:btc.omft.near` | 40227 | 0.00040227 BTC | 23.81 | 480 s | 12:47:44 |
| Zcash | ZEC | `nep141:zec.omft.near` | 3434041 | 0.03434041 ZEC | 24.66 | 150 s | 12:47:46 |
| Tron | USDT | `nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near` | 23442829 | 23.442829 USDT | 23.43 | 90 s | 12:47:47 |
| TON | USDT | `nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR` | 24969242 | 24.969242 USDT | 24.95 | 92 s | 12:47:49 |

NEAR, Bitcoin, Zcash, Tron and TON were offered before; the other 14 are new. NEAR also offers wNEAR, and the
page still offers Solana USDC/SOL, Arbitrum USDC and Ethereum ETH (chains CCTP also reaches).

`amountOut` is after NEAR Intents' spread and without Xebra's leg, which adds Circle's delivery fee into Base and
Xebra's 0.01% (at least 0.01 USDC). Time estimates are 1Click's, counted from the deposit.

### Checked and left out

| Chain | Asset | 1Click answered | Why it is not offered |
|---|---|---|---|
| Abstract | ETH | `recipient is not valid` for every EVM address tried (lower case and checksummed) | the format it wants is unknown |
| Movement | USDCx | `No liquidity available` | nothing to quote |
| Miden | USDCX | `recipient is not valid` | address format undocumented |
| PRL, QTC | native | `recipient is not valid` | address format unknown |

### Origin: Base, not Stellar

On 2026-11-28 quotes with **USDC on Stellar as the origin** were answering "Internal server error", while quotes
with USDC on Base worked. That does not affect this route: Xebra's CCTP leg delivers to Base and the 1Click quote
starts there (`viaXebra` in `plan.ts`). It only affects the "straight into NEAR Intents" comparison for a Stellar
sender, which already showed no quote for most pairs.

## Minimums

Probed the same way at 1 and 5 USDC on 2026-11-28:

- **Bitcoin:** 1 USDC answered `Amount is too low for bridge, try at least 4981100` (4.98 USDC). 5 USDC quoted
  0.00006518 BTC ($3.86): Bitcoin's fixed cost is about $1.15 at that size.
- **Tron:** 1 USDC answered `try at least 2575200` (2.58 USDC). 5 USDC quoted 3.44974 USDT: a fixed cost of about
  1.55 USDT per delivery.
- **Everything else quoted at 1 USDC.** Fixed costs show at small sizes: ADI about $0.28, Aleo $0.30, Zcash $0.24,
  Robinhood Chain $0.08 at 1 USDC.
- **XRP:** an account that does not exist yet needs the ledger's reserve (1 XRP, read from `server_state`
  `reserve_base` = 1000000 drops) in its first payment. Xebra refuses a quote whose `minAmountOut` is below it.

The page now says these in USDC: "NEAR Intents needs at least 4.9811 USDC for this destination. Send more."

## Recipients: formats, memos and tags

1Click takes a single `recipient` string. Its API says "destination routing metadata, when required, must be
encoded according to the destination chain address format", but for XRP that does not work today:

- **XRP destination tags are not supported.** An X-address (which carries the tag) answered
  `Internal server error`, with or without a tag; `r…?dt=123` and `r…:123` answered `recipient is not valid`.
  So only plain `r` addresses are offered, and Xebra also reads the account on the XRP Ledger: an account with
  the "require destination tag" flag (exchanges set it; Binance's `rEb8TK3…DuaLh` reads `Flags: 131072` today)
  or "deposit auth" is refused with a sentence saying why. An exchange that needs a tag without setting the flag
  cannot be detected, so the page warns under the field.
- **TON comments (memos) are not supported** either; the page warns that an exchange deposit asking for one will
  not be credited.
- No other offered chain uses a memo for ordinary wallets.

What Xebra accepts, checked before anything is quoted (`recipients.ts`):

| Chain | Accepted | Checked | 1Click's own check (probed 2026-11-28) |
|---|---|---|---|
| XRP Ledger | `r…` | Base58Check, Ripple alphabet | rejects bad checksums; X-address = "Internal server error" |
| Dogecoin | `D…` | Base58Check, version 0x1e | **quoted a `D…` address with a broken checksum**; rejects `9…`/`A…` |
| Litecoin | `L…`, `M…`, `ltc1…` | Base58Check / bech32 | rejects bad checksums |
| Bitcoin Cash | `bitcoincash:q…`, `q…` | CashAddr checksum | rejects bad checksums; also takes old `1…` addresses, which Xebra refuses (they are valid Bitcoin addresses too) |
| Dash | `X…`, `7…` | Base58Check | rejects bad checksums |
| Cardano | `addr1…` (base, pointer, enterprise) | bech32, mainnet header | rejects `stake1…` and Byron `Ae2…` |
| Aleo | `aleo1…` | bech32m, 32 bytes | also rejects off-curve keys |
| EVM (BNB Chain, Gnosis, Berachain, Scroll, Robinhood Chain, ADI Chain, Arbitrum, Ethereum) | `0x` + 40 hex | EIP-55 when mixed case | |
| Fogo, Solana | base58, 32 bytes | | rejects the all-zero key |
| Bitcoin | `1…`, `3…`, `bc1q…`, `bc1p…` | Base58Check / bech32 / bech32m | |
| Zcash | `t1…`, `t3…` | Base58Check, 2-byte version | shielded not tried |
| Tron | `T…` | Base58Check, version 0x41 | |
| TON | `UQ…`/`EQ…`, `0:<hex>` | CRC16 | |
| NEAR | `alice.near`, 64 hex, `0x` + 40 hex | NEAR account rules | a named account must exist |

When 1Click still answers `recipient is not valid`, the page shows the chain's own sentence instead.

## Keeping it true

`apps/web/lib/near-intents/destinations.live.test.ts` dry-quotes every entry the same way, with one sample
recipient per chain. It is off by default because it calls NEAR Intents' public API:

```sh
XEBRA_LIVE_TESTS=1 pnpm --filter @xebra/web exec vitest run destinations.live
```

Run it before changing `WANTED`, and when a destination starts failing for people. A failure means 1Click stopped
listing or quoting the asset or stopped accepting that address format.
