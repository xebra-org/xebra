# Evidence pack: what moving USDC costs, 2026-11-13

> Published copy. The saved Circle documentation pages cited below as `docs/<name>.md` are not
> included in the repository; each is the page at `https://developers.circle.com/<path>.md`, where
> `<name>` is the path with `/` written as `_` (for example `cctp_concepts_fees.md` is
> `https://developers.circle.com/cctp/concepts/fees.md`).


Collected 2026-11-13 between 11:57 and 12:22 UTC. Every number below comes from a public endpoint or
an on-chain read. The raw response is saved under `raw/`, wrapped as `{meta: {url, method,
requestBody, fetchedAtUtc, httpStatus}, body}`. Circle's docs pages were saved as markdown under
`docs/` (fetched 11:59 UTC). `quotes.csv` / `quotes.json` hold one normalised row per pair, size
and route. `scripts/` holds the code that produced all of it.

The question was whether the evidence supports this positioning: *"moving USDC through Xebra (CCTP
V2 plus our wrapper and relayer, and as a routing leg for NEAR Intents) is cheaper and uncapped
compared with the alternatives, and easier than integrating Circle CCTP directly."*

**Short answer: partly.** The "only route" claim for Stellar USDC into NEAR Intents and the
"easier than direct CCTP" claim hold up. "Cheaper" holds only against percentage-fee bridges at
roughly $1,000 and above, and against Xebra's own current pricing. It does **not** hold against
Circle's own Forwarding Service or Mayan's MCTP route on EVM pairs. "Uncapped" is **false today**:
Xebra's live Stellar route refuses anything above 100 USDC.

## Method

- **No keys, no identity.** No API key, JWT, email or repo name was sent. Where an API needed an
  address, the request used a placeholder: `0x000000000000000000000000000000000000dEaD` (EVM),
  `0x1111111111111111111111111111111111111111` (EVM, for 1Click, which rejects `0x…dEaD`),
  `1nc1nerator11111111111111111111111111111111` (Solana), the USDC issuer
  `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` (Stellar) and `intents.near` (NEAR).
  Nothing was signed or sent.
- **Sizes:** 10, 100, 1,000, 10,000 and 100,000 USDC, plus probes at 0.1, 1, 250k, 500k, 1M and 5M
  to find limits.
- **Pairs:** Base→Arbitrum, Ethereum→Base, Arbitrum→Ethereum, Stellar→Base, Base→Solana and
  Polygon→Avalanche. Stellar→NEAR, Base→NEAR, Solana→NEAR, Base→Sui and Stellar→Solana were added
  for NEAR Intents.
- **How fees are counted:** fee = amount sent − amount received, plus any protocol fee paid
  separately in native gas (deBridge's `fixFee`). The source-chain transaction gas is left out for
  every provider, because every option pays it. It is counted only for Xebra's "gasless" T3 tier.
- **USD prices** for native gas come from CoinGecko (`raw/prices_coingecko.json`, 12:13:55 UTC):
  ETH $1,962.18, AVAX $8.42, POL $0.0871, SOL $80.75, XLM $0.1476.
- **Destination gas** is the realised cost of recent CCTP mints, not a guess. For each chain the
  script read the last `MessageTransmitterV2.receiveMessage` transactions sent straight to
  `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`, took the median of `gasUsed × effectiveGasPrice +
  l1Fee`, and converted it to USD (`raw/gas_{base,arb,eth,avax}.json`, with each tx hash recorded).

| Destination | Median mint gasUsed | eth_gasPrice now | Median mint cost (USD) | Samples |
|---|---|---|---|---|
| Base | 154,932 | 0.006 gwei | $0.0020 | 15 |
| Arbitrum | 170,476 | 0.020 gwei | $0.0074 | 15 |
| Ethereum | 171,342 | 0.080 gwei | $0.0295 | 15 |
| Avalanche | 171,252 | 7.5 gwei | $0.0108 | 9 |
| Solana | (no EVM sample) | | $0.0589, or $0.1777 if the USDC account must be created | Circle's own `forwardFee.med` minus its $0.05 service fee (`raw/iris_fees_6_5*.json`) |

Ethereum gas was unusually low in this window (0.08 gwei). At more typical L1 gas, every
"to Ethereum" self-relay cost would be many times higher.

Source-chain burn cost, used only in T3: Base $0.0015, Ethereum $0.464 (median of 12 real
`depositForBurn` transactions, which paid well above base fee), Polygon $0.0045, Arbitrum $0.0045
(estimated), Stellar $0.00046 (`fee_charged` of Xebra's own mainnet burn `95efc874…`).

## Circle CCTP V2: the baseline everything else wraps

| Fact | Value | Source |
|---|---|---|
| Standard Transfer fee (USDC) | **0**, on every pair queried | `raw/iris_fees_*.json` (`finalityThreshold 2000 → minimumFee 0`); docs/cctp_concepts_fees.md "Standard Transfers are free" |
| Fast Transfer fee | 1.0–1.4 bps (Base→Arb 1.3, Eth→Base 1.0, Arb→Eth 1.4, Base→Sol 1.3). Not offered from Stellar, Polygon, Avalanche, Arc, Sui or Monad, where Standard is already fast | same |
| Forwarding Service fee (Circle submits the mint) | Base→Arb $0.0704, Eth→Base $0.0539, **Arb→Eth $0.8436**, Stellar→Base $0.0539, Base→Sol $0.1089 ($0.2277 if the USDC account is created), Pol→Avax $0.0714, Stellar→Arc $0.0166 | `forwardFee.med`, `raw/iris_fees_*.json`, 11:57 UTC. Includes Circle's $0.05 service fee (docs/cctp_concepts_forwarding-service.md) |
| Destinations the Forwarding Service does **not** support | Stellar, Sui, Aptos, Starknet, Injective, Morph, Pharos | docs/cctp_concepts_supported-chains-and-domains.md; Iris answers HTTP 400 "Destination domain not supported for forwarding" for 6→27, 6→8 and 26→27 (`raw/iris_fees_6_27.json` etc.) |
| Per-message burn limit | **10,000,000 USDC** on Ethereum, Base, Arbitrum, Polygon and Avalanche | on-chain `TokenMinterV2.burnLimitsPerMessage(USDC)`, `raw/circle_burn_limits_per_message.json`, 12:16 UTC |
| Fast Transfer allowance (global, all chains) | 54,216,662 USDC | `GET /v2/fastBurn/USDC/allowance`, `raw/iris_fastburn_allowance.json`, lastUpdated 11:57:57 UTC |
| Standard attestation time | Ethereum, Base, Arbitrum, OP: 15–19 min · Stellar ~5 s · Polygon ~8 s · Solana ~17 s · Linea 6–32 h | docs/cctp_concepts_finality-and-block-confirmations.md |

## Fee per pair and size

Each cell is total fee in USD (and as % of the amount). "Received" values, caps, ETAs, sources and
timestamps for every cell are in the expandable tables at the end and in `quotes.csv`.

How to read the Xebra rows:
- **T1/T2/T3** are the proposed prices: 0.05 flat with the user claiming (the user still pays
  destination gas), 0.10 + destination gas with Xebra delivering, and 0.15 + gas on both ends
  (gasless). They are computed from the measured gas above.
- **"T2/T3 via Circle Forwarding"** is the same price when delivery goes through Circle's
  Forwarding Service, which is how Xebra delivers today: the live quote's `delivery` component is
  Circle's forward fee.
- **None of the EVM→EVM or Base→Solana pairs are live Xebra routes.** `GET /v1/routes` lists 20
  routes: Stellar→{Solana, Arc, Base, Monad}, Arc→15 chains, and Sui→Stellar
  (`raw/xebra_routes.json`). For those pairs the Xebra rows are hypothetical.

#### Base -> Arbitrum

| Provider | Route | 10 | 100 | 1,000 | 10,000 | 100,000 |
|---|---|---|---|---|---|---|
| Circle CCTP V2 direct | Standard, integrator mints (self-relay) | $0.0074 (0.0736%) | $0.0074 (0.0074%) | $0.0074 (0.0007%) | $0.0074 (0.0001%) | $0.0074 (0.0000%) |
| Circle CCTP V2 direct | Fast (1.3 bps), self-relay | $0.0087 (0.0866%) | $0.02 (0.020%) | $0.14 (0.014%) | $1.31 (0.013%) | $13.01 (0.013%) |
| Circle CCTP V2 direct | Standard + Circle Forwarding Service | $0.07 (0.704%) | $0.07 (0.070%) | $0.07 (0.007%) | $0.07 (0.001%) | $0.07 (0.000%) |
| Circle CCTP V2 direct | Fast + Circle Forwarding Service | $0.07 (0.717%) | $0.08 (0.083%) | $0.20 (0.020%) | $1.37 (0.014%) | $13.07 (0.013%) |
| Xebra (proposed) | T1 0.05 flat, user claims | $0.06 (0.574%) | $0.06 (0.057%) | $0.06 (0.006%) | $0.06 (0.001%) | $0.06 (0.000%) |
| Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | $0.11 (1.074%) | $0.11 (0.107%) | $0.11 (0.011%) | $0.11 (0.001%) | $0.11 (0.000%) |
| Xebra (proposed) | T3 0.15 + gas both ends, gasless | $0.16 (1.588%) | $0.16 (0.159%) | $0.16 (0.016%) | $0.16 (0.002%) | $0.16 (0.000%) |
| Xebra (proposed) | T2 delivered via Circle Forwarding | $0.17 (1.704%) | $0.17 (0.170%) | $0.17 (0.017%) | $0.17 (0.002%) | $0.17 (0.000%) |
| Xebra (proposed) | T3 via Circle Forwarding + source gas | $0.22 (2.219%) | $0.22 (0.222%) | $0.22 (0.022%) | $0.22 (0.002%) | $0.22 (0.000%) |
| Across | suggested-fees | $0.0080 (0.0801%) | $0.02 (0.017%) | $0.11 (0.011%) | $1.01 (0.010%) | $10.01 (0.010%) |
| Relay | quote | $0.02 (0.234%) | $0.03 (0.032%) | $0.12 (0.012%) | $1.02 (0.010%) | $10.02 (0.010%) |
| LI.FI | Polymer (Standard) | $0.03 (0.250%) | $0.25 (0.250%) | $2.50 (0.250%) | $25.00 (0.250%) | $250.00 (0.250%) |
| deBridge DLN | quote | $2.22 (22.157%) | $2.29 (2.288%) | $3.01 (0.301%) | $10.37 (0.104%) | $84.42 (0.084%) |
| Mayan | FAST_MCTP | $0.05 (0.514%) | $0.09 (0.091%) | $0.49 (0.049%) | $4.48 (0.045%) | $44.35 (0.044%) |
| Mayan | MCTP | $0.07 (0.705%) | $0.07 (0.070%) | $0.07 (0.007%) | $0.07 (0.001%) | $0.07 (0.000%) |
| NEAR Intents 1Click | dry quote, no JWT | $0.0065 (0.0645%) | $0.01 (0.012%) | $0.20 (0.020%) | $0.72 (0.007%) | $20.20 (0.020%) |

#### Ethereum -> Base

| Provider | Route | 10 | 100 | 1,000 | 10,000 | 100,000 |
|---|---|---|---|---|---|---|
| Circle CCTP V2 direct | Standard, integrator mints (self-relay) | $0.0020 (0.0202%) | $0.0020 (0.0020%) | $0.0020 (0.0002%) | $0.0020 (0.0000%) | $0.0020 (0.0000%) |
| Circle CCTP V2 direct | Fast (1 bps), self-relay | $0.0030 (0.0302%) | $0.01 (0.012%) | $0.10 (0.010%) | $1.00 (0.010%) | $10.00 (0.010%) |
| Circle CCTP V2 direct | Standard + Circle Forwarding Service | $0.05 (0.539%) | $0.05 (0.054%) | $0.05 (0.005%) | $0.05 (0.001%) | $0.05 (0.000%) |
| Circle CCTP V2 direct | Fast + Circle Forwarding Service | $0.05 (0.549%) | $0.06 (0.064%) | $0.15 (0.015%) | $1.05 (0.011%) | $10.05 (0.010%) |
| Xebra (proposed) | T1 0.05 flat, user claims | $0.05 (0.520%) | $0.05 (0.052%) | $0.05 (0.005%) | $0.05 (0.001%) | $0.05 (0.000%) |
| Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | $0.10 (1.020%) | $0.10 (0.102%) | $0.10 (0.010%) | $0.10 (0.001%) | $0.10 (0.000%) |
| Xebra (proposed) | T3 0.15 + gas both ends, gasless | $0.62 (6.161%) | $0.62 (0.616%) | $0.62 (0.062%) | $0.62 (0.006%) | $0.62 (0.001%) |
| Xebra (proposed) | T2 delivered via Circle Forwarding | $0.15 (1.539%) | $0.15 (0.154%) | $0.15 (0.015%) | $0.15 (0.002%) | $0.15 (0.000%) |
| Xebra (proposed) | T3 via Circle Forwarding + source gas | $0.67 (6.679%) | $0.67 (0.668%) | $0.67 (0.067%) | $0.67 (0.007%) | $0.67 (0.001%) |
| Across | suggested-fees | $0.0044 (0.0437%) | $0.01 (0.013%) | $0.10 (0.010%) | $1.00 (0.010%) | $10.00 (0.010%) |
| Relay | quote | $0.02 (0.218%) | $0.03 (0.031%) | $0.12 (0.012%) | $1.02 (0.010%) | $10.02 (0.010%) |
| LI.FI | AcrossV4 (10, 100) / Polymer Standard (1k+) | $0.03 (0.294%) | $0.26 (0.263%) | $2.50 (0.250%) | $25.00 (0.250%) | $250.00 (0.250%) |
| deBridge DLN | quote | $2.23 (22.257%) | $2.30 (2.298%) | $3.02 (0.302%) | $10.39 (0.104%) | $84.49 (0.085%) |
| Mayan | FAST_MCTP | $0.0077 (0.0772%) | $0.04 (0.045%) | $0.41 (0.041%) | $4.10 (0.041%) | $41.00 (0.041%) |
| Mayan | MCTP | $0.0054 (0.0538%) | $0.0054 (0.0054%) | $0.0054 (0.0005%) | $0.0054 (0.0001%) | $0.0054 (0.0000%) |
| NEAR Intents 1Click | dry quote, no JWT | $0.0037 (0.0368%) | $0.02 (0.023%) | $0.19 (0.019%) | $1.91 (0.019%) | $20.20 (0.020%) |

#### Arbitrum -> Ethereum

| Provider | Route | 10 | 100 | 1,000 | 10,000 | 100,000 |
|---|---|---|---|---|---|---|
| Circle CCTP V2 direct | Standard, integrator mints (self-relay) | $0.03 (0.295%) | $0.03 (0.029%) | $0.03 (0.003%) | $0.03 (0.000%) | $0.03 (0.000%) |
| Circle CCTP V2 direct | Fast (1.4 bps), self-relay | $0.03 (0.309%) | $0.04 (0.043%) | $0.17 (0.017%) | $1.43 (0.014%) | $14.03 (0.014%) |
| Circle CCTP V2 direct | Standard + Circle Forwarding Service | $0.84 (8.436%) | $0.84 (0.844%) | $0.84 (0.084%) | $0.84 (0.008%) | $0.84 (0.001%) |
| Circle CCTP V2 direct | Fast + Circle Forwarding Service | $0.84 (8.450%) | $0.86 (0.858%) | $0.98 (0.098%) | $2.24 (0.022%) | $14.84 (0.015%) |
| Xebra (proposed) | T1 0.05 flat, user claims | $0.08 (0.795%) | $0.08 (0.080%) | $0.08 (0.008%) | $0.08 (0.001%) | $0.08 (0.000%) |
| Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | $0.13 (1.295%) | $0.13 (0.130%) | $0.13 (0.013%) | $0.13 (0.001%) | $0.13 (0.000%) |
| Xebra (proposed) | T3 0.15 + gas both ends, gasless | $0.18 (1.840%) | $0.18 (0.184%) | $0.18 (0.018%) | $0.18 (0.002%) | $0.18 (0.000%) |
| Xebra (proposed) | T2 delivered via Circle Forwarding | $0.94 (9.436%) | $0.94 (0.944%) | $0.94 (0.094%) | $0.94 (0.009%) | $0.94 (0.001%) |
| Xebra (proposed) | T3 via Circle Forwarding + source gas | $1.00 (9.980%) | $1.00 (0.998%) | $1.00 (0.100%) | $1.00 (0.010%) | $1.00 (0.001%) |
| Across | suggested-fees | $0.02 (0.209%) | $0.03 (0.030%) | $0.12 (0.012%) | $1.02 (0.010%) | $10.02 (0.010%) |
| Relay | quote | $0.07 (0.686%) | $0.08 (0.076%) | $0.15 (0.015%) | $0.87 (0.009%) | $8.07 (0.008%) |
| LI.FI | best route (Across / Polymer) | $0.05 (0.512%) | $0.27 (0.274%) | $2.62 (0.262%) | $25.00 (0.250%) | $250.00 (0.250%) |
| deBridge DLN | quote | $2.25 (22.456%) | $2.32 (2.319%) | $3.04 (0.304%) | $10.41 (0.104%) | $84.49 (0.085%) |
| Mayan | FAST_MCTP | $1.18 (11.770%) | $1.22 (1.218%) | $1.63 (0.163%) | $5.71 (0.057%) | $46.57 (0.047%) |
| Mayan | MCTP | $0.83 (8.289%) | $0.83 (0.829%) | $0.83 (0.083%) | $0.83 (0.008%) | $0.83 (0.001%) |
| NEAR Intents 1Click | dry quote, no JWT | $0.30 (3.011%) | $0.31 (0.311%) | $0.50 (0.050%) | $2.21 (0.022%) | $19.50 (0.019%) |

#### Stellar -> Base

No aggregator in this sample lists Stellar as a source. LI.FI, Relay, deBridge, Across and Mayan
have no Stellar chain (`raw/lifi_chains.json`, `raw/relay_chains.json`, `raw/debridge_chains.json`),
and 1Click refuses it.

| Provider | Route | 10 | 100 | 1,000 | 10,000 | 100,000 |
|---|---|---|---|---|---|---|
| Circle CCTP V2 direct | Standard, integrator mints (self-relay) | $0.0020 (0.0202%) | $0.0020 (0.0020%) | $0.0020 (0.0002%) | $0.0020 (0.0000%) | $0.0020 (0.0000%) |
| Circle CCTP V2 direct | Standard + Circle Forwarding Service | $0.05 (0.539%) | $0.05 (0.054%) | $0.05 (0.005%) | $0.05 (0.001%) | $0.05 (0.000%) |
| Xebra (proposed) | T1 0.05 flat, user claims | $0.05 (0.520%) | $0.05 (0.052%) | $0.05 (0.005%) | $0.05 (0.001%) | $0.05 (0.000%) |
| Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | $0.10 (1.020%) | $0.10 (0.102%) | $0.10 (0.010%) | $0.10 (0.001%) | $0.10 (0.000%) |
| Xebra (proposed) | T3 0.15 + gas both ends, gasless | $0.15 (1.525%) | $0.15 (0.152%) | $0.15 (0.015%) | $0.15 (0.002%) | $0.15 (0.000%) |
| Xebra (proposed) | T2 delivered via Circle Forwarding | $0.15 (1.539%) | $0.15 (0.154%) | $0.15 (0.015%) | $0.15 (0.002%) | $0.15 (0.000%) |
| Xebra (proposed) | T3 via Circle Forwarding + source gas | $0.20 (2.043%) | $0.20 (0.204%) | $0.20 (0.020%) | $0.20 (0.002%) | $0.20 (0.000%) |
| **Xebra (live today)** | 0.10%, min 0.30 | $0.30 (3.000%) | $0.30 (0.300%) | **refused (max 100)** | **refused** | **refused** |
| NEAR Intents 1Click | - | refused | refused | refused | refused | refused |

#### Base -> Solana

| Provider | Route | 10 | 100 | 1,000 | 10,000 | 100,000 |
|---|---|---|---|---|---|---|
| Circle CCTP V2 direct | Standard, integrator mints (self-relay)* | $0.06 (0.589%) | $0.06 (0.059%) | $0.06 (0.006%) | $0.06 (0.001%) | $0.06 (0.000%) |
| Circle CCTP V2 direct | Fast (1.3 bps), self-relay* | $0.06 (0.602%) | $0.07 (0.072%) | $0.19 (0.019%) | $1.36 (0.014%) | $13.06 (0.013%) |
| Circle CCTP V2 direct | Standard + Circle Forwarding Service | $0.11 (1.089%) | $0.11 (0.109%) | $0.11 (0.011%) | $0.11 (0.001%) | $0.11 (0.000%) |
| Circle CCTP V2 direct | Fast + Circle Forwarding Service | $0.11 (1.102%) | $0.12 (0.122%) | $0.24 (0.024%) | $1.41 (0.014%) | $13.11 (0.013%) |
| Xebra (proposed) | T1 0.05 flat, user claims* | $0.11 (1.089%) | $0.11 (0.109%) | $0.11 (0.011%) | $0.11 (0.001%) | $0.11 (0.000%) |
| Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers* | $0.16 (1.589%) | $0.16 (0.159%) | $0.16 (0.016%) | $0.16 (0.002%) | $0.16 (0.000%) |
| Xebra (proposed) | T3 0.15 + gas both ends, gasless* | $0.21 (2.103%) | $0.21 (0.210%) | $0.21 (0.021%) | $0.21 (0.002%) | $0.21 (0.000%) |
| Xebra (proposed) | T2 delivered via Circle Forwarding | $0.21 (2.089%) | $0.21 (0.209%) | $0.21 (0.021%) | $0.21 (0.002%) | $0.21 (0.000%) |
| Xebra (proposed) | T3 via Circle Forwarding + source gas | $0.26 (2.603%) | $0.26 (0.260%) | $0.26 (0.026%) | $0.26 (0.003%) | $0.26 (0.000%) |
| Across | - | no route (ROUTE_NOT_ENABLED) | no route | no route | no route | no route |
| Relay | quote | $0.02 (0.240%) | $0.05 (0.051%) | $0.32 (0.032%) | $3.02 (0.030%) | $30.02 (0.030%) |
| LI.FI | via Relay (Layerswap at 10k) | $0.05 (0.486%) | $0.30 (0.300%) | $2.82 (0.282%) | $27.41 (0.274%) | $279.95 (0.280%) |
| deBridge DLN | quote | $2.69 (26.863%) | $2.76 (2.758%) | $3.48 (0.348%) | $10.88 (0.109%) | $85.60 (0.086%) |
| Mayan | MCTP | $1.54 (15.385%) | $1.54 (1.538%) | $1.54 (0.154%) | $3.54 (0.035%) | $30.53 (0.030%) |
| NEAR Intents 1Click | dry quote, no JWT | $0.01 (0.110%) | $0.02 (0.018%) | $0.10 (0.010%) | $1.02 (0.010%) | $20.21 (0.020%) |

\* The Solana destination cost here is derived from Circle's own forward quote (forwardFee − $0.05),
not measured on-chain, so these rows are circular with Circle's number. All of them assume the
recipient already has a USDC account. Creating one raises Circle's forward fee from $0.1089 to
$0.2277.

#### Polygon -> Avalanche

Across does not support Avalanche. Fast is not offered from Polygon.

| Provider | Route | 10 | 100 | 1,000 | 10,000 | 100,000 |
|---|---|---|---|---|---|---|
| Circle CCTP V2 direct | Standard, integrator mints (self-relay) | $0.01 (0.108%) | $0.01 (0.011%) | $0.01 (0.001%) | $0.01 (0.000%) | $0.01 (0.000%) |
| Circle CCTP V2 direct | Standard + Circle Forwarding Service | $0.07 (0.714%) | $0.07 (0.071%) | $0.07 (0.007%) | $0.07 (0.001%) | $0.07 (0.000%) |
| Xebra (proposed) | T1 0.05 flat, user claims | $0.06 (0.608%) | $0.06 (0.061%) | $0.06 (0.006%) | $0.06 (0.001%) | $0.06 (0.000%) |
| Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | $0.11 (1.108%) | $0.11 (0.111%) | $0.11 (0.011%) | $0.11 (0.001%) | $0.11 (0.000%) |
| Xebra (proposed) | T3 0.15 + gas both ends, gasless | $0.17 (1.653%) | $0.17 (0.165%) | $0.17 (0.017%) | $0.17 (0.002%) | $0.17 (0.000%) |
| Xebra (proposed) | T2 delivered via Circle Forwarding | $0.17 (1.714%) | $0.17 (0.171%) | $0.17 (0.017%) | $0.17 (0.002%) | $0.17 (0.000%) |
| Xebra (proposed) | T3 via Circle Forwarding + source gas | $0.23 (2.258%) | $0.23 (0.226%) | $0.23 (0.023%) | $0.23 (0.002%) | $0.23 (0.000%) |
| Relay | quote | $0.03 (0.252%) | $0.03 (0.034%) | $0.12 (0.012%) | $1.02 (0.010%) | $10.04 (0.010%) |
| LI.FI | Polymer (Standard) | $0.03 (0.250%) | $0.25 (0.250%) | $2.50 (0.250%) | $25.00 (0.250%) | $250.00 (0.250%) |
| deBridge DLN | quote | $0.12 (1.186%) | $0.19 (0.191%) | $0.91 (0.091%) | $8.15 (0.082%) | $80.59 (0.081%) |
| Mayan | FAST_MCTP | $0.02 (0.219%) | $0.05 (0.049%) | $0.32 (0.032%) | $3.02 (0.030%) | $30.02 (0.030%) |
| Mayan | MCTP | $0.03 (0.284%) | $0.03 (0.028%) | $0.03 (0.003%) | $0.03 (0.000%) | $0.03 (0.000%) |
| NEAR Intents 1Click | dry quote, no JWT | $0.02 (0.189%) | $0.04 (0.037%) | $0.22 (0.022%) | $2.04 (0.020%) | $20.22 (0.020%) |

**What shapes these numbers**
- **LI.FI**'s keyless API adds a flat **0.25% "LIFI Fixed Fee"** to every quote (`feeCosts`,
  `included: true`). Its underlying CCTP "Polymer (Standard)" leg costs nothing extra.
- **deBridge** charges a **0.001 ETH `fixFee`** (about $1.96) from ETH-gas chains and 0.5 POL from
  Polygon, plus 4 bps protocol fee, 4 bps taker margin and prepended operating expenses.
- **Across** charges a 1 bp capital fee plus relayer gas, and quotes a 1–8 s fill. Above the
  "instant" limit the fill time jumps: Base→Arb at 100k quoted 900 s.
- **1Click without a JWT priced at about 2 bps** at size, plus a 0.0053 withdraw fee. That is
  **not** the 0.2–0.25% assumed in the brief and in `oneclick.ts`. These were dry quotes; a real
  deposit was not tested in this window.
- **Mayan MCTP** is standard CCTP with Mayan's relayer submitting the mint, a flat fee close to
  Circle's forward fee. It is the closest existing analogue to Xebra's T2.

## Caps and limits (the "uncapped" claim)

| Provider | Largest size tested OK | Refused at | Evidence |
|---|---|---|---|
| Circle CCTP V2 (protocol) | 10,000,000 per message, any number of messages | — | `raw/circle_burn_limits_per_message.json` (on-chain) |
| Circle CCTP Fast | global allowance 54.2M; above it, Fast falls back to Standard | — | `raw/iris_fastburn_allowance.json` |
| **Xebra live, Stellar route** | **100 USDC** | **1,000** ("The bridge contract takes at most 100.00 USDC per transfer") | `raw/xebra_quote_stellar_base_1000.json` (HTTP 422, 12:14:40 UTC) |
| Xebra live, Arc→X and Sui→Stellar | `maximum: null` (no cap reported) | — | `raw/xebra_quote_arc_arbitrum_100.json`, `raw/xebra_quote_sui_stellar_1000.json` |
| Across Base→Arb | max deposit 610,852; "instant" max 73,415 | 1M ("Max amount is 610851.84068 USDC") | `raw/across_limits_base_arb.json`, `raw/across_base_arb_1000000.json` |
| Across Eth→Base | max 991,542; instant 454,105 | — | `raw/across_limits_eth_base.json` |
| Across Arb→Eth | max 537,437 | — | `raw/across_limits_arb_eth.json` |
| Across Base→Solana, anything→Avalanche | — | route not enabled / chain absent | `raw/across_base_sol_*.json` |
| Relay Base→Arb | 1,000,000 | 5,000,000 ("Quote amount exceeds the maximum for this pair") | `raw/relay_base_arb_{1000000,5000000}.json` |
| NEAR Intents 1Click Base→Arb | 500,000 | 1,000,000 ("No liquidity available"); minimum 0.15 USDC ("try at least 150000") | `raw/oneclick_base_arb_{500000,1000000,0.1}.json` |
| deBridge, Mayan Fast MCTP, LI.FI | 5,000,000 quoted | none found up to 5M | `raw/*_base_arb_5000000.json` |

## NEAR Intents (1Click)

- **Stellar-origin USDC is still unquotable.** At 0.1, 1, 10, 100, 1k, 10k, 100k, 1M and 10M, to
  Base, NEAR and Solana, every quote came back HTTP 400 "Quoting for this pair is not available"
  (`raw/oneclick_stellar_{base,near,sol}_*.json`, 12:06–12:08 UTC). Stellar XLM as origin gives the
  same answer (`raw/oneclick_stellarXLM_near_100.json`). `depositMode: "SIMPLE"` is rejected for a
  Stellar origin ("Incorrect depositMode"). Stellar USDC *is* listed in `/v0/tokens`
  (`nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu`, 7
  decimals).
- **Stellar as a destination** was not settled. 1Click checked the recipient's trustline ("Destination
  address does not have a trustline"), which suggests the direction is supported, but no
  placeholder account with a USDC trustline was used, so there is no quote.
- **Other chains quote fine** at all five sizes: Base→NEAR, Solana→NEAR and Base→Sui. Base→NEAR
  costs $0.0020 at 10, $0.013 at 100, $0.16 at 1k, $2.02 at 10k and $20.20 at 100k, about 2 bps.
  1Click's quoted `timeEstimate` is about 34 s.
- **Reach.** `/v0/tokens` lists 230 assets on 39 chains (`raw/oneclick_tokens.json`). Chains 1Click
  reaches that CCTP does not: NEAR, TON, Tron, Bitcoin, Bitcoin Cash, Litecoin, Dogecoin, Dash,
  Zcash, XRP, Cardano, Gnosis, Scroll, Berachain, Abstract, BNB Chain (CCTP there is USYC only),
  Aleo, Movement, Miden, Fogo, Robinhood (`hood`), `adi`, `prl` and `qtc`. CCTP reaches chains
  1Click does not list: Arc, Unichain, Linea, Codex, Sonic, World Chain, Sei, XDC, HyperEVM, Ink,
  Plume, EDGE, Injective, Morph, Pharos and Cronos.
- **Composite route Stellar → NEAR (Xebra leg + 1Click Base→NEAR leg)**, priced from this
  window's rows:

| Size | Xebra live (0.30 min) + 1Click | Proposed T2 via Circle Forwarding ($0.154) + 1Click | Proposed T1 ($0.052) + 1Click |
|---|---|---|---|
| 10 | $0.302 (3.02%) | $0.156 (1.56%) | $0.054 (0.54%) |
| 100 | $0.313 (0.31%) | $0.167 (0.17%) | $0.065 (0.07%) |
| 1,000 | refused (cap) | $0.316 (0.03%) | $0.214 (0.02%) |
| 10,000 | refused (cap) | $2.17 (0.02%) | $2.07 (0.02%) |
| 100,000 | refused (cap) | $20.35 (0.02%) | $20.25 (0.02%) |

  T1 for this route is theoretical: the user would have to claim on Base themselves before
  depositing to 1Click.
  Proven run (2026-11-12, recorded in the project notes, not re-measured here): Stellar burn
  `95efc874…842b` at 23:24:27 → Circle mint on Base `0x8d16acc8…940a` at 23:24:38 → NEAR delivery
  `Hv1xrVs5…AVg7` at 23:25:03, i.e. **36 s burn-to-wallet**. The burn tx and its fee are confirmed
  in `raw/stellar_xebra_burn_tx.json` (created_at 2026-11-12T23:24:27Z, fee_charged 30,841 stroops).

## Market size

| Metric | Value | Source |
|---|---|---|
| USDC circulating on Stellar (Circle) | **353,128,483 USDC** (updateDate 12:14:01 UTC) | `GET https://api.circle.com/v1/stablecoins`, `raw/circle_stablecoins_api.json` |
| USDC on Stellar (Horizon, cross-check) | 352,798,878 = 237.35M in accounts + 112.00M in contracts + 2.43M in pools + 0.98M liabilities-only + 0.03M claimable; 2,545,152 trustlines; 47,235 holder contracts | `raw/horizon_usdc_asset.json` |
| Stellar's rank among USDC chains | 9th of 39 chains in Circle's API (behind ETH 44.6B, SOL 7.0B, HyperEVM 6.1B, Base 4.4B, Arbitrum 2.5B, Arc 1.4B, Polygon 546M, Sui 365M) | same |
| USDC on NEAR (Circle) | 79,292,090 | same |
| NEAR Intents volume (DefiLlama "dexs") | 24h $176.4M · 7d $952.5M · 30d $3.77B · all-time $37.6B | `raw/llama_summary_dexs_near-intents.json`, 12:15:47 UTC |

**"Billions in Stellar USDC" is not supported.** The sourced figure is about **$353M**. Note too
that "locked out" refers to 1Click quoting; Stellar USDC is listed as a token, and it may enter
Intents through HOT-bridge deposits outside 1Click. That path was not tested.

## Direct-integration burden: what an integrator builds to use CCTP V2 on every chain

Each item is cited to Circle's docs as saved in `docs/` (source URL
`https://developers.circle.com/<path>.md`).

1. **31 domains**, each with a Circle domain id distinct from its chain id
   (cctp_concepts_supported-chains-and-domains.md).
2. **Per-chain contract addresses.** On EVM chains TokenMessengerV2, MessageTransmitterV2,
   TokenMinterV2 and MessageV2 share one address set, **except EDGE (domain 28), where all four
   differ** (`0x98706A00…` vs `0x28b5a0e9…`) (cctp_references_contract-addresses.md). Non-EVM chains
   each have their own model: Solana programs and PDAs; Sui with 4 packages plus separate state
   object IDs; Stellar with 3 contracts including CctpForwarder; Aptos; Starknet.
3. **Attestation polling** of `GET /v2/messages` within a rate limit that Circle documents two ways:
   **35 req/s** (cctp_howtos_resolve-stuck-attestation.md) and **40 req/s**
   (cctp_references_technical-guide.md). Going over it **blocks all API requests for 5 minutes**
   (HTTP 429).
4. **Fee handling.** Query the fee API at least weekly and never hardcode fees. Set `maxFee` with a
   buffer. If `maxFee` is too low, Fast silently degrades to Standard, and with the Forwarding
   Service, forwarding takes priority over Fast (cctp_concepts_fees.md,
   cctp_concepts_forwarding-service.md).
5. **The Fast allowance is global and can run dry.** The integrator must monitor it and fall back
   to Standard (cctp_concepts_fast-transfer-allowance.md).
6. **Attestation expiry.** Each message carries an `expirationBlock` 24 h ahead, and it is an
   *Ethereum L1* block number even on L2s. After expiry the integrator must call
   `POST /v2/reattest/{nonce}`, poll again and re-mint (cctp_references_technical-guide.md,
   cctp_howtos_troubleshoot-transfers.md).
7. **Destination gas on every destination** (different native tokens), or the Forwarding Service,
   which does **not** cover Stellar, Sui, Aptos, Starknet, Injective, Morph or Pharos
   (supported-chains table, confirmed by Iris HTTP 400s).
8. **Solana.** `mintRecipient` must be the recipient's USDC **ATA**, not the wallet. If the ATA does
   not exist, the transfer fails unless the integrator creates it or encodes the 33-byte
   ATA-creation hook and quotes with `includeRecipientSetup=true`. Today that took Circle's fee from
   $0.109 to $0.228 (cctp_concepts_forwarding-service.md, `raw/iris_fees_6_5_recipientsetup.json`).
9. **Stellar inbound.** Both `mintRecipient` **and** `destinationCaller` must be CctpForwarder
   `CBZL2IH7…DF5T`, with the recipient strkey encoded in a custom hook layout. Get either wrong and
   **"funds become permanently stuck and cannot be recovered"** (cctp_references_stellar.md, which
   warns about this twice).
10. **Stellar decimals.** Stellar USDC has **7 decimals**, while CCTP messages use 6. Burns from
    Stellar leave the 7th decimal behind as dust, and mints to Stellar scale ×10
    (cctp_references_stellar.md).
11. **Sui** calls go through Programmable Transaction Blocks across 4 Move packages and shared
    objects (cctp_references_sui-packages.md). Circle's own docs index still says "Noble, Sui, and
    Aptos still require V1" while the Sui reference lists V2 packages. That is a documentation
    contradiction the integrator has to resolve.
12. **Hook formats.** The forwarding hook comes in v0 (single, no wrapper/`destinationCaller`
    support) and v1 (framed, composable) (cctp_concepts_forwarding-service.md).
13. **Contract versions differ by chain.** Some TokenMessengerV2 deployments have a Standard-fee
    switch with `getMinFeeAmount`; calling it on older deployments reverts (cctp_concepts_fees.md).
    Upfront-fee support also varies by source chain.
14. **Finality differs by an order of magnitude.** Standard attestation takes 5 s on Stellar, 15–19
    min on OP-stack chains and Arbitrum, and **6–32 h on Linea**
    (cctp_concepts_finality-and-block-confirmations.md).

Against that, Xebra's integration surface is `GET /v1/quote` and `/v1/transfers` plus the
`@xebra/sdk` package. **But it covers only Xebra's 20 live routes**, so the "easier" claim applies
to those routes, not to "CCTP everywhere".

## What this proves

1. **Stellar USDC cannot reach NEAR Intents through 1Click, and no aggregator sampled takes Stellar
   as a source.** 1Click refused all 19 Stellar-origin USDC quotes (sizes 0.1 to 10M; destinations Base, NEAR and Solana), plus Stellar XLM.
   LI.FI, Relay, deBridge, Across and Mayan do not list Stellar. Xebra's Stellar→Base→NEAR path has
   a mainnet proof (36 s burn-to-wallet). The claim "the only tested path for Stellar USDC into NEAR
   Intents" is supported. Allbridge Core supports Stellar but could not be reached from this
   environment (DNS failure), so "the only path" in absolute terms is not proven.
2. **A flat fee beats percentage bridges at size.** At 100k, the T2 price of about $0.10–0.17
   compares with Across $10, Relay $10, 1Click $20, deBridge $84 and LI.FI $250. Against Across and
   Relay the T2 break-even is roughly **$1,000–1,700**, and against 1Click roughly **$500–850**.
   Below that, those providers are cheaper.
3. **The proposed tiers cut Xebra's own live price by 2–6×** on Stellar→Base: $0.30 today vs $0.05
   (T1), $0.10–0.15 (T2) and $0.15–0.20 (T3), at the same Circle cost.
4. **CCTP is the right rail for size.** Circle's per-message limit is 10M on-chain, while Across
   caps at about 537k–992k per pair, Relay refuses 5M, and 1Click refuses 1M ("No liquidity
   available").
5. **Direct CCTP integration carries real, documented hazards.** There are 14 distinct items above,
   including two where Circle's docs say funds can be permanently stuck (the Stellar
   `destinationCaller`/`mintRecipient` rule) and a 5-minute global lockout on rate-limit breach.
6. **Circle's Forwarding Service cannot deliver to Stellar or Sui.** Delivery there (for example
   Xebra's Sui→Stellar route) needs someone to run a relayer.

## What this does NOT prove (do not claim)

- **"Uncapped"**: false today. The live Stellar route refuses anything above 100 USDC (HTTP 422).
  The 10M raise needs the 48 h timelock proposal and commit first.
- **"Cheaper than CCTP direct"**: false by construction. Standard CCTP is free, and self-relay costs
  only destination gas ($0.002 on Base). Every Xebra tier is CCTP plus a fee.
- **"Cheaper than Circle's Forwarding Service"**: false on most pairs. T2 is above Circle's
  forwarding fee on Base→Arb ($0.11–0.17 vs $0.07), Eth→Base, Stellar→Base ($0.10–0.15 vs
  $0.054), Pol→Avax and Base→Sol. T2 is cheaper only on Arb→Eth ($0.13 vs $0.84), and only if Xebra
  runs its own relayer and Ethereum gas stays near today's unusually low 0.08 gwei. If delivery
  goes through Circle forwarding, Xebra is always Circle + $0.10.
- **"Cheaper than Mayan"**: Mayan's MCTP (CCTP + relayer, flat) is $0.005–0.07 on the EVM pairs
  sampled, below T2 everywhere except Arb→Eth.
- **"Cheaper than aggregators" at small sizes**: at 10–100 USDC on Base→Arb, Eth→Base and
  Pol→Avax, Across ($0.004–0.02), 1Click ($0.004–0.04) and Relay ($0.02–0.03) beat every Xebra
  tier. On Arb→Eth, Across ($0.02–0.03) still beats every tier.
- **"1Click charges 0.2–0.25% without a JWT"**: not what the API returned today. The dry quotes
  came to about 0.02% at size.
- **"Faster"**: Xebra uses Standard finality, which is 15–19 min from Ethereum, Base and Arbitrum
  sources. Across fills in seconds. Xebra is fast only where Standard is already fast (Stellar ~5 s,
  Sui, Arc).
- **Any EVM→EVM or Base→Solana Xebra price as a live fact**: those routes are not offered by
  `/v1/routes`. The rows are what the proposed tiers *would* cost.
- **"Billions of Stellar USDC locked out"**: the sourced figure is about $353M.

## Gaps

- Allbridge Core (the main other Stellar bridge) could not be reached: `core.api.allbridgecoreapi.net`
  did not resolve from this machine. Stargate's quote API is deprecated in favour of LayerZero's
  `transfer.layerzero-api.com`, which returned `Unauthorized` without a key.
- Solana and Stellar destination gas were not measured from mint transactions. Solana uses Circle's
  forward fee minus $0.05.
- No Arbitrum `depositForBurn` sample turned up in the 40k-block window; Arbitrum source gas is
  estimated (114k gas × current gas price).
- 1Click, Relay, Across and the others are dry or indicative quotes from one 25-minute window.
  Real execution, slippage and quote drift were not tested, except the one live Stellar→NEAR run
  noted above.
- deBridge's `fixFee` is converted at the CoinGecko price in this window.

## Files

- `raw/iris_fees_{src}_{dst}.json`: Circle fee API with `?forward=true`. `_noforward` variants are
  for destinations where forwarding returns 400.
- `raw/iris_fastburn_allowance.json`, `raw/circle_burn_limits_per_message.json`: Circle caps.
- `raw/{across,relay,lifi,debridge,mayan,oneclick}_{src}_{dst}_{size}.json`: quotes.
  `raw/across_limits_*.json` holds Across limits.
- `raw/gas_{chain}.json` and `raw/gas_burn_{chain}.json`: gas price plus sampled mint/burn tx
  receipts.
- `raw/xebra_routes.json`, `raw/xebra_quote_*.json`: Xebra's live API.
- `raw/oneclick_tokens.json`, `raw/lifi_chains.json`, `raw/relay_chains.json`,
  `raw/debridge_chains.json`: chain and asset coverage.
- `raw/circle_stablecoins_api.json`, `raw/horizon_usdc_asset.json`,
  `raw/llama_summary_dexs_near-intents.json`, `raw/stellar_fee_stats.json`,
  `raw/prices_coingecko.json`: market data.
- `docs/*.md`: Circle developer docs as fetched.
- `quotes.csv`, `quotes.json`: normalised rows (provider, route, fee USD, fee %, received, cap,
  ETA, source file, fetchedAtUtc, note).
- `scripts/`: `quotes.mjs` (aggregator quotes), `gas.mjs` / `burn.mjs` (on-chain gas sampling),
  `analyze.py` (normalisation and tables), `f.sh` (curl wrapper).
  Run with `NODE_OPTIONS=--no-network-family-autoselection`.

## Every row, with received amount, cap, ETA, source and timestamp


<details><summary>Base -> Arbitrum: every row</summary>

| Size | Provider | Route | Fee USD | Fee % | Received | Cap / limit | ETA | Source | Fetched (UTC) | Note |
|---|---|---|---|---|---|---|---|---|---|---|
| 10 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0074 | 0.0736 | 10 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_6_3.json + raw/gas_arb.json (median of 15 receiveMessage txs, 2026-11-13T12:10:20.395Z)` | 2026-11-13T11:57:31.169Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 10 | Circle CCTP V2 direct | Fast (1.3 bps), self-relay | 0.0087 | 0.0866 | 9.9987 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~8 s + mint | `raw/iris_fees_6_3.json` | 2026-11-13T11:57:31.169Z |  |
| 10 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0704 | 0.7039 | 9.929605 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_6_3.json (forwardFee.med)` | 2026-11-13T11:57:31.169Z | No destination gas or signer needed |
| 10 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 0.0717 | 0.7169 | 9.928305 | Fast allowance (global) | ~8 s + forward | `raw/iris_fees_6_3.json` | 2026-11-13T11:57:31.169Z |  |
| 10 | Xebra (proposed) | T1 0.05 flat, user claims | 0.0574 | 0.5736 | 9.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:31.169Z | User still pays destination gas |
| 10 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1074 | 1.0736 | 9.892636 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:31.169Z |  |
| 10 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.1588 | 1.5882 | 9.841183 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_base.json (median of 2 depositForBurn txs))` | 2026-11-13T11:57:31.169Z |  |
| 10 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1704 | 1.704 | 9.829605 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:31.169Z |  |
| 10 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2218 | 2.2185 | 9.778152 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:31.169Z |  |
| 10 | Across | suggested-fees | 0.008 | 0.0801 | 9.991992 | max 544,991; instant max 73,415 | 2 s | `raw/across_base_arb_10.json` | 2026-11-13T12:02:41.739Z |  |
| 10 | Relay | quote | 0.0234 | 0.2337 | 9.976635 | see 5M probe | 1 s | `raw/relay_base_arb_10.json` | 2026-11-13T12:03:24.455Z | excl. source gas |
| 10 | LI.FI | Polymer (Standard) | 0.025 | 0.25 | 9.975 | - | 1080 s | `raw/lifi_base_arb_10.json` | 2026-11-13T12:03:24.424Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 10 | deBridge DLN | quote | 2.2157 | 22.1575 | 9.992004 | - | 1 s | `raw/debridge_base_arb_10.json` | 2026-11-13T12:03:24.485Z | user sends 10.245572 (opex prepended) + fixFee 0.001 native ($1.96) |
| 10 | Mayan | FAST_MCTP | 0.0514 | 0.5144 | 9.948559 | - | 35 s | `raw/mayan_base_arb_10.json` | 2026-11-13T12:03:24.486Z |  |
| 10 | Mayan | MCTP | 0.0705 | 0.705 | 9.929502 | - | 1200 s | `raw/mayan_base_arb_10.json` | 2026-11-13T12:03:24.486Z |  |
| 10 | NEAR Intents 1Click | dry quote, no JWT | 0.0065 | 0.0645 | 9.993546 | 1M base->arb: 'No liquidity available' | 34 s | `raw/oneclick_base_arb_10.json` | 2026-11-13T12:05:52.426Z |  |
| 100 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0074 | 0.0074 | 100 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_6_3.json + raw/gas_arb.json (median of 15 receiveMessage txs, 2026-11-13T12:10:20.395Z)` | 2026-11-13T11:57:31.169Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 100 | Circle CCTP V2 direct | Fast (1.3 bps), self-relay | 0.0204 | 0.0204 | 99.987 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~8 s + mint | `raw/iris_fees_6_3.json` | 2026-11-13T11:57:31.169Z |  |
| 100 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0704 | 0.0704 | 99.929605 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_6_3.json (forwardFee.med)` | 2026-11-13T11:57:31.169Z | No destination gas or signer needed |
| 100 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 0.0834 | 0.0834 | 99.916605 | Fast allowance (global) | ~8 s + forward | `raw/iris_fees_6_3.json` | 2026-11-13T11:57:31.169Z |  |
| 100 | Xebra (proposed) | T1 0.05 flat, user claims | 0.0574 | 0.0574 | 99.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:31.169Z | User still pays destination gas |
| 100 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1074 | 0.1074 | 99.892636 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:31.169Z |  |
| 100 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.1588 | 0.1588 | 99.841183 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_base.json (median of 2 depositForBurn txs))` | 2026-11-13T11:57:31.169Z |  |
| 100 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1704 | 0.1704 | 99.829605 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:31.169Z |  |
| 100 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2218 | 0.2218 | 99.778152 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:31.169Z |  |
| 100 | Across | suggested-fees | 0.017 | 0.017 | 99.982992 | max 544,991; instant max 73,415 | 2 s | `raw/across_base_arb_100.json` | 2026-11-13T12:02:43.048Z |  |
| 100 | Relay | quote | 0.0324 | 0.0324 | 99.967629 | see 5M probe | 1 s | `raw/relay_base_arb_100.json` | 2026-11-13T12:03:28.957Z | excl. source gas |
| 100 | LI.FI | Polymer (Standard) | 0.25 | 0.25 | 99.75 | - | 1080 s | `raw/lifi_base_arb_100.json` | 2026-11-13T12:03:31.010Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 100 | deBridge DLN | quote | 2.2877 | 2.2877 | 99.920018 | - | 1 s | `raw/debridge_base_arb_100.json` | 2026-11-13T12:03:28.231Z | user sends 100.245539 (opex prepended) + fixFee 0.001 native ($1.96) |
| 100 | Mayan | FAST_MCTP | 0.0913 | 0.0913 | 99.908703 | - | 35 s | `raw/mayan_base_arb_100.json` | 2026-11-13T12:03:28.399Z |  |
| 100 | Mayan | MCTP | 0.0705 | 0.0705 | 99.929524 | - | 1200 s | `raw/mayan_base_arb_100.json` | 2026-11-13T12:03:28.399Z |  |
| 100 | NEAR Intents 1Click | dry quote, no JWT | 0.012 | 0.012 | 99.987973 | 1M base->arb: 'No liquidity available' | 34 s | `raw/oneclick_base_arb_100.json` | 2026-11-13T12:05:56.552Z |  |
| 1,000 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0074 | 0.0007 | 1000 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_6_3.json + raw/gas_arb.json (median of 15 receiveMessage txs, 2026-11-13T12:10:20.395Z)` | 2026-11-13T11:57:31.169Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 1,000 | Circle CCTP V2 direct | Fast (1.3 bps), self-relay | 0.1374 | 0.0137 | 999.87 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~8 s + mint | `raw/iris_fees_6_3.json` | 2026-11-13T11:57:31.169Z |  |
| 1,000 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0704 | 0.007 | 999.929605 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_6_3.json (forwardFee.med)` | 2026-11-13T11:57:31.169Z | No destination gas or signer needed |
| 1,000 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 0.2004 | 0.02 | 999.799605 | Fast allowance (global) | ~8 s + forward | `raw/iris_fees_6_3.json` | 2026-11-13T11:57:31.169Z |  |
| 1,000 | Xebra (proposed) | T1 0.05 flat, user claims | 0.0574 | 0.0057 | 999.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:31.169Z | User still pays destination gas |
| 1,000 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1074 | 0.0107 | 999.892636 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:31.169Z |  |
| 1,000 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.1588 | 0.0159 | 999.841183 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_base.json (median of 2 depositForBurn txs))` | 2026-11-13T11:57:31.169Z |  |
| 1,000 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1704 | 0.017 | 999.829605 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:31.169Z |  |
| 1,000 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2218 | 0.0222 | 999.778152 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:31.169Z |  |
| 1,000 | Across | suggested-fees | 0.107 | 0.0107 | 999.892992 | max 544,991; instant max 73,415 | 2 s | `raw/across_base_arb_1000.json` | 2026-11-13T12:02:44.360Z |  |
| 1,000 | Relay | quote | 0.1224 | 0.0122 | 999.877636 | see 5M probe | 1 s | `raw/relay_base_arb_1000.json` | 2026-11-13T12:03:30.648Z | excl. source gas |
| 1,000 | LI.FI | Polymer (Standard) | 2.5 | 0.25 | 997.5 | - | 1080 s | `raw/lifi_base_arb_1000.json` | 2026-11-13T12:03:35.754Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 1,000 | deBridge DLN | quote | 3.0075 | 0.3008 | 999.200162 | - | 1 s | `raw/debridge_base_arb_1000.json` | 2026-11-13T12:03:29.756Z | user sends 1,000.245527 (opex prepended) + fixFee 0.001 native ($1.96) |
| 1,000 | Mayan | FAST_MCTP | 0.49 | 0.049 | 999.510006 | - | 35 s | `raw/mayan_base_arb_1000.json` | 2026-11-13T12:03:30.256Z |  |
| 1,000 | Mayan | MCTP | 0.0705 | 0.007 | 999.929528 | - | 1200 s | `raw/mayan_base_arb_1000.json` | 2026-11-13T12:03:30.256Z |  |
| 1,000 | NEAR Intents 1Click | dry quote, no JWT | 0.1973 | 0.0197 | 999.802709 | 1M base->arb: 'No liquidity available' | 34 s | `raw/oneclick_base_arb_1000.json` | 2026-11-13T12:05:58.734Z |  |
| 10,000 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0074 | 0.0001 | 10000 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_6_3.json + raw/gas_arb.json (median of 15 receiveMessage txs, 2026-11-13T12:10:20.395Z)` | 2026-11-13T11:57:31.169Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 10,000 | Circle CCTP V2 direct | Fast (1.3 bps), self-relay | 1.3074 | 0.0131 | 9998.7 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~8 s + mint | `raw/iris_fees_6_3.json` | 2026-11-13T11:57:31.169Z |  |
| 10,000 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0704 | 0.0007 | 9999.929605 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_6_3.json (forwardFee.med)` | 2026-11-13T11:57:31.169Z | No destination gas or signer needed |
| 10,000 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 1.3704 | 0.0137 | 9998.629605 | Fast allowance (global) | ~8 s + forward | `raw/iris_fees_6_3.json` | 2026-11-13T11:57:31.169Z |  |
| 10,000 | Xebra (proposed) | T1 0.05 flat, user claims | 0.0574 | 0.0006 | 9999.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:31.169Z | User still pays destination gas |
| 10,000 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1074 | 0.0011 | 9999.892636 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:31.169Z |  |
| 10,000 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.1588 | 0.0016 | 9999.841183 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_base.json (median of 2 depositForBurn txs))` | 2026-11-13T11:57:31.169Z |  |
| 10,000 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1704 | 0.0017 | 9999.829605 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:31.169Z |  |
| 10,000 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2218 | 0.0022 | 9999.778152 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:31.169Z |  |
| 10,000 | Across | suggested-fees | 1.007 | 0.0101 | 9998.992967 | max 544,991; instant max 73,415 | 1 s | `raw/across_base_arb_10000.json` | 2026-11-13T12:02:45.701Z |  |
| 10,000 | Relay | quote | 1.0224 | 0.0102 | 9998.977635 | see 5M probe | 1 s | `raw/relay_base_arb_10000.json` | 2026-11-13T12:03:32.260Z | excl. source gas |
| 10,000 | LI.FI | Polymer (Standard) | 25.0 | 0.25 | 9975.0 | - | 1080 s | `raw/lifi_base_arb_10000.json` | 2026-11-13T12:03:40.169Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 10,000 | deBridge DLN | quote | 10.3718 | 0.1037 | 9992.001602 | - | 1 s | `raw/debridge_base_arb_10000.json` | 2026-11-13T12:03:31.274Z | user sends 10,000.411243 (opex prepended) + fixFee 0.001 native ($1.96) |
| 10,000 | Mayan | FAST_MCTP | 4.477 | 0.0448 | 9995.523006 | - | 35 s | `raw/mayan_base_arb_10000.json` | 2026-11-13T12:03:31.948Z |  |
| 10,000 | Mayan | MCTP | 0.0705 | 0.0007 | 9999.929528 | - | 1200 s | `raw/mayan_base_arb_10000.json` | 2026-11-13T12:03:31.948Z |  |
| 10,000 | NEAR Intents 1Click | dry quote, no JWT | 0.7244 | 0.0072 | 9999.275619 | 1M base->arb: 'No liquidity available' | 34 s | `raw/oneclick_base_arb_10000.json` | 2026-11-13T12:06:00.935Z |  |
| 100,000 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0074 | 0.0 | 100000 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_6_3.json + raw/gas_arb.json (median of 15 receiveMessage txs, 2026-11-13T12:10:20.395Z)` | 2026-11-13T11:57:31.169Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 100,000 | Circle CCTP V2 direct | Fast (1.3 bps), self-relay | 13.0074 | 0.013 | 99987.0 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~8 s + mint | `raw/iris_fees_6_3.json` | 2026-11-13T11:57:31.169Z |  |
| 100,000 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0704 | 0.0001 | 99999.929605 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_6_3.json (forwardFee.med)` | 2026-11-13T11:57:31.169Z | No destination gas or signer needed |
| 100,000 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 13.0704 | 0.0131 | 99986.929605 | Fast allowance (global) | ~8 s + forward | `raw/iris_fees_6_3.json` | 2026-11-13T11:57:31.169Z |  |
| 100,000 | Xebra (proposed) | T1 0.05 flat, user claims | 0.0574 | 0.0001 | 99999.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:31.169Z | User still pays destination gas |
| 100,000 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1074 | 0.0001 | 99999.892636 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:31.169Z |  |
| 100,000 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.1588 | 0.0002 | 99999.841183 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_base.json (median of 2 depositForBurn txs))` | 2026-11-13T11:57:31.169Z |  |
| 100,000 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1704 | 0.0002 | 99999.829605 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:31.169Z |  |
| 100,000 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2218 | 0.0002 | 99999.778152 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:31.169Z |  |
| 100,000 | Across | suggested-fees | 10.007 | 0.01 | 99989.992982 | max 544,991; instant max 73,415 | 900 s | `raw/across_base_arb_100000.json` | 2026-11-13T12:02:47.010Z |  |
| 100,000 | Relay | quote | 10.0224 | 0.01 | 99989.977635 | see 5M probe | 1 s | `raw/relay_base_arb_100000.json` | 2026-11-13T12:03:33.865Z | excl. source gas |
| 100,000 | LI.FI | Polymer (Standard) | 250.0 | 0.25 | 99750.0 | - | 1080 s | `raw/lifi_base_arb_100000.json` | 2026-11-13T12:03:45.456Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 100,000 | deBridge DLN | quote | 84.4207 | 0.0844 | 99920.016002 | - | 5 s | `raw/debridge_base_arb_100000.json` | 2026-11-13T12:03:32.721Z | user sends 100,002.474520 (opex prepended) + fixFee 0.001 native ($1.96) |
| 100,000 | Mayan | FAST_MCTP | 44.347 | 0.0443 | 99955.653006 | - | 35 s | `raw/mayan_base_arb_100000.json` | 2026-11-13T12:03:33.636Z |  |
| 100,000 | Mayan | MCTP | 0.0705 | 0.0001 | 99999.929528 | - | 1200 s | `raw/mayan_base_arb_100000.json` | 2026-11-13T12:03:33.636Z |  |
| 100,000 | NEAR Intents 1Click | dry quote, no JWT | 20.2043 | 0.0202 | 99979.79574 | 1M base->arb: 'No liquidity available' | 34 s | `raw/oneclick_base_arb_100000.json` | 2026-11-13T12:06:03.158Z |  |

</details>

<details><summary>Ethereum -> Base: every row</summary>

| Size | Provider | Route | Fee USD | Fee % | Received | Cap / limit | ETA | Source | Fetched (UTC) | Note |
|---|---|---|---|---|---|---|---|---|---|---|
| 10 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.002 | 0.0202 | 10 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_0_6.json + raw/gas_base.json (median of 15 receiveMessage txs, 2026-11-13T12:12:03.586Z)` | 2026-11-13T11:57:33.110Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 10 | Circle CCTP V2 direct | Fast (1 bps), self-relay | 0.003 | 0.0302 | 9.999 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~20 s + mint | `raw/iris_fees_0_6.json` | 2026-11-13T11:57:33.110Z |  |
| 10 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0539 | 0.5387 | 9.94613 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_0_6.json (forwardFee.med)` | 2026-11-13T11:57:33.110Z | No destination gas or signer needed |
| 10 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 0.0549 | 0.5487 | 9.94513 | Fast allowance (global) | ~20 s + forward | `raw/iris_fees_0_6.json` | 2026-11-13T11:57:33.110Z |  |
| 10 | Xebra (proposed) | T1 0.05 flat, user claims | 0.052 | 0.5202 | 9.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:33.110Z | User still pays destination gas |
| 10 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.102 | 1.0202 | 9.897978 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:33.110Z |  |
| 10 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.6161 | 6.1607 | 9.38393 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_eth.json (median of 12 depositForBurn txs))` | 2026-11-13T11:57:33.110Z |  |
| 10 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1539 | 1.5387 | 9.84613 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:33.110Z |  |
| 10 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.6679 | 6.6792 | 9.332082 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:33.110Z |  |
| 10 | Across | suggested-fees | 0.0044 | 0.0437 | 9.995634 | max 925,802; instant max 454,227 | 2 s | `raw/across_eth_base_10.json` | 2026-11-13T12:02:49.560Z |  |
| 10 | Relay | quote | 0.0218 | 0.2183 | 9.978172 | see 5M probe | 1 s | `raw/relay_eth_base_10.json` | 2026-11-13T12:03:35.516Z | excl. source gas |
| 10 | LI.FI | AcrossV4 | 0.0294 | 0.2936 | 9.970638 | - | 2 s | `raw/lifi_eth_base_10.json` | 2026-11-13T12:03:49.872Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 10 | deBridge DLN | quote | 2.2257 | 22.2568 | 9.992004 | - | 2 s | `raw/debridge_eth_base_10.json` | 2026-11-13T12:03:34.410Z | user sends 10.255501 (opex prepended) + fixFee 0.001 native ($1.96) |
| 10 | Mayan | FAST_MCTP | 0.0077 | 0.0772 | 9.992283 | - | 35 s | `raw/mayan_eth_base_10.json` | 2026-11-13T12:03:35.272Z |  |
| 10 | Mayan | MCTP | 0.0054 | 0.0538 | 9.994622 | - | 900 s | `raw/mayan_eth_base_10.json` | 2026-11-13T12:03:35.272Z |  |
| 10 | NEAR Intents 1Click | dry quote, no JWT | 0.0037 | 0.0368 | 9.996321 | 1M base->arb: 'No liquidity available' | 47 s | `raw/oneclick_eth_base_10.json` | 2026-11-13T12:06:05.270Z |  |
| 100 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.002 | 0.002 | 100 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_0_6.json + raw/gas_base.json (median of 15 receiveMessage txs, 2026-11-13T12:12:03.586Z)` | 2026-11-13T11:57:33.110Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 100 | Circle CCTP V2 direct | Fast (1 bps), self-relay | 0.012 | 0.012 | 99.99 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~20 s + mint | `raw/iris_fees_0_6.json` | 2026-11-13T11:57:33.110Z |  |
| 100 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0539 | 0.0539 | 99.94613 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_0_6.json (forwardFee.med)` | 2026-11-13T11:57:33.110Z | No destination gas or signer needed |
| 100 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 0.0639 | 0.0639 | 99.93613 | Fast allowance (global) | ~20 s + forward | `raw/iris_fees_0_6.json` | 2026-11-13T11:57:33.110Z |  |
| 100 | Xebra (proposed) | T1 0.05 flat, user claims | 0.052 | 0.052 | 99.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:33.110Z | User still pays destination gas |
| 100 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.102 | 0.102 | 99.897978 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:33.110Z |  |
| 100 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.6161 | 0.6161 | 99.38393 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_eth.json (median of 12 depositForBurn txs))` | 2026-11-13T11:57:33.110Z |  |
| 100 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1539 | 0.1539 | 99.84613 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:33.110Z |  |
| 100 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.6679 | 0.6679 | 99.332082 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:33.110Z |  |
| 100 | Across | suggested-fees | 0.0134 | 0.0134 | 99.986634 | max 925,802; instant max 454,227 | 2 s | `raw/across_eth_base_100.json` | 2026-11-13T12:02:50.841Z |  |
| 100 | Relay | quote | 0.0309 | 0.0309 | 99.969146 | see 5M probe | 1 s | `raw/relay_eth_base_100.json` | 2026-11-13T12:03:37.130Z | excl. source gas |
| 100 | LI.FI | AcrossV4 | 0.2633 | 0.2633 | 99.736659 | - | 2 s | `raw/lifi_eth_base_100.json` | 2026-11-13T12:03:54.031Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 100 | deBridge DLN | quote | 2.2977 | 2.2977 | 99.920018 | - | 2 s | `raw/debridge_eth_base_100.json` | 2026-11-13T12:03:35.862Z | user sends 100.255501 (opex prepended) + fixFee 0.001 native ($1.96) |
| 100 | Mayan | FAST_MCTP | 0.0446 | 0.0446 | 99.955383 | - | 35 s | `raw/mayan_eth_base_100.json` | 2026-11-13T12:03:36.920Z |  |
| 100 | Mayan | MCTP | 0.0054 | 0.0054 | 99.994622 | - | 900 s | `raw/mayan_eth_base_100.json` | 2026-11-13T12:03:36.920Z |  |
| 100 | NEAR Intents 1Click | dry quote, no JWT | 0.0226 | 0.0226 | 99.977401 | 1M base->arb: 'No liquidity available' | 47 s | `raw/oneclick_eth_base_100.json` | 2026-11-13T12:06:07.371Z |  |
| 1,000 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.002 | 0.0002 | 1000 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_0_6.json + raw/gas_base.json (median of 15 receiveMessage txs, 2026-11-13T12:12:03.586Z)` | 2026-11-13T11:57:33.110Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 1,000 | Circle CCTP V2 direct | Fast (1 bps), self-relay | 0.102 | 0.0102 | 999.9 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~20 s + mint | `raw/iris_fees_0_6.json` | 2026-11-13T11:57:33.110Z |  |
| 1,000 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0539 | 0.0054 | 999.94613 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_0_6.json (forwardFee.med)` | 2026-11-13T11:57:33.110Z | No destination gas or signer needed |
| 1,000 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 0.1539 | 0.0154 | 999.84613 | Fast allowance (global) | ~20 s + forward | `raw/iris_fees_0_6.json` | 2026-11-13T11:57:33.110Z |  |
| 1,000 | Xebra (proposed) | T1 0.05 flat, user claims | 0.052 | 0.0052 | 999.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:33.110Z | User still pays destination gas |
| 1,000 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.102 | 0.0102 | 999.897978 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:33.110Z |  |
| 1,000 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.6161 | 0.0616 | 999.38393 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_eth.json (median of 12 depositForBurn txs))` | 2026-11-13T11:57:33.110Z |  |
| 1,000 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1539 | 0.0154 | 999.84613 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:33.110Z |  |
| 1,000 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.6679 | 0.0668 | 999.332082 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:33.110Z |  |
| 1,000 | Across | suggested-fees | 0.1034 | 0.0103 | 999.896633 | max 925,802; instant max 454,227 | 2 s | `raw/across_eth_base_1000.json` | 2026-11-13T12:02:52.144Z |  |
| 1,000 | Relay | quote | 0.1209 | 0.0121 | 999.879146 | see 5M probe | 1 s | `raw/relay_eth_base_1000.json` | 2026-11-13T12:03:38.754Z | excl. source gas |
| 1,000 | LI.FI | Polymer (Standard) | 2.5 | 0.25 | 997.5 | - | 1080 s | `raw/lifi_eth_base_1000.json` | 2026-11-13T12:03:58.186Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 1,000 | deBridge DLN | quote | 3.0175 | 0.3018 | 999.200162 | - | 2 s | `raw/debridge_eth_base_1000.json` | 2026-11-13T12:03:37.691Z | user sends 1,000.255500 (opex prepended) + fixFee 0.001 native ($1.96) |
| 1,000 | Mayan | FAST_MCTP | 0.4136 | 0.0414 | 999.586383 | - | 35 s | `raw/mayan_eth_base_1000.json` | 2026-11-13T12:03:38.569Z |  |
| 1,000 | Mayan | MCTP | 0.0054 | 0.0005 | 999.994622 | - | 900 s | `raw/mayan_eth_base_1000.json` | 2026-11-13T12:03:38.569Z |  |
| 1,000 | NEAR Intents 1Click | dry quote, no JWT | 0.1936 | 0.0194 | 999.806412 | 1M base->arb: 'No liquidity available' | 47 s | `raw/oneclick_eth_base_1000.json` | 2026-11-13T12:06:09.439Z |  |
| 10,000 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.002 | 0.0 | 10000 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_0_6.json + raw/gas_base.json (median of 15 receiveMessage txs, 2026-11-13T12:12:03.586Z)` | 2026-11-13T11:57:33.110Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 10,000 | Circle CCTP V2 direct | Fast (1 bps), self-relay | 1.002 | 0.01 | 9999.0 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~20 s + mint | `raw/iris_fees_0_6.json` | 2026-11-13T11:57:33.110Z |  |
| 10,000 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0539 | 0.0005 | 9999.94613 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_0_6.json (forwardFee.med)` | 2026-11-13T11:57:33.110Z | No destination gas or signer needed |
| 10,000 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 1.0539 | 0.0105 | 9998.94613 | Fast allowance (global) | ~20 s + forward | `raw/iris_fees_0_6.json` | 2026-11-13T11:57:33.110Z |  |
| 10,000 | Xebra (proposed) | T1 0.05 flat, user claims | 0.052 | 0.0005 | 9999.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:33.110Z | User still pays destination gas |
| 10,000 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.102 | 0.001 | 9999.897978 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:33.110Z |  |
| 10,000 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.6161 | 0.0062 | 9999.38393 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_eth.json (median of 12 depositForBurn txs))` | 2026-11-13T11:57:33.110Z |  |
| 10,000 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1539 | 0.0015 | 9999.84613 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:33.110Z |  |
| 10,000 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.6679 | 0.0067 | 9999.332082 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:33.110Z |  |
| 10,000 | Across | suggested-fees | 1.0034 | 0.01 | 9998.996634 | max 925,802; instant max 454,227 | 5 s | `raw/across_eth_base_10000.json` | 2026-11-13T12:02:53.424Z |  |
| 10,000 | Relay | quote | 1.0208 | 0.0102 | 9998.979207 | see 5M probe | 24 s | `raw/relay_eth_base_10000.json` | 2026-11-13T12:03:40.368Z | excl. source gas |
| 10,000 | LI.FI | Polymer (Standard) | 25.0 | 0.25 | 9975.0 | - | 1080 s | `raw/lifi_eth_base_10000.json` | 2026-11-13T12:04:02.589Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 10,000 | deBridge DLN | quote | 10.3862 | 0.1039 | 9992.001602 | - | 2 s | `raw/debridge_eth_base_10000.json` | 2026-11-13T12:03:40.235Z | user sends 10,000.425595 (opex prepended) + fixFee 0.001 native ($1.96) |
| 10,000 | Mayan | FAST_MCTP | 4.1036 | 0.041 | 9995.896383 | - | 35 s | `raw/mayan_eth_base_10000.json` | 2026-11-13T12:03:40.242Z |  |
| 10,000 | Mayan | MCTP | 0.0054 | 0.0001 | 9999.994622 | - | 900 s | `raw/mayan_eth_base_10000.json` | 2026-11-13T12:03:40.242Z |  |
| 10,000 | NEAR Intents 1Click | dry quote, no JWT | 1.9145 | 0.0191 | 9998.085543 | 1M base->arb: 'No liquidity available' | 47 s | `raw/oneclick_eth_base_10000.json` | 2026-11-13T12:06:11.536Z |  |
| 100,000 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.002 | 0.0 | 100000 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_0_6.json + raw/gas_base.json (median of 15 receiveMessage txs, 2026-11-13T12:12:03.586Z)` | 2026-11-13T11:57:33.110Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 100,000 | Circle CCTP V2 direct | Fast (1 bps), self-relay | 10.002 | 0.01 | 99990.0 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~20 s + mint | `raw/iris_fees_0_6.json` | 2026-11-13T11:57:33.110Z |  |
| 100,000 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0539 | 0.0001 | 99999.94613 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_0_6.json (forwardFee.med)` | 2026-11-13T11:57:33.110Z | No destination gas or signer needed |
| 100,000 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 10.0539 | 0.0101 | 99989.94613 | Fast allowance (global) | ~20 s + forward | `raw/iris_fees_0_6.json` | 2026-11-13T11:57:33.110Z |  |
| 100,000 | Xebra (proposed) | T1 0.05 flat, user claims | 0.052 | 0.0001 | 99999.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:33.110Z | User still pays destination gas |
| 100,000 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.102 | 0.0001 | 99999.897978 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:33.110Z |  |
| 100,000 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.6161 | 0.0006 | 99999.38393 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_eth.json (median of 12 depositForBurn txs))` | 2026-11-13T11:57:33.110Z |  |
| 100,000 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1539 | 0.0002 | 99999.84613 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:33.110Z |  |
| 100,000 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.6679 | 0.0007 | 99999.332082 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:33.110Z |  |
| 100,000 | Across | suggested-fees | 10.0034 | 0.01 | 99989.996623 | max 925,802; instant max 454,227 | 27 s | `raw/across_eth_base_100000.json` | 2026-11-13T12:02:54.768Z |  |
| 100,000 | Relay | quote | 10.0208 | 0.01 | 99989.979207 | see 5M probe | 24 s | `raw/relay_eth_base_100000.json` | 2026-11-13T12:03:42.016Z | excl. source gas |
| 100,000 | LI.FI | Polymer (Standard) | 250.0 | 0.25 | 99750.0 | - | 1080 s | `raw/lifi_eth_base_100000.json` | 2026-11-13T12:04:07.066Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 100,000 | deBridge DLN | quote | 84.4939 | 0.0845 | 99920.016002 | - | 26 s | `raw/debridge_eth_base_100000.json` | 2026-11-13T12:03:41.660Z | user sends 100,002.547767 (opex prepended) + fixFee 0.001 native ($1.96) |
| 100,000 | Mayan | FAST_MCTP | 41.0036 | 0.041 | 99958.996383 | - | 35 s | `raw/mayan_eth_base_100000.json` | 2026-11-13T12:03:41.940Z |  |
| 100,000 | Mayan | MCTP | 0.0054 | 0.0 | 99999.994622 | - | 900 s | `raw/mayan_eth_base_100000.json` | 2026-11-13T12:03:41.940Z |  |
| 100,000 | NEAR Intents 1Click | dry quote, no JWT | 20.2014 | 0.0202 | 99979.79864 | 1M base->arb: 'No liquidity available' | 47 s | `raw/oneclick_eth_base_100000.json` | 2026-11-13T12:06:13.665Z |  |

</details>

<details><summary>Arbitrum -> Ethereum: every row</summary>

| Size | Provider | Route | Fee USD | Fee % | Received | Cap / limit | ETA | Source | Fetched (UTC) | Note |
|---|---|---|---|---|---|---|---|---|---|---|
| 10 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0295 | 0.2954 | 10 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_3_0.json + raw/gas_eth.json (median of 15 receiveMessage txs, 2026-11-13T12:10:56.713Z)` | 2026-11-13T11:57:34.764Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 10 | Circle CCTP V2 direct | Fast (1.4 bps), self-relay | 0.0309 | 0.3094 | 9.9986 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~8 s + mint | `raw/iris_fees_3_0.json` | 2026-11-13T11:57:34.764Z |  |
| 10 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.8436 | 8.4356 | 9.156442 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_3_0.json (forwardFee.med)` | 2026-11-13T11:57:34.764Z | No destination gas or signer needed |
| 10 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 0.845 | 8.4496 | 9.155042 | Fast allowance (global) | ~8 s + forward | `raw/iris_fees_3_0.json` | 2026-11-13T11:57:34.764Z |  |
| 10 | Xebra (proposed) | T1 0.05 flat, user claims | 0.0795 | 0.7954 | 9.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:34.764Z | User still pays destination gas |
| 10 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1295 | 1.2954 | 9.870456 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:34.764Z |  |
| 10 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.184 | 1.8403 | 9.815973 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (114,000 gas (Base/Ethereum depositForBurn median) x eth_gasPrice on Arbitrum (raw/gas_burn_arb.json); no direct sample in window)` | 2026-11-13T11:57:34.764Z |  |
| 10 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.9436 | 9.4356 | 9.056442 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:34.764Z |  |
| 10 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.998 | 9.9804 | 9.001959 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:34.764Z |  |
| 10 | Across | suggested-fees | 0.0209 | 0.2086 | 9.979136 | max 471,575; instant max 471,575 | 8 s | `raw/across_arb_eth_10.json` | 2026-11-13T12:02:57.278Z |  |
| 10 | Relay | quote | 0.0686 | 0.6861 | 9.93139 | see 5M probe | 3 s | `raw/relay_arb_eth_10.json` | 2026-11-13T12:03:43.657Z | excl. source gas |
| 10 | LI.FI | AcrossV4 | 0.0512 | 0.5117 | 9.948826 | - | 8 s | `raw/lifi_arb_eth_10.json` | 2026-11-13T12:04:11.332Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 10 | deBridge DLN | quote | 2.2456 | 22.4557 | 9.992004 | - | 12 s | `raw/debridge_arb_eth_10.json` | 2026-11-13T12:03:43.068Z | user sends 10.275391 (opex prepended) + fixFee 0.001 native ($1.96) |
| 10 | Mayan | FAST_MCTP | 1.177 | 11.77 | 8.823001 | - | 35 s | `raw/mayan_arb_eth_10.json` | 2026-11-13T12:03:43.641Z |  |
| 10 | Mayan | MCTP | 0.8289 | 8.2888 | 9.171117 | - | 1200 s | `raw/mayan_arb_eth_10.json` | 2026-11-13T12:03:43.641Z |  |
| 10 | NEAR Intents 1Click | dry quote, no JWT | 0.3011 | 3.011 | 9.698902 | 1M base->arb: 'No liquidity available' | 32 s | `raw/oneclick_arb_eth_10.json` | 2026-11-13T12:06:15.822Z |  |
| 100 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0295 | 0.0295 | 100 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_3_0.json + raw/gas_eth.json (median of 15 receiveMessage txs, 2026-11-13T12:10:56.713Z)` | 2026-11-13T11:57:34.764Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 100 | Circle CCTP V2 direct | Fast (1.4 bps), self-relay | 0.0435 | 0.0435 | 99.986 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~8 s + mint | `raw/iris_fees_3_0.json` | 2026-11-13T11:57:34.764Z |  |
| 100 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.8436 | 0.8436 | 99.156442 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_3_0.json (forwardFee.med)` | 2026-11-13T11:57:34.764Z | No destination gas or signer needed |
| 100 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 0.8576 | 0.8576 | 99.142442 | Fast allowance (global) | ~8 s + forward | `raw/iris_fees_3_0.json` | 2026-11-13T11:57:34.764Z |  |
| 100 | Xebra (proposed) | T1 0.05 flat, user claims | 0.0795 | 0.0795 | 99.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:34.764Z | User still pays destination gas |
| 100 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1295 | 0.1295 | 99.870456 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:34.764Z |  |
| 100 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.184 | 0.184 | 99.815973 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (114,000 gas (Base/Ethereum depositForBurn median) x eth_gasPrice on Arbitrum (raw/gas_burn_arb.json); no direct sample in window)` | 2026-11-13T11:57:34.764Z |  |
| 100 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.9436 | 0.9436 | 99.056442 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:34.764Z |  |
| 100 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.998 | 0.998 | 99.001959 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:34.764Z |  |
| 100 | Across | suggested-fees | 0.0299 | 0.0299 | 99.970136 | max 471,575; instant max 471,575 | 8 s | `raw/across_arb_eth_100.json` | 2026-11-13T12:02:58.858Z |  |
| 100 | Relay | quote | 0.0758 | 0.0758 | 99.92419 | see 5M probe | 3 s | `raw/relay_arb_eth_100.json` | 2026-11-13T12:03:45.260Z | excl. source gas |
| 100 | LI.FI | Polymer (Fast) | 0.2739 | 0.2739 | 99.72606 | - | 10 s | `raw/lifi_arb_eth_100.json` | 2026-11-13T12:04:15.265Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 100 | deBridge DLN | quote | 2.3193 | 2.3193 | 99.920018 | - | 12 s | `raw/debridge_arb_eth_100.json` | 2026-11-13T12:03:44.806Z | user sends 100.277123 (opex prepended) + fixFee 0.001 native ($1.96) |
| 100 | Mayan | FAST_MCTP | 1.2181 | 1.2181 | 98.781946 | - | 35 s | `raw/mayan_arb_eth_100.json` | 2026-11-13T12:03:45.307Z |  |
| 100 | Mayan | MCTP | 0.829 | 0.829 | 99.170962 | - | 1200 s | `raw/mayan_arb_eth_100.json` | 2026-11-13T12:03:45.307Z |  |
| 100 | NEAR Intents 1Click | dry quote, no JWT | 0.3111 | 0.3111 | 99.688857 | 1M base->arb: 'No liquidity available' | 32 s | `raw/oneclick_arb_eth_100.json` | 2026-11-13T12:06:17.979Z |  |
| 1,000 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0295 | 0.003 | 1000 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_3_0.json + raw/gas_eth.json (median of 15 receiveMessage txs, 2026-11-13T12:10:56.713Z)` | 2026-11-13T11:57:34.764Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 1,000 | Circle CCTP V2 direct | Fast (1.4 bps), self-relay | 0.1695 | 0.017 | 999.86 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~8 s + mint | `raw/iris_fees_3_0.json` | 2026-11-13T11:57:34.764Z |  |
| 1,000 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.8436 | 0.0844 | 999.156442 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_3_0.json (forwardFee.med)` | 2026-11-13T11:57:34.764Z | No destination gas or signer needed |
| 1,000 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 0.9836 | 0.0984 | 999.016442 | Fast allowance (global) | ~8 s + forward | `raw/iris_fees_3_0.json` | 2026-11-13T11:57:34.764Z |  |
| 1,000 | Xebra (proposed) | T1 0.05 flat, user claims | 0.0795 | 0.008 | 999.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:34.764Z | User still pays destination gas |
| 1,000 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1295 | 0.013 | 999.870456 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:34.764Z |  |
| 1,000 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.184 | 0.0184 | 999.815973 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (114,000 gas (Base/Ethereum depositForBurn median) x eth_gasPrice on Arbitrum (raw/gas_burn_arb.json); no direct sample in window)` | 2026-11-13T11:57:34.764Z |  |
| 1,000 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.9436 | 0.0944 | 999.056442 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:34.764Z |  |
| 1,000 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.998 | 0.0998 | 999.001959 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:34.764Z |  |
| 1,000 | Across | suggested-fees | 0.1199 | 0.012 | 999.880136 | max 471,575; instant max 471,575 | 8 s | `raw/across_arb_eth_1000.json` | 2026-11-13T12:03:00.149Z |  |
| 1,000 | Relay | quote | 0.1478 | 0.0148 | 999.85219 | see 5M probe | 3 s | `raw/relay_arb_eth_1000.json` | 2026-11-13T12:03:46.841Z | excl. source gas |
| 1,000 | LI.FI | AcrossV4 | 2.6242 | 0.2624 | 997.375803 | - | 8 s | `raw/lifi_arb_eth_1000.json` | 2026-11-13T12:04:19.787Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 1,000 | deBridge DLN | quote | 3.0392 | 0.3039 | 999.200162 | - | 12 s | `raw/debridge_arb_eth_1000.json` | 2026-11-13T12:03:46.219Z | user sends 1,000.277135 (opex prepended) + fixFee 0.001 native ($1.96) |
| 1,000 | Mayan | FAST_MCTP | 1.6267 | 0.1627 | 998.373346 | - | 35 s | `raw/mayan_arb_eth_1000.json` | 2026-11-13T12:03:46.980Z |  |
| 1,000 | Mayan | MCTP | 0.829 | 0.0829 | 999.170962 | - | 1200 s | `raw/mayan_arb_eth_1000.json` | 2026-11-13T12:03:46.980Z |  |
| 1,000 | NEAR Intents 1Click | dry quote, no JWT | 0.502 | 0.0502 | 999.49801 | 1M base->arb: 'No liquidity available' | 32 s | `raw/oneclick_arb_eth_1000.json` | 2026-11-13T12:06:20.089Z |  |
| 10,000 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0295 | 0.0003 | 10000 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_3_0.json + raw/gas_eth.json (median of 15 receiveMessage txs, 2026-11-13T12:10:56.713Z)` | 2026-11-13T11:57:34.764Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 10,000 | Circle CCTP V2 direct | Fast (1.4 bps), self-relay | 1.4295 | 0.0143 | 9998.6 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~8 s + mint | `raw/iris_fees_3_0.json` | 2026-11-13T11:57:34.764Z |  |
| 10,000 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.8436 | 0.0084 | 9999.156442 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_3_0.json (forwardFee.med)` | 2026-11-13T11:57:34.764Z | No destination gas or signer needed |
| 10,000 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 2.2436 | 0.0224 | 9997.756442 | Fast allowance (global) | ~8 s + forward | `raw/iris_fees_3_0.json` | 2026-11-13T11:57:34.764Z |  |
| 10,000 | Xebra (proposed) | T1 0.05 flat, user claims | 0.0795 | 0.0008 | 9999.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:34.764Z | User still pays destination gas |
| 10,000 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1295 | 0.0013 | 9999.870456 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:34.764Z |  |
| 10,000 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.184 | 0.0018 | 9999.815973 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (114,000 gas (Base/Ethereum depositForBurn median) x eth_gasPrice on Arbitrum (raw/gas_burn_arb.json); no direct sample in window)` | 2026-11-13T11:57:34.764Z |  |
| 10,000 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.9436 | 0.0094 | 9999.056442 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:34.764Z |  |
| 10,000 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.998 | 0.01 | 9999.001959 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:34.764Z |  |
| 10,000 | Across | suggested-fees | 1.0217 | 0.0102 | 9998.97827 | max 471,575; instant max 471,575 | 8 s | `raw/across_arb_eth_10000.json` | 2026-11-13T12:03:01.422Z |  |
| 10,000 | Relay | quote | 0.8678 | 0.0087 | 9999.132179 | see 5M probe | 3 s | `raw/relay_arb_eth_10000.json` | 2026-11-13T12:03:48.447Z | excl. source gas |
| 10,000 | LI.FI | Polymer (Standard) | 25.0 | 0.25 | 9975.0 | - | 1080 s | `raw/lifi_arb_eth_10000.json` | 2026-11-13T12:04:24.535Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 10,000 | deBridge DLN | quote | 10.4057 | 0.1041 | 9992.001602 | - | 12 s | `raw/debridge_arb_eth_10000.json` | 2026-11-13T12:03:47.642Z | user sends 10,000.445081 (opex prepended) + fixFee 0.001 native ($1.96) |
| 10,000 | Mayan | FAST_MCTP | 5.7127 | 0.0571 | 9994.287346 | - | 35 s | `raw/mayan_arb_eth_10000.json` | 2026-11-13T12:03:48.651Z |  |
| 10,000 | Mayan | MCTP | 0.829 | 0.0083 | 9999.170962 | - | 1200 s | `raw/mayan_arb_eth_10000.json` | 2026-11-13T12:03:48.651Z |  |
| 10,000 | NEAR Intents 1Click | dry quote, no JWT | 2.2098 | 0.0221 | 9997.790169 | 1M base->arb: 'No liquidity available' | 32 s | `raw/oneclick_arb_eth_10000.json` | 2026-11-13T12:06:22.415Z |  |
| 100,000 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0295 | 0.0 | 100000 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_3_0.json + raw/gas_eth.json (median of 15 receiveMessage txs, 2026-11-13T12:10:56.713Z)` | 2026-11-13T11:57:34.764Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 100,000 | Circle CCTP V2 direct | Fast (1.4 bps), self-relay | 14.0295 | 0.014 | 99986.0 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~8 s + mint | `raw/iris_fees_3_0.json` | 2026-11-13T11:57:34.764Z |  |
| 100,000 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.8436 | 0.0008 | 99999.156442 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_3_0.json (forwardFee.med)` | 2026-11-13T11:57:34.764Z | No destination gas or signer needed |
| 100,000 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 14.8436 | 0.0148 | 99985.156442 | Fast allowance (global) | ~8 s + forward | `raw/iris_fees_3_0.json` | 2026-11-13T11:57:34.764Z |  |
| 100,000 | Xebra (proposed) | T1 0.05 flat, user claims | 0.0795 | 0.0001 | 99999.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:34.764Z | User still pays destination gas |
| 100,000 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1295 | 0.0001 | 99999.870456 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:34.764Z |  |
| 100,000 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.184 | 0.0002 | 99999.815973 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (114,000 gas (Base/Ethereum depositForBurn median) x eth_gasPrice on Arbitrum (raw/gas_burn_arb.json); no direct sample in window)` | 2026-11-13T11:57:34.764Z |  |
| 100,000 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.9436 | 0.0009 | 99999.056442 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:34.764Z |  |
| 100,000 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.998 | 0.001 | 99999.001959 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:34.764Z |  |
| 100,000 | Across | suggested-fees | 10.0213 | 0.01 | 99989.978724 | max 471,575; instant max 471,575 | 9 s | `raw/across_arb_eth_100000.json` | 2026-11-13T12:03:02.936Z |  |
| 100,000 | Relay | quote | 8.068 | 0.0081 | 99991.931995 | see 5M probe | 3 s | `raw/relay_arb_eth_100000.json` | 2026-11-13T12:03:50.031Z | excl. source gas |
| 100,000 | LI.FI | Polymer (Standard) | 250.0 | 0.25 | 99750.0 | - | 1080 s | `raw/lifi_arb_eth_100000.json` | 2026-11-13T12:04:28.878Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 100,000 | deBridge DLN | quote | 84.4865 | 0.0845 | 99920.016002 | - | 18 s | `raw/debridge_arb_eth_100000.json` | 2026-11-13T12:03:49.078Z | user sends 100,002.540321 (opex prepended) + fixFee 0.001 native ($1.96) |
| 100,000 | Mayan | FAST_MCTP | 46.5725 | 0.0466 | 99953.427546 | - | 35 s | `raw/mayan_arb_eth_100000.json` | 2026-11-13T12:03:50.291Z |  |
| 100,000 | Mayan | MCTP | 0.8289 | 0.0008 | 99999.1711 | - | 1200 s | `raw/mayan_arb_eth_100000.json` | 2026-11-13T12:03:50.291Z |  |
| 100,000 | NEAR Intents 1Click | dry quote, no JWT | 19.4991 | 0.0195 | 99980.500937 | 1M base->arb: 'No liquidity available' | 32 s | `raw/oneclick_arb_eth_100000.json` | 2026-11-13T12:06:24.604Z |  |

</details>

<details><summary>Stellar -> Base: every row</summary>

| Size | Provider | Route | Fee USD | Fee % | Received | Cap / limit | ETA | Source | Fetched (UTC) | Note |
|---|---|---|---|---|---|---|---|---|---|---|
| 10 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.002 | 0.0202 | 10 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~5 s + mint | `raw/iris_fees_27_6.json + raw/gas_base.json (median of 15 receiveMessage txs, 2026-11-13T12:12:03.586Z)` | 2026-11-13T11:57:36.300Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 10 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0539 | 0.5387 | 9.94613 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~5 s + forward | `raw/iris_fees_27_6.json (forwardFee.med)` | 2026-11-13T11:57:36.300Z | No destination gas or signer needed |
| 10 | Xebra (proposed) | T1 0.05 flat, user claims | 0.052 | 0.5202 | 9.95 | proposed: none below Circle's 10M/message | ~5 s + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:36.300Z | User still pays destination gas |
| 10 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.102 | 1.0202 | 9.897978 | proposed | ~5 s + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:36.300Z |  |
| 10 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.1525 | 1.5248 | 9.847523 | proposed | ~5 s + delivery | `computed: 0.15 + dest gas + source gas (fee_charged of Xebra's mainnet burn 95efc874... (raw/stellar_xebra_burn_tx.json))` | 2026-11-13T11:57:36.300Z |  |
| 10 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1539 | 1.5387 | 9.84613 | proposed | ~5 s + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:36.300Z |  |
| 10 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2043 | 2.0433 | 9.795675 | proposed | ~5 s + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:36.300Z |  |
| 10 | Xebra (live today) | 0.10%, min 0.30 | 0.3 | 3.0 | 9.7 | max 100 USDC per transfer | ~36 s measured burn-to-wallet (2026-11-12) | `raw/xebra_quote_stellar_base_10.json` | 2026-11-13T12:14:36.146Z |  |
| 10 | NEAR Intents 1Click | - |  |  |  | Quoting for this pair is not available | - | `raw/oneclick_stellar_base_10.json` | 2026-11-13T12:06:26.660Z | REFUSED: Quoting for this pair is not available |
| 100 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.002 | 0.002 | 100 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~5 s + mint | `raw/iris_fees_27_6.json + raw/gas_base.json (median of 15 receiveMessage txs, 2026-11-13T12:12:03.586Z)` | 2026-11-13T11:57:36.300Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 100 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0539 | 0.0539 | 99.94613 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~5 s + forward | `raw/iris_fees_27_6.json (forwardFee.med)` | 2026-11-13T11:57:36.300Z | No destination gas or signer needed |
| 100 | Xebra (proposed) | T1 0.05 flat, user claims | 0.052 | 0.052 | 99.95 | proposed: none below Circle's 10M/message | ~5 s + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:36.300Z | User still pays destination gas |
| 100 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.102 | 0.102 | 99.897978 | proposed | ~5 s + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:36.300Z |  |
| 100 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.1525 | 0.1525 | 99.847523 | proposed | ~5 s + delivery | `computed: 0.15 + dest gas + source gas (fee_charged of Xebra's mainnet burn 95efc874... (raw/stellar_xebra_burn_tx.json))` | 2026-11-13T11:57:36.300Z |  |
| 100 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1539 | 0.1539 | 99.84613 | proposed | ~5 s + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:36.300Z |  |
| 100 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2043 | 0.2043 | 99.795675 | proposed | ~5 s + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:36.300Z |  |
| 100 | Xebra (live today) | 0.10%, min 0.30 | 0.3 | 0.3 | 99.7 | max 100 USDC per transfer | ~36 s measured burn-to-wallet (2026-11-12) | `raw/xebra_quote_stellar_base_100.json` | 2026-11-13T12:14:38.631Z |  |
| 100 | NEAR Intents 1Click | - |  |  |  | Quoting for this pair is not available | - | `raw/oneclick_stellar_base_100.json` | 2026-11-13T12:06:28.412Z | REFUSED: Quoting for this pair is not available |
| 1,000 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.002 | 0.0002 | 1000 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~5 s + mint | `raw/iris_fees_27_6.json + raw/gas_base.json (median of 15 receiveMessage txs, 2026-11-13T12:12:03.586Z)` | 2026-11-13T11:57:36.300Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 1,000 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0539 | 0.0054 | 999.94613 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~5 s + forward | `raw/iris_fees_27_6.json (forwardFee.med)` | 2026-11-13T11:57:36.300Z | No destination gas or signer needed |
| 1,000 | Xebra (proposed) | T1 0.05 flat, user claims | 0.052 | 0.0052 | 999.95 | proposed: none below Circle's 10M/message | ~5 s + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:36.300Z | User still pays destination gas |
| 1,000 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.102 | 0.0102 | 999.897978 | proposed | ~5 s + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:36.300Z |  |
| 1,000 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.1525 | 0.0152 | 999.847523 | proposed | ~5 s + delivery | `computed: 0.15 + dest gas + source gas (fee_charged of Xebra's mainnet burn 95efc874... (raw/stellar_xebra_burn_tx.json))` | 2026-11-13T11:57:36.300Z |  |
| 1,000 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1539 | 0.0154 | 999.84613 | proposed | ~5 s + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:36.300Z |  |
| 1,000 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2043 | 0.0204 | 999.795675 | proposed | ~5 s + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:36.300Z |  |
| 1,000 | Xebra (live today) | 0.10%, min 0.30 |  |  |  | The bridge contract takes at most 100.00 USDC per transfer. | - | `raw/xebra_quote_stellar_base_1000.json` | 2026-11-13T12:14:40.562Z | REFUSED: above cap |
| 1,000 | NEAR Intents 1Click | - |  |  |  | Quoting for this pair is not available | - | `raw/oneclick_stellar_base_1000.json` | 2026-11-13T12:06:30.201Z | REFUSED: Quoting for this pair is not available |
| 10,000 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.002 | 0.0 | 10000 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~5 s + mint | `raw/iris_fees_27_6.json + raw/gas_base.json (median of 15 receiveMessage txs, 2026-11-13T12:12:03.586Z)` | 2026-11-13T11:57:36.300Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 10,000 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0539 | 0.0005 | 9999.94613 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~5 s + forward | `raw/iris_fees_27_6.json (forwardFee.med)` | 2026-11-13T11:57:36.300Z | No destination gas or signer needed |
| 10,000 | Xebra (proposed) | T1 0.05 flat, user claims | 0.052 | 0.0005 | 9999.95 | proposed: none below Circle's 10M/message | ~5 s + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:36.300Z | User still pays destination gas |
| 10,000 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.102 | 0.001 | 9999.897978 | proposed | ~5 s + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:36.300Z |  |
| 10,000 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.1525 | 0.0015 | 9999.847523 | proposed | ~5 s + delivery | `computed: 0.15 + dest gas + source gas (fee_charged of Xebra's mainnet burn 95efc874... (raw/stellar_xebra_burn_tx.json))` | 2026-11-13T11:57:36.300Z |  |
| 10,000 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1539 | 0.0015 | 9999.84613 | proposed | ~5 s + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:36.300Z |  |
| 10,000 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2043 | 0.002 | 9999.795675 | proposed | ~5 s + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:36.300Z |  |
| 10,000 | Xebra (live today) | 0.10%, min 0.30 |  |  |  | max 100 USDC per transfer | - | `raw/xebra_quote_stellar_base_1000.json (422)` |  | REFUSED: above cap |
| 10,000 | NEAR Intents 1Click | - |  |  |  | Quoting for this pair is not available | - | `raw/oneclick_stellar_base_10000.json` | 2026-11-13T12:06:31.965Z | REFUSED: Quoting for this pair is not available |
| 100,000 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.002 | 0.0 | 100000 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~5 s + mint | `raw/iris_fees_27_6.json + raw/gas_base.json (median of 15 receiveMessage txs, 2026-11-13T12:12:03.586Z)` | 2026-11-13T11:57:36.300Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 100,000 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0539 | 0.0001 | 99999.94613 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~5 s + forward | `raw/iris_fees_27_6.json (forwardFee.med)` | 2026-11-13T11:57:36.300Z | No destination gas or signer needed |
| 100,000 | Xebra (proposed) | T1 0.05 flat, user claims | 0.052 | 0.0001 | 99999.95 | proposed: none below Circle's 10M/message | ~5 s + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:36.300Z | User still pays destination gas |
| 100,000 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.102 | 0.0001 | 99999.897978 | proposed | ~5 s + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:36.300Z |  |
| 100,000 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.1525 | 0.0002 | 99999.847523 | proposed | ~5 s + delivery | `computed: 0.15 + dest gas + source gas (fee_charged of Xebra's mainnet burn 95efc874... (raw/stellar_xebra_burn_tx.json))` | 2026-11-13T11:57:36.300Z |  |
| 100,000 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1539 | 0.0002 | 99999.84613 | proposed | ~5 s + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:36.300Z |  |
| 100,000 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2043 | 0.0002 | 99999.795675 | proposed | ~5 s + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:36.300Z |  |
| 100,000 | Xebra (live today) | 0.10%, min 0.30 |  |  |  | max 100 USDC per transfer | - | `raw/xebra_quote_stellar_base_1000.json (422)` |  | REFUSED: above cap |
| 100,000 | NEAR Intents 1Click | - |  |  |  | Quoting for this pair is not available | - | `raw/oneclick_stellar_base_100000.json` | 2026-11-13T12:06:33.695Z | REFUSED: Quoting for this pair is not available |

</details>

<details><summary>Base -> Solana: every row</summary>

| Size | Provider | Route | Fee USD | Fee % | Received | Cap / limit | ETA | Source | Fetched (UTC) | Note |
|---|---|---|---|---|---|---|---|---|---|---|
| 10 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0589 | 0.5886 | 10 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_6_5.json + Circle forwardFee.med(6->5) minus Circle's $0.05 service fee (raw/iris_fees_6_5.json); recipient USDC account already exists` | 2026-11-13T11:57:38.180Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 10 | Circle CCTP V2 direct | Fast (1.3 bps), self-relay | 0.0602 | 0.6016 | 9.9987 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~8 s + mint | `raw/iris_fees_6_5.json` | 2026-11-13T11:57:38.180Z |  |
| 10 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.1089 | 1.0886 | 9.891136 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_6_5.json (forwardFee.med)` | 2026-11-13T11:57:38.180Z | No destination gas or signer needed |
| 10 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 0.1102 | 1.1016 | 9.889836 | Fast allowance (global) | ~8 s + forward | `raw/iris_fees_6_5.json` | 2026-11-13T11:57:38.180Z |  |
| 10 | Xebra (proposed) | T1 0.05 flat, user claims | 0.1089 | 1.0886 | 9.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:38.180Z | User still pays destination gas |
| 10 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1589 | 1.5886 | 9.841136 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:38.180Z |  |
| 10 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.2103 | 2.1032 | 9.789683 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_base.json (median of 2 depositForBurn txs))` | 2026-11-13T11:57:38.180Z |  |
| 10 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.2089 | 2.0886 | 9.791136 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:38.180Z |  |
| 10 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2603 | 2.6032 | 9.739683 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:38.180Z |  |
| 10 | Across | - |  |  |  | Route is not enabled. | - | `raw/across_base_sol_10.json` | 2026-11-13T12:03:05.891Z | NO ROUTE |
| 10 | Relay | quote | 0.024 | 0.2401 | 9.975995 | see 5M probe | 1 s | `raw/relay_base_sol_10.json` | 2026-11-13T12:03:51.615Z | excl. source gas |
| 10 | LI.FI | Relay | 0.0486 | 0.4857 | 9.951432 | - | 1 s | `raw/lifi_base_sol_10.json` | 2026-11-13T12:04:33.124Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 10 | deBridge DLN | quote | 2.6864 | 26.8635 | 9.992004 | - | 1 s | `raw/debridge_base_sol_10.json` | 2026-11-13T12:03:50.509Z | user sends 10.716178 (opex prepended) + fixFee 0.001 native ($1.96) |
| 10 | Mayan | MCTP | 1.5385 | 15.3848 | 8.461524 | - | 1200 s | `raw/mayan_base_sol_10.json` | 2026-11-13T12:03:51.944Z |  |
| 10 | NEAR Intents 1Click | dry quote, no JWT | 0.011 | 0.1099 | 9.989006 | 1M base->arb: 'No liquidity available' | 32 s | `raw/oneclick_base_sol_10.json` | 2026-11-13T12:06:35.468Z |  |
| 100 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0589 | 0.0589 | 100 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_6_5.json + Circle forwardFee.med(6->5) minus Circle's $0.05 service fee (raw/iris_fees_6_5.json); recipient USDC account already exists` | 2026-11-13T11:57:38.180Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 100 | Circle CCTP V2 direct | Fast (1.3 bps), self-relay | 0.0719 | 0.0719 | 99.987 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~8 s + mint | `raw/iris_fees_6_5.json` | 2026-11-13T11:57:38.180Z |  |
| 100 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.1089 | 0.1089 | 99.891136 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_6_5.json (forwardFee.med)` | 2026-11-13T11:57:38.180Z | No destination gas or signer needed |
| 100 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 0.1219 | 0.1219 | 99.878136 | Fast allowance (global) | ~8 s + forward | `raw/iris_fees_6_5.json` | 2026-11-13T11:57:38.180Z |  |
| 100 | Xebra (proposed) | T1 0.05 flat, user claims | 0.1089 | 0.1089 | 99.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:38.180Z | User still pays destination gas |
| 100 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1589 | 0.1589 | 99.841136 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:38.180Z |  |
| 100 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.2103 | 0.2103 | 99.789683 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_base.json (median of 2 depositForBurn txs))` | 2026-11-13T11:57:38.180Z |  |
| 100 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.2089 | 0.2089 | 99.791136 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:38.180Z |  |
| 100 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2603 | 0.2603 | 99.739683 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:38.180Z |  |
| 100 | Across | - |  |  |  | Route is not enabled. | - | `raw/across_base_sol_100.json` | 2026-11-13T12:03:07.163Z | NO ROUTE |
| 100 | Relay | quote | 0.051 | 0.051 | 99.948995 | see 5M probe | 1 s | `raw/relay_base_sol_100.json` | 2026-11-13T12:03:53.322Z | excl. source gas |
| 100 | LI.FI | Relay | 0.3003 | 0.3003 | 99.699732 | - | 1 s | `raw/lifi_base_sol_100.json` | 2026-11-13T12:04:39.791Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 100 | deBridge DLN | quote | 2.7583 | 2.7583 | 99.920018 | - | 1 s | `raw/debridge_base_sol_100.json` | 2026-11-13T12:03:52.174Z | user sends 100.716178 (opex prepended) + fixFee 0.001 native ($1.96) |
| 100 | Mayan | MCTP | 1.5385 | 1.5385 | 98.461524 | - | 1200 s | `raw/mayan_base_sol_100.json` | 2026-11-13T12:03:53.574Z |  |
| 100 | NEAR Intents 1Click | dry quote, no JWT | 0.0177 | 0.0177 | 99.982291 | 1M base->arb: 'No liquidity available' | 32 s | `raw/oneclick_base_sol_100.json` | 2026-11-13T12:06:37.667Z |  |
| 1,000 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0589 | 0.0059 | 1000 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_6_5.json + Circle forwardFee.med(6->5) minus Circle's $0.05 service fee (raw/iris_fees_6_5.json); recipient USDC account already exists` | 2026-11-13T11:57:38.180Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 1,000 | Circle CCTP V2 direct | Fast (1.3 bps), self-relay | 0.1889 | 0.0189 | 999.87 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~8 s + mint | `raw/iris_fees_6_5.json` | 2026-11-13T11:57:38.180Z |  |
| 1,000 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.1089 | 0.0109 | 999.891136 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_6_5.json (forwardFee.med)` | 2026-11-13T11:57:38.180Z | No destination gas or signer needed |
| 1,000 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 0.2389 | 0.0239 | 999.761136 | Fast allowance (global) | ~8 s + forward | `raw/iris_fees_6_5.json` | 2026-11-13T11:57:38.180Z |  |
| 1,000 | Xebra (proposed) | T1 0.05 flat, user claims | 0.1089 | 0.0109 | 999.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:38.180Z | User still pays destination gas |
| 1,000 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1589 | 0.0159 | 999.841136 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:38.180Z |  |
| 1,000 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.2103 | 0.021 | 999.789683 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_base.json (median of 2 depositForBurn txs))` | 2026-11-13T11:57:38.180Z |  |
| 1,000 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.2089 | 0.0209 | 999.791136 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:38.180Z |  |
| 1,000 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2603 | 0.026 | 999.739683 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:38.180Z |  |
| 1,000 | Across | - |  |  |  | Route is not enabled. | - | `raw/across_base_sol_1000.json` | 2026-11-13T12:03:08.367Z | NO ROUTE |
| 1,000 | Relay | quote | 0.321 | 0.0321 | 999.678995 | see 5M probe | 1 s | `raw/relay_base_sol_1000.json` | 2026-11-13T12:03:54.977Z | excl. source gas |
| 1,000 | LI.FI | Relay | 2.8196 | 0.282 | 997.180426 | - | 1 s | `raw/lifi_base_sol_1000.json` | 2026-11-13T12:04:45.964Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 1,000 | deBridge DLN | quote | 3.4782 | 0.3478 | 999.200162 | - | 1 s | `raw/debridge_base_sol_1000.json` | 2026-11-13T12:03:53.557Z | user sends 1,000.716178 (opex prepended) + fixFee 0.001 native ($1.96) |
| 1,000 | Mayan | MCTP | 1.5385 | 0.1538 | 998.461524 | - | 1200 s | `raw/mayan_base_sol_1000.json` | 2026-11-13T12:03:55.263Z |  |
| 1,000 | NEAR Intents 1Click | dry quote, no JWT | 0.1012 | 0.0101 | 999.898761 | 1M base->arb: 'No liquidity available' | 32 s | `raw/oneclick_base_sol_1000.json` | 2026-11-13T12:06:39.760Z |  |
| 10,000 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0589 | 0.0006 | 10000 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_6_5.json + Circle forwardFee.med(6->5) minus Circle's $0.05 service fee (raw/iris_fees_6_5.json); recipient USDC account already exists` | 2026-11-13T11:57:38.180Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 10,000 | Circle CCTP V2 direct | Fast (1.3 bps), self-relay | 1.3589 | 0.0136 | 9998.7 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~8 s + mint | `raw/iris_fees_6_5.json` | 2026-11-13T11:57:38.180Z |  |
| 10,000 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.1089 | 0.0011 | 9999.891136 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_6_5.json (forwardFee.med)` | 2026-11-13T11:57:38.180Z | No destination gas or signer needed |
| 10,000 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 1.4089 | 0.0141 | 9998.591136 | Fast allowance (global) | ~8 s + forward | `raw/iris_fees_6_5.json` | 2026-11-13T11:57:38.180Z |  |
| 10,000 | Xebra (proposed) | T1 0.05 flat, user claims | 0.1089 | 0.0011 | 9999.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:38.180Z | User still pays destination gas |
| 10,000 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1589 | 0.0016 | 9999.841136 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:38.180Z |  |
| 10,000 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.2103 | 0.0021 | 9999.789683 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_base.json (median of 2 depositForBurn txs))` | 2026-11-13T11:57:38.180Z |  |
| 10,000 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.2089 | 0.0021 | 9999.791136 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:38.180Z |  |
| 10,000 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2603 | 0.0026 | 9999.739683 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:38.180Z |  |
| 10,000 | Across | - |  |  |  | Route is not enabled. | - | `raw/across_base_sol_10000.json` | 2026-11-13T12:03:09.610Z | NO ROUTE |
| 10,000 | Relay | quote | 3.021 | 0.0302 | 9996.978995 | see 5M probe | 1 s | `raw/relay_base_sol_10000.json` | 2026-11-13T12:03:56.784Z | excl. source gas |
| 10,000 | LI.FI | Layerswap | 27.407 | 0.2741 | 9972.592977 | - | 21 s | `raw/lifi_base_sol_10000.json` | 2026-11-13T12:04:51.549Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 10,000 | deBridge DLN | quote | 10.8839 | 0.1088 | 9992.001602 | - | 1 s | `raw/debridge_base_sol_10000.json` | 2026-11-13T12:03:54.975Z | user sends 10,000.923276 (opex prepended) + fixFee 0.001 native ($1.96) |
| 10,000 | Mayan | MCTP | 3.5376 | 0.0354 | 9996.462365 | - | 1200 s | `raw/mayan_base_sol_10000.json` | 2026-11-13T12:03:56.917Z |  |
| 10,000 | NEAR Intents 1Click | dry quote, no JWT | 1.0166 | 0.0102 | 9998.983438 | 1M base->arb: 'No liquidity available' | 32 s | `raw/oneclick_base_sol_10000.json` | 2026-11-13T12:06:41.916Z |  |
| 100,000 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0589 | 0.0001 | 100000 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + mint | `raw/iris_fees_6_5.json + Circle forwardFee.med(6->5) minus Circle's $0.05 service fee (raw/iris_fees_6_5.json); recipient USDC account already exists` | 2026-11-13T11:57:38.180Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 100,000 | Circle CCTP V2 direct | Fast (1.3 bps), self-relay | 13.0589 | 0.0131 | 99987.0 | Fast allowance 54,216,663 USDC global at 2026-11-13T11:57:58.896Z; above it falls back to Standard | ~8 s + mint | `raw/iris_fees_6_5.json` | 2026-11-13T11:57:38.180Z |  |
| 100,000 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.1089 | 0.0001 | 99999.891136 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | 15-19 min + forward | `raw/iris_fees_6_5.json (forwardFee.med)` | 2026-11-13T11:57:38.180Z | No destination gas or signer needed |
| 100,000 | Circle CCTP V2 direct | Fast + Circle Forwarding Service | 13.1089 | 0.0131 | 99986.891136 | Fast allowance (global) | ~8 s + forward | `raw/iris_fees_6_5.json` | 2026-11-13T11:57:38.180Z |  |
| 100,000 | Xebra (proposed) | T1 0.05 flat, user claims | 0.1089 | 0.0001 | 99999.95 | proposed: none below Circle's 10M/message | 15-19 min + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:38.180Z | User still pays destination gas |
| 100,000 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1589 | 0.0002 | 99999.841136 | proposed | 15-19 min + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:38.180Z |  |
| 100,000 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.2103 | 0.0002 | 99999.789683 | proposed | 15-19 min + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_base.json (median of 2 depositForBurn txs))` | 2026-11-13T11:57:38.180Z |  |
| 100,000 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.2089 | 0.0002 | 99999.791136 | proposed | 15-19 min + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:38.180Z |  |
| 100,000 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2603 | 0.0003 | 99999.739683 | proposed | 15-19 min + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:38.180Z |  |
| 100,000 | Across | - |  |  |  | Route is not enabled. | - | `raw/across_base_sol_100000.json` | 2026-11-13T12:03:11.192Z | NO ROUTE |
| 100,000 | Relay | quote | 30.021 | 0.03 | 99969.978995 | see 5M probe | 1 s | `raw/relay_base_sol_100000.json` | 2026-11-13T12:03:58.428Z | excl. source gas |
| 100,000 | LI.FI | Relay | 279.9453 | 0.2799 | 99720.054692 | - | 1 s | `raw/lifi_base_sol_100000.json` | 2026-11-13T12:04:58.038Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 100,000 | deBridge DLN | quote | 85.6031 | 0.0856 | 99920.016002 | - | 5 s | `raw/debridge_base_sol_100000.json` | 2026-11-13T12:03:56.397Z | user sends 100,003.656964 (opex prepended) + fixFee 0.001 native ($1.96) |
| 100,000 | Mayan | MCTP | 30.5301 | 0.0305 | 99969.469935 | - | 1200 s | `raw/mayan_base_sol_100000.json` | 2026-11-13T12:03:58.553Z |  |
| 100,000 | NEAR Intents 1Click | dry quote, no JWT | 20.209 | 0.0202 | 99979.791007 | 1M base->arb: 'No liquidity available' | 32 s | `raw/oneclick_base_sol_100000.json` | 2026-11-13T12:06:44.050Z |  |

</details>

<details><summary>Polygon -> Avalanche: every row</summary>

| Size | Provider | Route | Fee USD | Fee % | Received | Cap / limit | ETA | Source | Fetched (UTC) | Note |
|---|---|---|---|---|---|---|---|---|---|---|
| 10 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0108 | 0.1081 | 10 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~8 s + mint | `raw/iris_fees_7_1.json + raw/gas_avax.json (median of 9 receiveMessage txs, 2026-11-13T12:12:33.907Z)` | 2026-11-13T11:57:39.911Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 10 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0714 | 0.7136 | 9.928637 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~8 s + forward | `raw/iris_fees_7_1.json (forwardFee.med)` | 2026-11-13T11:57:39.911Z | No destination gas or signer needed |
| 10 | Xebra (proposed) | T1 0.05 flat, user claims | 0.0608 | 0.6081 | 9.95 | proposed: none below Circle's 10M/message | ~8 s + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:39.911Z | User still pays destination gas |
| 10 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1108 | 1.1081 | 9.889185 | proposed | ~8 s + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:39.911Z |  |
| 10 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.1653 | 1.6528 | 9.834725 | proposed | ~8 s + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_pol.json (median of 4 depositForBurn txs))` | 2026-11-13T11:57:39.911Z |  |
| 10 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1714 | 1.7136 | 9.828637 | proposed | ~8 s + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:39.911Z |  |
| 10 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2258 | 2.2582 | 9.774176 | proposed | ~8 s + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:39.911Z |  |
| 10 | Relay | quote | 0.0252 | 0.2522 | 9.974776 | see 5M probe | 1 s | `raw/relay_pol_avax_10.json` | 2026-11-13T12:04:00.061Z | excl. source gas |
| 10 | LI.FI | Polymer (Standard) | 0.025 | 0.25 | 9.975 | - | 1080 s | `raw/lifi_pol_avax_10.json` | 2026-11-13T12:05:02.814Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 10 | deBridge DLN | quote | 0.1186 | 1.1861 | 9.992003 | - | 2 s | `raw/debridge_pol_avax_10.json` | 2026-11-13T12:03:59.373Z | user sends 10.067036 (opex prepended) + fixFee 0.5 native ($0.04) |
| 10 | Mayan | FAST_MCTP | 0.0219 | 0.2194 | 9.978061 | - | 35 s | `raw/mayan_pol_avax_10.json` | 2026-11-13T12:04:00.174Z |  |
| 10 | Mayan | MCTP | 0.0284 | 0.2837 | 9.971633 | - | 360 s | `raw/mayan_pol_avax_10.json` | 2026-11-13T12:04:00.174Z |  |
| 10 | NEAR Intents 1Click | dry quote, no JWT | 0.0189 | 0.189 | 9.981104 | 1M base->arb: 'No liquidity available' | 38 s | `raw/oneclick_pol_avax_10.json` | 2026-11-13T12:06:46.196Z |  |
| 100 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0108 | 0.0108 | 100 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~8 s + mint | `raw/iris_fees_7_1.json + raw/gas_avax.json (median of 9 receiveMessage txs, 2026-11-13T12:12:33.907Z)` | 2026-11-13T11:57:39.911Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 100 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0714 | 0.0714 | 99.928637 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~8 s + forward | `raw/iris_fees_7_1.json (forwardFee.med)` | 2026-11-13T11:57:39.911Z | No destination gas or signer needed |
| 100 | Xebra (proposed) | T1 0.05 flat, user claims | 0.0608 | 0.0608 | 99.95 | proposed: none below Circle's 10M/message | ~8 s + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:39.911Z | User still pays destination gas |
| 100 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1108 | 0.1108 | 99.889185 | proposed | ~8 s + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:39.911Z |  |
| 100 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.1653 | 0.1653 | 99.834725 | proposed | ~8 s + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_pol.json (median of 4 depositForBurn txs))` | 2026-11-13T11:57:39.911Z |  |
| 100 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1714 | 0.1714 | 99.828637 | proposed | ~8 s + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:39.911Z |  |
| 100 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2258 | 0.2258 | 99.774176 | proposed | ~8 s + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:39.911Z |  |
| 100 | Relay | quote | 0.0341 | 0.0341 | 99.96589 | see 5M probe | 1 s | `raw/relay_pol_avax_100.json` | 2026-11-13T12:04:01.751Z | excl. source gas |
| 100 | LI.FI | Polymer (Standard) | 0.25 | 0.25 | 99.75 | - | 1080 s | `raw/lifi_pol_avax_100.json` | 2026-11-13T12:05:07.801Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 100 | deBridge DLN | quote | 0.1906 | 0.1906 | 99.920018 | - | 2 s | `raw/debridge_pol_avax_100.json` | 2026-11-13T12:04:00.865Z | user sends 100.067024 (opex prepended) + fixFee 0.5 native ($0.04) |
| 100 | Mayan | FAST_MCTP | 0.0489 | 0.0489 | 99.951061 | - | 35 s | `raw/mayan_pol_avax_100.json` | 2026-11-13T12:04:01.827Z |  |
| 100 | Mayan | MCTP | 0.0284 | 0.0284 | 99.971633 | - | 360 s | `raw/mayan_pol_avax_100.json` | 2026-11-13T12:04:01.827Z |  |
| 100 | NEAR Intents 1Click | dry quote, no JWT | 0.0371 | 0.0371 | 99.962925 | 1M base->arb: 'No liquidity available' | 38 s | `raw/oneclick_pol_avax_100.json` | 2026-11-13T12:06:48.286Z |  |
| 1,000 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0108 | 0.0011 | 1000 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~8 s + mint | `raw/iris_fees_7_1.json + raw/gas_avax.json (median of 9 receiveMessage txs, 2026-11-13T12:12:33.907Z)` | 2026-11-13T11:57:39.911Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 1,000 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0714 | 0.0071 | 999.928637 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~8 s + forward | `raw/iris_fees_7_1.json (forwardFee.med)` | 2026-11-13T11:57:39.911Z | No destination gas or signer needed |
| 1,000 | Xebra (proposed) | T1 0.05 flat, user claims | 0.0608 | 0.0061 | 999.95 | proposed: none below Circle's 10M/message | ~8 s + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:39.911Z | User still pays destination gas |
| 1,000 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1108 | 0.0111 | 999.889185 | proposed | ~8 s + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:39.911Z |  |
| 1,000 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.1653 | 0.0165 | 999.834725 | proposed | ~8 s + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_pol.json (median of 4 depositForBurn txs))` | 2026-11-13T11:57:39.911Z |  |
| 1,000 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1714 | 0.0171 | 999.828637 | proposed | ~8 s + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:39.911Z |  |
| 1,000 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2258 | 0.0226 | 999.774176 | proposed | ~8 s + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:39.911Z |  |
| 1,000 | Relay | quote | 0.1241 | 0.0124 | 999.87589 | see 5M probe | 1 s | `raw/relay_pol_avax_1000.json` | 2026-11-13T12:04:03.427Z | excl. source gas |
| 1,000 | LI.FI | Polymer (Standard) | 2.5 | 0.25 | 997.5 | - | 1080 s | `raw/lifi_pol_avax_1000.json` | 2026-11-13T12:05:12.503Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 1,000 | deBridge DLN | quote | 0.9104 | 0.091 | 999.200162 | - | 25 s | `raw/debridge_pol_avax_1000.json` | 2026-11-13T12:04:02.301Z | user sends 1,000.067028 (opex prepended) + fixFee 0.5 native ($0.04) |
| 1,000 | Mayan | FAST_MCTP | 0.3189 | 0.0319 | 999.681061 | - | 35 s | `raw/mayan_pol_avax_1000.json` | 2026-11-13T12:04:03.547Z |  |
| 1,000 | Mayan | MCTP | 0.0284 | 0.0028 | 999.971633 | - | 360 s | `raw/mayan_pol_avax_1000.json` | 2026-11-13T12:04:03.547Z |  |
| 1,000 | NEAR Intents 1Click | dry quote, no JWT | 0.2189 | 0.0219 | 999.781134 | 1M base->arb: 'No liquidity available' | 38 s | `raw/oneclick_pol_avax_1000.json` | 2026-11-13T12:06:50.422Z |  |
| 10,000 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0108 | 0.0001 | 10000 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~8 s + mint | `raw/iris_fees_7_1.json + raw/gas_avax.json (median of 9 receiveMessage txs, 2026-11-13T12:12:33.907Z)` | 2026-11-13T11:57:39.911Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 10,000 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0714 | 0.0007 | 9999.928637 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~8 s + forward | `raw/iris_fees_7_1.json (forwardFee.med)` | 2026-11-13T11:57:39.911Z | No destination gas or signer needed |
| 10,000 | Xebra (proposed) | T1 0.05 flat, user claims | 0.0608 | 0.0006 | 9999.95 | proposed: none below Circle's 10M/message | ~8 s + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:39.911Z | User still pays destination gas |
| 10,000 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1108 | 0.0011 | 9999.889185 | proposed | ~8 s + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:39.911Z |  |
| 10,000 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.1653 | 0.0017 | 9999.834725 | proposed | ~8 s + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_pol.json (median of 4 depositForBurn txs))` | 2026-11-13T11:57:39.911Z |  |
| 10,000 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1714 | 0.0017 | 9999.828637 | proposed | ~8 s + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:39.911Z |  |
| 10,000 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2258 | 0.0023 | 9999.774176 | proposed | ~8 s + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:39.911Z |  |
| 10,000 | Relay | quote | 1.0244 | 0.0102 | 9998.975552 | see 5M probe | 1 s | `raw/relay_pol_avax_10000.json` | 2026-11-13T12:04:05.225Z | excl. source gas |
| 10,000 | LI.FI | Polymer (Standard) | 25.0 | 0.25 | 9975.0 | - | 1080 s | `raw/lifi_pol_avax_10000.json` | 2026-11-13T12:05:16.910Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 10,000 | deBridge DLN | quote | 8.1457 | 0.0815 | 9992.001602 | - | 76 s | `raw/debridge_pol_avax_10000.json` | 2026-11-13T12:04:03.793Z | user sends 10,000.103777 (opex prepended) + fixFee 0.5 native ($0.04) |
| 10,000 | Mayan | FAST_MCTP | 3.0189 | 0.0302 | 9996.981057 | - | 35 s | `raw/mayan_pol_avax_10000.json` | 2026-11-13T12:04:05.242Z |  |
| 10,000 | Mayan | MCTP | 0.0284 | 0.0003 | 9999.971626 | - | 360 s | `raw/mayan_pol_avax_10000.json` | 2026-11-13T12:04:05.242Z |  |
| 10,000 | NEAR Intents 1Click | dry quote, no JWT | 2.0367 | 0.0204 | 9997.96326 | 1M base->arb: 'No liquidity available' | 38 s | `raw/oneclick_pol_avax_10000.json` | 2026-11-13T12:06:52.610Z |  |
| 100,000 | Circle CCTP V2 direct | Standard, integrator mints (self-relay) | 0.0108 | 0.0 | 100000 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~8 s + mint | `raw/iris_fees_7_1.json + raw/gas_avax.json (median of 9 receiveMessage txs, 2026-11-13T12:12:33.907Z)` | 2026-11-13T11:57:39.911Z | Fee = destination mint gas only; needs native gas + a signer on the destination |
| 100,000 | Circle CCTP V2 direct | Standard + Circle Forwarding Service | 0.0714 | 0.0001 | 99999.928637 | 10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap | ~8 s + forward | `raw/iris_fees_7_1.json (forwardFee.med)` | 2026-11-13T11:57:39.911Z | No destination gas or signer needed |
| 100,000 | Xebra (proposed) | T1 0.05 flat, user claims | 0.0608 | 0.0001 | 99999.95 | proposed: none below Circle's 10M/message | ~8 s + user claim | `computed: 0.05 + measured dest gas` | 2026-11-13T11:57:39.911Z | User still pays destination gas |
| 100,000 | Xebra (proposed) | T2 0.10 + dest gas, Xebra delivers | 0.1108 | 0.0001 | 99999.889185 | proposed | ~8 s + delivery | `computed: 0.10 + measured dest gas` | 2026-11-13T11:57:39.911Z |  |
| 100,000 | Xebra (proposed) | T3 0.15 + gas both ends, gasless | 0.1653 | 0.0002 | 99999.834725 | proposed | ~8 s + delivery | `computed: 0.15 + dest gas + source gas (raw/gas_burn_pol.json (median of 4 depositForBurn txs))` | 2026-11-13T11:57:39.911Z |  |
| 100,000 | Xebra (proposed) | T2 delivered via Circle Forwarding (how Xebra delivers today) | 0.1714 | 0.0002 | 99999.828637 | proposed | ~8 s + forward | `computed: 0.10 + Iris forwardFee.med` | 2026-11-13T11:57:39.911Z |  |
| 100,000 | Xebra (proposed) | T3 via Circle Forwarding + source gas | 0.2258 | 0.0002 | 99999.774176 | proposed | ~8 s + forward | `computed: 0.15 + Iris forwardFee.med + source gas` | 2026-11-13T11:57:39.911Z |  |
| 100,000 | Relay | quote | 10.0397 | 0.01 | 99989.960348 | see 5M probe | 1 s | `raw/relay_pol_avax_100000.json` | 2026-11-13T12:04:06.831Z | excl. source gas |
| 100,000 | LI.FI | Polymer (Standard) | 250.0 | 0.25 | 99750.0 | - | 1080 s | `raw/lifi_pol_avax_100000.json` | 2026-11-13T12:05:20.838Z | includes LI.FI 0.25% fixed fee (keyless API default) |
| 100,000 | deBridge DLN | quote | 80.5924 | 0.0806 | 99920.016002 | - | 370 s | `raw/debridge_pol_avax_100000.json` | 2026-11-13T12:04:06.217Z | user sends 100,000.564870 (opex prepended) + fixFee 0.5 native ($0.04) |
| 100,000 | Mayan | FAST_MCTP | 30.0189 | 0.03 | 99969.981057 | - | 35 s | `raw/mayan_pol_avax_100000.json` | 2026-11-13T12:04:06.915Z |  |
| 100,000 | Mayan | MCTP | 0.0284 | 0.0 | 99999.971626 | - | 360 s | `raw/mayan_pol_avax_100000.json` | 2026-11-13T12:04:06.915Z |  |
| 100,000 | NEAR Intents 1Click | dry quote, no JWT | 20.2158 | 0.0202 | 99979.784164 | 1M base->arb: 'No liquidity available' | 1838 s | `raw/oneclick_pol_avax_100000.json` | 2026-11-13T12:06:54.702Z |  |

</details>
