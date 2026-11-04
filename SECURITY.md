# Security

Xebra moves real money on Stellar, Solana, Arc and the EVM chains Arc sends to, all on mainnet.
Every issue here starts from that.

## Scope

| Component | Address / location | Notes |
|---|---|---|
| `XebraCctpWrapper` v2 (Soroban) | `CCPVTWII2TW6VVSVA4JQ2KFHICGBG4QVAHPIGUPSIW3E4VNPUI4Y2WQR` (see [`deployments/mainnet.json`](./deployments/mainnet.json)) | live on Stellar mainnet, takes a fee and hands the burn to Circle's CCTP, with Circle's forwarding hook, in one transaction |
| `XebraCctpWrapper` v1 (Soroban) | `CCNWLGFMILJU476RZHDA2PSUH2WH3LIPERHS6BYPCRVDDYYNNUIKZMTJ` | retired: the app no longer sends to it, but it is still deployed and not paused |
| Iris rate counter (`apps/web/convex/`) | production Convex deployment | one shared counter; holds no keys and no funds |
| `XebraCctpWrapper` (EVM, `contracts/arc-evm`) | Arc mainnet `0x11b30470DAE40B2Fc27b7AA90dc58e6B4fE9f4c3` (see [`deployments/mainnet.json`](./deployments/mainnet.json)); deployed 2026-10-15, not yet used by the page | takes Xebra's fee on a transfer out of Arc and burns the rest through Circle with the forwarding hook; unlike the Soroban wrapper, the principal passes through it inside the transaction |
| Frontend (`apps/web`) | [xebra.exchange](https://xebra.exchange/) | builds the signed request the wallet submits; on the routes between Arc and the EVM chains it calls Circle's `TokenMessengerV2` directly, or the EVM wrapper above once one is pinned and switched on |

`contracts/arc-evm/src/XebraEscrow.sol` and `contracts/stellar-soroban` are part of the Arc↔Stellar
corridor, which is not on the deployment path (see the README's "Repo layout" section) — real bugs
there are still worth reporting, but nothing user-facing depends on them today.

## What's most worth finding

- Anything that lets the wrapper move a user's **principal**, not just the fee. By design
  (`contracts/stellar-cctp-wrapper-v2/src/lib.rs`), the user is `caller` on the burn and the
  wrapper only ever pulls its own take (`q.wrapper_take`) — a bug that breaks that boundary is the
  highest-severity class of report this project has.
- On the EVM wrapper (`contracts/arc-evm/src/XebraCctpWrapper.sol`) the principal *does* pass
  through the contract, for one transaction, because Circle's EVM messenger burns from
  `msg.sender`. Anything that leaves USDC in it beyond `accruedFees`, leaves an allowance to Circle
  behind, burns more or less than `netBurned`, lets one sender's transfer spend anyone else's
  funds, or lets `withdrawFees` move more than is accrued, is the same severity as the boundary
  above.
- Anything that lets a mint be double-paid, redirected, or paid to the wrong domain/recipient shape.
- Anything that lets `withdraw_fees`, the timelocked admin functions, or `pause`/`unpause` be
  reached without the intended `require_auth`.
- Anything that makes a user sign a larger `max_fee` than the page shows, or a burn to a domain,
  token or recipient they did not choose. On the routes between Arc and the EVM chains that call
  Circle directly, the page's own checks (`apps/web/lib/evm-forward-fee.ts`,
  `apps/web/lib/evm-bridge.ts`) and the pinned table in `packages/network-config/src/evm-chains.ts`
  are the only guard; through the EVM wrapper the contract applies them again.

The contract has had **no external audit**. `MAX_TRANSFER` is deliberately kept low while that's
true — see [`docs/go-live.md`](./docs/go-live.md) §1. A formal bug bounty is planned
(`docs/go-live.md` §5, step 7) but not yet published; until it is, this document is the reporting
process.

## Reporting

**Do not open a public GitHub issue for anything that could let someone take user funds or bypass
the admin/pauser timelock.** Use GitHub's private vulnerability
reporting (Security tab → "Report a vulnerability") if enabled on this repo, or email
egwomevan323@gmail.com with:

- which component (contract, frontend, Convex counter) and, for the contract, which function
- the precondition and the concrete sequence of calls or transactions that trigger it
- what an attacker or a buggy client gains

Non-security bugs (a UI glitch, a misleading error, a typo) belong in a regular GitHub issue —
see [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Response

This is a solo-maintained project. There's no formal SLA yet, but a fund-affecting report gets
looked at first — if it's real, `pause()` (immediate, no timelock — see
[`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md)) is the first response, before anything else.

## Keys

`ADMIN` and `PAUSER` are held by different keys, specifically so a compromised admin can still be
stopped (`docs/go-live.md` §2). There is no relay and no hot wallet: Circle's Forwarding Service pays
destination gas. The deployment's two secrets, `IRIS_BUDGET_SECRET` and `ADMIN_PASSWORD`, live in
Convex's and Vercel's encrypted environments, never a committed file — `.secrets/` is git-ignored
for exactly this reason and should stay that way in any fork.
