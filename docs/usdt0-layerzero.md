# USDT0 on Stellar (LayerZero)

Research only. Nothing here is built or switched on. Gathered 2026-10-22 from the Stellar and LayerZero
docs and usdt0.to; **none of it was run**.

## Addresses (Stellar mainnet)

| Item | Value |
|---|---|
| LayerZero eid | 30600 |
| OFT (call `quote_send` / `send`) | `CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6` |
| Stellar Asset Contract | `CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF` |
| Classic asset | `USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q` |
| LayerZero EndpointV2 | `CCQLLRE5JBAWYCW3KTWOIWLMFDUOKROQVZNSALQMGOSXNW3ERUOWTZGK` |

Many Stellar assets use the code USDT or USDT0. Pin the issuer; never match on the code.

## How a send works

1. `quote_oft(from, send_param)` returns the amounts after dust is removed.
2. `quote_send(from, send_param, pay_in_zro)` returns `MessagingFee { native_fee, zro_fee }`. Native is XLM.
3. `send(from, send_param, fee, refund_address)`; the sender authorises it. The fee moves to the Endpoint
   as a token transfer inside the call.

`SendParam`: `dst_eid`, `to` (bytes32), `amount_ld`, `min_amount_ld`, `extra_options`, `compose_msg`, `oft_cmd`.

Decimals: the SAC has 7, the OFT 6 shared decimals. Amounts round down to 6, so round a balance first or the
last digit is stranded.

Packages: `@layerzerolabs/oft-stellar-types` (`Client as OFTClient`), `@layerzerolabs/lz-v2-stellar-sdk`,
peer `@stellar/stellar-sdk`. The docs have no TypeScript send example.

## Where it goes

Destination eids: Ethereum 30101, Arbitrum 30110, Optimism 30111, Polygon 30109, Ink 30339, Unichain 30320,
Monad 30390, HyperEVM 30367, Plasma 30383, Tempo 30410, Flare 30295, Mantle 30181, Sei 30280, Berachain 30362,
and more (24 networks on the deployments page). **Not Arc, Solana or Sui.** Between OFT chains the protocol
fee is 0 bps; the cost is source and destination gas.

## Why it is not on the page

- It is a different token. CCTP burns and mints USDC; this moves USDT0 to USDT0. It does not reach Arc,
  Solana or Sui, so it does not meet Xebra's own routes.
- Meeting CCTP would take a swap USDT0 to USDC in the middle. No USDT0/USDC pool depth was confirmed on
  Soroswap, Aquarius or the SDEX, and USDT0 on Stellar is thin (about $7M supply).
- One measured Stellar to Arbitrum transfer took about 30 minutes (earlier note, unverified).

If it is built: a separate "USDT0" asset toggle on the Stellar form, a direct OFT send (no swap, no custody),
a read-only `quote_send` first to prove the call shape, then one real transfer.
