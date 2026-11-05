# Sui

Two different directions. **Sui to Stellar** is built as a switched-off pilot (next section). **Stellar to Sui**
(Sui as a destination) is not built, and not buildable the way the other destinations are; the rest of this file
explains why.

## Sui to Stellar (pilot, built 2026-11-05, off by default)

`/sui` lets a Sui wallet burn USDC to a Stellar address over CCTP V2. Circle attests the burn and a relayer
account completes the mint on Stellar. Circle's docs still say Sui requires CCTP V1; the mainnet V2 contracts say
otherwise, a simulated burn succeeded, and Iris prices `8/27`. **No real transfer has been run yet.**

- Burn: Circle's `deposit_for_burn` to domain 27, `mintRecipient` = the Stellar `CctpForwarder`, the recipient in the
  hook data, `destinationCaller` zero. Built on the server (`lib/sui-stellar/build-burn.ts`), signed in the user's wallet
  (`lib/wallets/sui.ts`, Wallet Standard). No Sui key ever reaches the server.
- Completion: `POST /api/sui-stellar/complete` waits for nothing; it reads Circle's attestation, refuses anything that is not
  a Sui to Stellar USDC burn minting to the forwarder, refuses a recipient without a trustline, then calls `mint_and_forward`
  from the relayer account. The recipient is read from the burn's own hook, never from the request, so a caller can only
  finish a transfer someone already paid for.
- Pre-spend checks live in `lib/sui-stellar/cctp.ts` and are tested against a real message Sui's mainnet contracts emitted.

Server environment (Vercel, read at request time, not build inputs):

| Variable | Meaning |
|---|---|
| `SUI_STELLAR_ENABLED` | `true` to serve `/sui` and its routes. Anything else: 404. |
| `SUI_STELLAR_RELAYER_SECRET` | Funded mainnet Stellar secret that pays the fee (about 0.02 XLM per completion). Unset: users can burn but nothing completes it. Use a dedicated account holding a small float. |
| `SUI_STELLAR_MAX_USDC` | Per-transfer cap, default 10. |
| `SUI_RPC_URL` | Sui fullnode, default Mysten's public mainnet node. |

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
