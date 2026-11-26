# Arc to Stellar, Arc to Sui, and Stellar to every chain

Written 2026-11-26, branch `arc-to-stellar-sui`. Nothing here has been sent on mainnet yet.

## Why Arc did not reach Stellar or Sui

**Arc to Stellar** was already built (`NEXT_PUBLIC_EVM_TO_STELLAR`, PR #16, 2026-11-15) and is off
only because production never set that variable. The pieces were all there:

- The API quotes it with no Circle fee and Xebra's flat fee beside the burn, and builds it
  straight to Circle's `TokenMessengerV2` on Arc (`depositForBurnWithHook`, domain 27,
  `mintRecipient` and `destinationCaller` both Circle's Stellar `CctpForwarder`, the hook naming the
  G… account). It never goes through Arc's fee wrapper: `XebraCctpWrapper.bridge` always sets
  `destinationCaller = 0` and the `cctp-forward` hook, so it cannot name the forwarder. No
  contract change is needed; the wrapper is simply not used for this route.
- The Stellar relayer (`/api/stellar-inbound/complete`) already accepts every EVM domain, Arc (26)
  included, from 1 USDC.

One real gap: a transfer built through `/v1` or the SDK was only finished if someone called the
relayer. The bridge page does; an API integrator polling `GET /v1/transfers/arc/{tx}` got
`needs_claim` forever. Now that poll hands the burn to the relayer, as Sui to Stellar already did.

**Arc to Sui** did not exist anywhere: the API had no Sui destination, the EVM burn encoder had no
Sui recipient (a string recipient to domain 8 would have been left-padded as an EVM address, a Sui
address nobody holds), and the Sui relayer only paid for Stellar wrapper burns. Built on this
branch:

- `@xebra/cctp-evm`: a `{ kind: "sui", address }` recipient. Domain 8 only, plain
  `depositForBurn` (no hook, Circle does not deliver to Sui), `destinationCaller` zero so the
  relayer or the recipient can mint. A string recipient to domain 8 is refused; the EVM wrapper
  refuses Sui.
- `NEXT_PUBLIC_EVM_TO_SUI` (same shape as `NEXT_PUBLIC_EVM_TO_STELLAR`), off unless set.
- API: `sui` as a destination (quote, build, status, `POST /v1/claims` with a Sui payer).
- Relayer: `/api/sui-inbound/complete` and `/status`, paying the Sui gas from the same key as the
  Stellar to Sui relayer (`SUI_RELAYER_SECRET`). It pays only for burns from chains named in
  `NEXT_PUBLIC_EVM_TO_SUI`, of at least 1 USDC, open to any caller. Off (404) with no key or no
  chain named.
- The Arc page: Sui and Stellar in the destination picker when switched on, each through the
  relayed panel; Sui falls back to a `/claim` link when the relayer is off or refuses.

Also on this branch, because the API had the same hole: **Stellar to Sui** in `/v1` (listed when
`NEXT_PUBLIC_STELLAR_TO_SUI=1` and the wrapper has domain 8 committed without forwarding, priced
with no delivery fee, built through the wrapper, relayed from a status poll, claimable with a Sui
payer). No route into Aptos exists in the app, so the API does not offer one.

Known limits, same as the EVM to Stellar relayer today: Xebra's flat fee on these routes is its own
EVM transaction after the burn, and neither relayer checks it was paid before paying gas. The 1 USDC
floor bounds the cost (one Stellar mint ≈ 0.01 XLM, one Sui mint ≈ 0.003 SUI).

## First mainnet proof, 1 to 2 USDC each way

Nothing is switched on until this is done. The variables are `NEXT_PUBLIC_*`, so they are baked in at
build time: a Vercel redeploy is needed after changing them.

### Before

1. Merge `arc-to-stellar-sui` into `dev`, then `dev` into `main` (the usual release PR).
2. Check the relayers have money:
   - Stellar relayer account (`SUI_STELLAR_RELAYER_SECRET`): a few XLM.
   - Sui relayer (`SUI_RELAYER_SECRET`): 0.119 SUI on 2026-11-25. Enough for ~40 mints; top up.
3. Have ready: an EVM wallet on Arc with about 5 USDC (Arc gas is USDC); a Stellar G… account with a
   USDC trustline; a Sui address (any wallet; it needs no SUI if the relayer runs).

### Switch on in a Preview first (no production change)

On a Vercel Preview deployment of the merged branch, set:

```
NEXT_PUBLIC_EVM_TO_STELLAR=arc
NEXT_PUBLIC_EVM_TO_SUI=arc
```

Leave `NEXT_PUBLIC_ARC_USE_WRAPPER=1` as it is in production: these two routes skip the wrapper
anyway, which is exactly what the proof should show. `GET <preview>/v1/routes` must now list
`arc -> stellar` and `arc -> sui`, Standard only.

### Arc to Stellar (1.5 USDC)

1. Open the Preview, pick Arc as source, Stellar as destination, 1.5 USDC, the G… recipient.
2. The Arc wallet signs three transactions: approve (to Circle's TokenMessenger
   `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`, **not** the wrapper `0x11b3…f4c3`), the burn, then
   Xebra's 0.01 fee transfer to `0x32e9…211A`.
3. Watch: the page polls `/api/stellar-inbound/complete` every 20 s. Arc attests in under a minute.
   Expect "Delivered on Stellar" and the USDC in the G… account (stellar.expert, account page).
4. Check on explorer.arc.io that the burn's `to` is the TokenMessenger and the event names
   destination domain 27.

### Arc to Sui (1.5 USDC)

1. Same page, Sui as destination, the Sui address (0x + 64 hex).
2. Same three signatures, burn to domain 8.
3. Watch: the page polls `/api/sui-inbound/complete`. Expect "Delivered on Sui" and the Sui digest;
   check suiscan.xyz for the recipient's USDC.
4. If it says the relayer is not running, check `SUI_RELAYER_SECRET` is set on that deployment, and
   finish the transfer at `/claim?tx=<burn>&src=26` with any Sui wallet instead: the USDC is safe.

### Through the API too (optional, proves the poll relays)

`POST /v1/transfers {from:"arc",to:"sui",amount:"1.5",sender,recipient}`, sign the steps with
the Arc wallet, then poll `GET /v1/transfers/arc/<burn>`: `pending`, then `delivering` with the
Sui digest, then `delivered`.

### Then production

Set the same two variables on Production in Vercel and redeploy. Record the four transaction hashes
(two burns, Stellar mint, Sui mint) in `evidence/`.

To switch off: clear the variable and redeploy. `/claim` needs no flag, so every transfer already
made can still be finished there. One difference: with `NEXT_PUBLIC_EVM_TO_SUI` cleared,
`/api/sui-inbound/complete` is off too, so an Arc to Sui transfer still in flight is then minted by
its owner at `/claim` rather than by the relayer.

## Why Stellar sends to only seven chains

Confirmed: `deps.stellarRoutes()` reads `get_domains` from the Stellar wrapper v2
(`CCPVTWII2TW6VVSVA4JQ2KFHICGBG4QVAHPIGUPSIW3E4VNPUI4Y2WQR`) and offers Solana always, Arc while
`NEXT_PUBLIC_ARC_ENABLED=1`, and each chain in `NEXT_PUBLIC_STELLAR_SENDS_TO` (production: `all`)
only once its domain is committed. Read on 2026-11-26 (simulation only):

| Domain | Chain | Committed |
|---|---|---|
| 2 | OP Mainnet | yes, forward, cap 0.25 USDC |
| 3 | Arbitrum | yes |
| 5 | Solana | yes, with account creation |
| 6 | Base | yes |
| 7 | Polygon | yes |
| 8 | Sui | yes, not forwarded (claim/relay) |
| 15 | Monad | yes |
| 26 | Arc | yes, cap 0.10 USDC |

Nothing is pending. Sui is the eighth; `/v1/routes` did not list it before this branch.

### What opens the rest (a plan: no call has been made)

The wrapper has **one** pending-domain slot and a **48-hour timelock** (`TIMELOCK_SECS = 172_800`):
`propose_domain(cfg)` by the admin, then `commit_domain()` by the admin once 48 h have passed.
Proposing while another proposal is pending replaces it. So each chain takes its own 48 hours, one
after another: 19 chains is about 38 days unless the contract is upgraded to take a batch.

Each call is the admin key (`xebra-admin` in the Stellar CLI), as in
`scripts/wrapper-sui-domain.sh`:

```
stellar contract invoke --id CCPVTWII2TW6VVSVA4JQ2KFHICGBG4QVAHPIGUPSIW3E4VNPUI4Y2WQR \
  --rpc-url https://mainnet.sorobanrpc.com \
  --network-passphrase "Public Global Stellar Network ; September 2015" \
  --source-account xebra-admin --send=yes -- \
  propose_domain --cfg '{"domain":<D>,"evm_style":true,"forward":<F>,"max_forward_fee":"<CAP>","account_creation":false,"max_forward_fee_new_account":"0"}'
# 48 hours later:
  ... -- commit_domain
```

`max_forward_fee` is in Stellar's 7-decimal stroops: the EVM table's `maxForwardFeeUnits` × 10.
The committed chains use 2 500 000 (0.25 USDC); keep that unless noted.

| Domain | Chain | forward | max_forward_fee (stroops) | Note |
|---|---|---|---|---|
| 0 | Ethereum | true | 25 000 000 | Circle charges ~1.1 USDC to deliver here |
| 1 | Avalanche | true | 2 500 000 | |
| 10 | Unichain | true | 2 500 000 | |
| 11 | Linea | true | 2 500 000 | |
| 12 | Codex | true | 2 500 000 | |
| 13 | Sonic | true | 2 500 000 | |
| 14 | World Chain | true | 2 500 000 | |
| 16 | Sei | true | 2 500 000 | |
| 18 | XDC | true | 2 500 000 | |
| 19 | HyperEVM | true | 2 500 000 | |
| 21 | Ink | true | 2 500 000 | |
| 22 | Plume | true | 2 500 000 | |
| 28 | EDGE | true | 2 500 000 | |
| 32 | Cronos | true | 2 500 000 | |
| 33 | Plasma | true | 2 500 000 | |
| 37 | X Layer | true | 2 500 000 | |
| 29 | Injective | **false** | 0 | Circle does not deliver; recipient claims |
| 30 | Morph | **false** | 0 | same |
| 31 | Pharos | **false** | 0 | same |

Before each proposal, check Iris quotes the pair (`GET /v2/burn/USDC/fees/27/<D>?forward=true`;
`pnpm check:stellar-evm` does the contract side). Order suggestion: Avalanche, Ethereum, Unichain,
Sei, HyperEVM first (volume), the three non-forwarded last. Two things to check before the
non-forwarded three: the Stellar bridge page has no claim-only EVM path today (`stellarDestination`
treats every EVM chain as delivered), so they would need the same handling Sui has before they are
switched on; and `NEXT_PUBLIC_STELLAR_SENDS_TO=all` will show each chain the moment its commit
lands, so a chain should be committed only once it is ready to be offered.

Aptos (domain 9) is not in the app as a destination from anywhere, so it is not on this list.
