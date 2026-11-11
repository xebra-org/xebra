# Admin panel (`/admin`)

A console for the v2 wrapper: read its state, change fees and destinations, pause it, take the fees,
and watch contract rent run down. Built in `apps/web` (`app/admin`, `components/admin`, `lib/admin`).

It covers the Stellar wrapper only. The Arc fee wrapper (`contracts/arc-evm`, on Arc mainnet at
`0x11b30470DAE40B2Fc27b7AA90dc58e6B4fE9f4c3`) has the same roles and timelock and is governed with
`scripts/arc-wrapper-admin.sh` ([`GOVERNANCE.md`](./GOVERNANCE.md#the-evm-wrapper)).

## Who can do what

The panel is a client. Every change is a Soroban call signed by the connected wallet and checked on
chain against the stored admin or pauser, so the page cannot do anything the keys could not.

| Role | Can |
|---|---|
| Admin | everything below |
| Pauser | pause, tighten a destination, remove a destination, veto all pending changes |
| Anyone | read |

**Instant or 48 hours?** The contract decides, and the panel mirrors its rule (`lib/admin/policy.ts`,
pinned by tests). Anything that reduces exposure is instant: lowering a fee or ceiling, raising the
minimum transfer, lowering a forward cap, turning forwarding off. Anything that could cost a user more
or widen exposure is a proposal that waits 48 hours, then needs a second signed `commit`: raising a
fee, raising the maximum transfer, adding a chain, turning forwarding on. There is no way to raise a
fee faster, by design; the delay is what gives the pauser time to veto a stolen admin key.

Admin, pauser and fee-recipient changes are not in the panel. They are rare and worth a deliberate CLI
command. The panel shows them when pending and lets the pauser veto them.

## The gate

`middleware.ts` puts HTTP Basic auth in front of `/admin`. It is a convenience layer, not the security
boundary (everything shown is public chain state, and writes are authorised on chain).

| Variable | Meaning |
|---|---|
| `ADMIN_PASSWORD` | Required, at least 16 characters. Unset or shorter: `/admin` returns 404. Server-side only, never `NEXT_PUBLIC_`. |
| `ADMIN_ALLOWED_IPS` | Optional, comma separated. Others get 403 before the password is asked. |
| `NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID` | The wrapper the panel manages. Must be the v2 id. |
| `NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_LEGACY_CONTRACT_ID` | Optional. v1, read only, so its rent shows. |

Generate the password with `openssl rand -base64 24`. There is no lockout after failed attempts; use a
long random one and, if the panel is public, the IP allowlist.

## How it reads

All state comes from the contract's instance storage in one `getLedgerEntries` call, with no funded
account needed. The same call returns the entry's TTL, and a second returns the code entry's TTL, which
is what the rent countdown uses. Pending changes have no getter in the contract, so they are read from
storage too. Checked against mainnet v2 on 2026-09-30: every value matched `deployments/mainnet.json`.

## Adding a chain

1. Confirm Circle forwards to it from Stellar: `pnpm check:stellar-evm` reads Circle's contracts
   both ways and Iris's quote for every chain in the table.
2. `/admin` -> Destinations -> Add chain: domain id, address style, forward cap (the form starts an
   EVM chain at 0.25 USDC). Propose. The contract holds one pending domain at a time.
3. 48 hours later: Pending changes -> Commit.
4. Nothing to deploy for a chain in `packages/sdk/src/core/chains/evm.ts`: the page reads the committed
   domains and offers each one named in `NEXT_PUBLIC_STELLAR_SENDS_TO` (`all` names every chain).
   A chain not in the table also needs a row there, and in `packages/network-config`.
