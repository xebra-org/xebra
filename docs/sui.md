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
