# Sui

Two different directions. **Sui to Stellar** is built as a switched-off pilot (next section). **Stellar to Sui**
(Sui as a destination) is not built, and not buildable the way the other destinations are; the rest of this file
explains why.

## Sui to Stellar (pilot, built 2026-11-05, off by default)

`/sui` lets a Sui wallet burn USDC to a Stellar address over CCTP V2. Circle attests the burn and a relayer
account completes the mint on Stellar. Circle's docs still say Sui requires CCTP V1; the mainnet V2 contracts say
otherwise, a simulated burn succeeded, and Iris prices `8/27`. **Two real transfers have completed end to end (2026-11-06); see the record below.**

- Burn: Circle's `deposit_for_burn` to domain 27, `mintRecipient` = the Stellar `CctpForwarder`, the recipient in the
  hook data, `destinationCaller` zero. Built on the server (`lib/sui-stellar/build-burn.ts`), signed in the user's wallet
  (`lib/wallets/sui.ts`, Wallet Standard). No Sui key ever reaches the server.
- Completion: `POST /api/sui-stellar/complete` waits for nothing; it reads Circle's attestation, refuses anything that is not
  a Sui to Stellar USDC burn minting to the forwarder, refuses a recipient without a trustline, then calls `mint_and_forward`
  from the relayer account. The recipient is read from the burn's own hook, never from the request, so a caller can only
  finish a transfer someone already paid for.
- Pre-spend checks live in `lib/sui-stellar/cctp.ts` and are tested against a real message Sui's mainnet contracts emitted.

### First real transfer (2026-11-06), finished by hand

1 USDC, Sui mainnet to Stellar mainnet, burned from a user's Sui wallet:

| Step | Record |
|---|---|
| Sui burn | [`37cRcRxVbwscXJAjLfqmXh19CDdKeHMBVJ1GMSqJKEE7`](https://suivision.xyz/txblock/37cRcRxVbwscXJAjLfqmXh19CDdKeHMBVJ1GMSqJKEE7) (domain 8 to 27, `mintRecipient` the `CctpForwarder`, 1.000000 USDC, standard finality 2000, fee 0) |
| Circle | Iris returned the attested V2 message for the digest (`status: complete`) |
| Stellar mint | [`6717506538f94e3bde364920991d2c7d9181635ddf4f6a4d3e466e45260e6f5d`](https://stellar.expert/explorer/public/tx/6717506538f94e3bde364920991d2c7d9181635ddf4f6a4d3e466e45260e6f5d), ledger 65335320, fee 0.025 XLM |
| Result | The recipient's USDC balance went from 0.0351801 to 1.0351801 |

The mint was submitted by hand with `scripts/sui-to-stellar/complete.mts` (simulated first), because the production
deployment had no `SUI_STELLAR_RELAYER_SECRET` set yet. So the burn, the attestation and `mint_and_forward` are proven;
the automatic relayer path on the site has not completed a transfer yet.

### Second transfer (2026-11-06), finished by the user from the page

Another 1 USDC to the same recipient, completed with no help from us:

| Step | Record |
|---|---|
| Sui burn | [`9hjSiHimU8nfpeWwFHau61czUBhVRqr7goiPxhvVUbR1`](https://suivision.xyz/txblock/9hjSiHimU8nfpeWwFHau61czUBhVRqr7goiPxhvVUbR1) (domain 8 to 27, 1.000000 USDC, fee 0) |
| Stellar mint | [`f3c29b36ebcc86901794f8b11e650c57b005d965c4b827d1691a23b7f585edee`](https://stellar.expert/explorer/public/tx/f3c29b36ebcc86901794f8b11e650c57b005d965c4b827d1691a23b7f585edee), ledger 65336298, 2026-11-06 12:18 UTC, fee 0.025 XLM |
| Payer | A personal Stellar account (`GB3JS2AJ...KUZW`), neither our deployer nor a relayer, so the user paid the fee |
| Result | The recipient's USDC balance went from 1.0351801 to 2.0351801; the site's status route reports the burn as `delivered` |

This landed 12 minutes after the "Claim on Stellar" button went live in production (commit `2e95ab5`, 12:06 UTC), with the same
fee and the same effects as the hand-run mint. Chain data cannot show which client submitted it, so this is consistent with the
button working, not proof of it. The relayer secret is still unset, so completion is not automatic; the claim button is what
makes that optional.

Server environment (Vercel, read at request time, not build inputs):

| Variable | Meaning |
|---|---|
| `SUI_STELLAR_ENABLED` | `true` to serve `/sui` and its routes. Anything else: 404. |
| `SUI_STELLAR_RELAYER_SECRET` | Funded mainnet Stellar secret that pays the fee (about 0.02 XLM per completion). Unset: users can burn but nothing completes it. Use a dedicated account holding a small float. |
| `SUI_STELLAR_MAX_USDC` | Per-transfer cap, default 10. |
| `SUI_RPC_URL` | Sui fullnode, default Mysten's public mainnet node. |

On the main bridge screen, Sui appears in the "Send from" picker when `SUI_STELLAR_ENABLED=true`
(`/api/sui-stellar/config` tells the page). It is the same transfer as `/sui`, embedded in the plate.

**Claiming without a relayer.** Once Circle has attested a burn, the page offers "Claim on Stellar": the server prepares the
`mint_and_forward` call with the user's own Stellar wallet as the source (`POST /api/sui-stellar/claim`), the wallet signs,
and the browser submits it. The user pays the fee (about 0.025 XLM). Any funded Stellar account may do this for any burn; the
recipient still comes only from the burn's hook. **The status route also reports `delivered`**: it simulates the mint and reads
Circle's "nonce already used" contract error (`#6908`) as already minted, so a transfer finished by hand, by the relayer or in
another browser shows as delivered instead of waiting forever.

Known limits: G... recipients only; standard finality only (Stellar has no Fast Transfer); the in-flight guard is per
server instance, so two instances racing one digest can waste a failed fee but not funds. The standalone command-line
versions are in `scripts/sui-to-stellar/`.

# Sui as a destination

**Status 2026-10-22: not built, and not buildable the way the other destinations are.**

Checked against Circle's Iris API that day (`GET /v2/burn/USDC/fees/{src}/{dst}`):

| Query | Answer |
|---|---|
| `27/8` (Stellar to Sui) | priced: Standard and Fast rows, `minimumFee` 0, **no `forwardFee`** |
| `8/27` (Sui to Stellar) | priced the same way |
| `27/8?forward=true` | `400 Destination domain not supported for forwarding` |
| `27/9?forward=true` (Aptos, for comparison) | the same 400 |
| `27/5?forward=true` (Solana, for comparison) | priced, `forwardFee` present |

So Sui is reachable by CCTP V2 from Stellar, but Circle's Forwarding Service does not mint on it. Every
route Xebra offers today rests on that service: the burn carries a forwarding hook and Circle mints on the
destination. There is no relay to fall back on (`docs/relay-removal.md`).

## What adding Sui would mean

A transfer would burn on Stellar without the hook, and the recipient (or anyone) would then have to
submit `receive_message` on Sui with the attestation, paying SUI for gas. That is the `/claim` flow made
the normal path, not the exception, and it changes what Xebra promises: "arrives by itself" becomes
"arrives when you claim it".

Work, if that trade is wanted:

- the wrapper domain with `forward: false` (its `DomainCfg` supports it; check that `bridge` accepts a burn
  with no hook for a domain with the switch off before relying on it)
- Sui address check (32-byte `0x` hex), `evm_style: false`, `CCTP_DOMAIN.sui = 8`
- a Sui wallet family and a claim step that builds the Move call (`@mysten/sui`, new dependency)
- the chain row, icon and picker entry, behind a `NEXT_PUBLIC_STELLAR_SENDS_TO` token
- a real mainnet transfer before it is switched on

Re-check `27/8?forward=true` before starting: if Circle adds Sui to the Forwarding Service the work shrinks
to the table rows and the admin proposal (`{"domain":8,"evm_style":false,...}`), like Solana.
