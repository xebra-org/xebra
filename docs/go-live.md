# Going live

**Status (2026-10-14):** steps 1–5 of §5 are done, and the app has since moved from wrapper v1 and
the relay to wrapper v2 and Circle's Forwarding Service (merged 2026-09-30; see
[`cutover-v2.md`](./cutover-v2.md) and [`relay-removal.md`](./relay-removal.md)). There is no relay,
no hot wallet and no relay secret: a failed forward is claimed by its owner at `/claim`. Arc is
switched on. What is still open is steps 6–8 of §5. The v1 and relay material below is kept as the
record of how launch was planned.

What has to happen before anyone who is not us can connect a wallet and bridge USDC, split by
who can do it. Ordered so that nothing later depends on something earlier being skipped.

The corridor itself works. The first real mainnet transfer completed end to end: burn
`92421fa248da1b1d4418784d5bd91adc4238dae72120e8f740920db7381905a7` on Stellar, mint
`58dVHAebBDVHWpjRYeGn52YJB8MFsLkgJHefcNgMBgkpYN7LxzdpGNE1tnGcPzGmwFLbDTqg7C7kHzCh4Ja6HZs5` on
Solana, 1.000001 USDC delivered. That transfer's mint was submitted by hand from
`scripts/cctp-mint-solana.mjs`. Since then the relay has run unattended against a live Convex
deployment (`knowing-zebra-183`) and completed a transfer — burn to mint — with nobody watching.
The frontend is deployed at [xebra.exchange](https://xebra.exchange/). See
[`writeups/`](../writeups/) for the full incident-by-incident account.

---

## 1. Decide the fee, because the current defaults lose money on some transfers

**Decided (2026-09-09): option 2.** v1 shipped with a 0.30 USDC floor plus a 0.70 USDC account fee
charged only to first-time recipients, and `scripts/deploy-cctp-wrapper.sh` now defaults to those
values and to Circle's 10M USDC per-message cap for `MAX_TRANSFER`. On v2, Circle pays the
destination costs and takes them out of the fee, so the lamport table below no longer applies; v2
was deployed with `max_transfer` 100 USDC.

`scripts/deploy-cctp-wrapper.sh` defaults to `FEE_BPS=10` (0.10%) and `MIN_FEE=5000000`
(0.50 USDC). Measured costs per transfer, on the Solana side, paid by us:

| | Lamports | Recoverable? |
|---|---|---|
| `used_nonce` account rent | 867,621 | **No.** Permanent, one per transfer, forever |
| Transaction fee | ~5,000 | No |
| Recipient token account rent, when the recipient has none | 1,855,269–2,039,280 | **No.** `CloseAccount` needs the owner's signature, which we do not have |

So a transfer to a wallet that already holds USDC costs us ~872,621 lamports. To a first-time
recipient it costs ~2,911,901 lamports. At a SOL price of $200 that is **$0.17 and $0.58**.

Against a 0.50 USDC floor, the first case earns $0.33 and the second **loses $0.08**. First-time
recipients are not an edge case — they are most of a new product's users.

Three ways out, and this is your call:

1. **Raise `MIN_FEE` to cover the worst case.** 0.75–1.00 USDC. Simple, and it prices small
   transfers out.
2. **Charge the token-account rent only to recipients who need one.** The frontend already knows
   which case it is (`/api/recipient` returns `exists` / `missing` / `unknown`), so the quote can
   differ. More honest pricing, more contract surface.
3. **Refuse first-time recipients** and tell them to receive any USDC on Solana first. Cheapest
   to build, worst experience.

Also decide `MAX_TRANSFER`. It defaults to 100k USDC. The contract has had no external audit, so
this number is the blast radius of a bug nobody has found yet. Start far lower and raise it as
clean transfers accumulate.

## 2. Things only you can do

### Keys and identities

The deploy script requires four Stellar addresses and refuses to run without them:

- **`SOURCE`** — a `stellar` CLI identity with XLM to pay for the deploy.
- **`ADMIN`** — can change fee parameters, through a 48-hour timelock.
- **`PAUSER`** — can pause, immediately, with no timelock.
- **`FEE_RECIPIENT`** — where withdrawn fees go.

**`ADMIN` and `PAUSER` must be different keys held by different people.** The pauser exists so
that a compromised admin can still be stopped by someone who is not the attacker. If one person
holds both, that check does not exist. The script warns and continues; it cannot know who holds
what. (v2's script, `scripts/deploy-cctp-wrapper-v2.sh`, reuses v1's four from
`deployments/mainnet.json`.)

There is no longer a Solana hot wallet. The relay's (`BswkfXXywbVo8tesK4sWkrpsaVYUy3zaJuQYTCChGpG2`)
was emptied on 2026-09-21 and removed with the relay; Circle's Forwarding Service pays destination
gas.

### Accounts

The deployment is Vercel for the UI and Convex for one shared rate counter. See `docs/deploying.md`
for the mechanics; this is only the list of things that need an account and a card.

- **Convex, free.** Holds the counter that keeps our calls to Circle's Iris API under its rate
  limit. 1M function calls a month; the counter uses a fraction of it.
- **Vercel, Pro.** $20/month. Not for the features — for the terms: Hobby is restricted to
  non-commercial use, and taking a bridge fee is commercial. Nothing needs Vercel Cron, so Hobby
  is functionally complete while you are still testing with your own money.
- **A domain**, if you want one that is not `*.vercel.app`. Vercel handles the certificate.

That is the whole list. There is no AWS, no container registry, no Redis and no Kafka in this
deployment: `infra/terraform` and the other seven services stay in the repo for anyone who wants
to self-host, and are not on this path.

### Secrets to generate and store

- `IRIS_BUDGET_SECRET` — the same long random value on the **Convex** deployment
  (`npx convex env set`) and on **Vercel**.
- `ADMIN_PASSWORD` — on **Vercel**, at least 16 characters, for `/admin`.

Also on Vercel, not secret: `CONVEX_URL`.

Both platforms encrypt these at rest and decrypt them into the function at invocation. That is
better than the ECS arrangement the Terraform describes, where secrets land as plaintext process
env.

### Legal

Taking a fee for moving other people's money is a regulated activity in most jurisdictions, and
"anyone can connect their wallet" is the version that attracts attention. That question is
outside what this repo can answer and worth settling before launch rather than after.

## Turning on Arc

**Done.** Wrapper v2 was deployed with domain 26 forwarded, so steps 1 and 2 below no longer apply
(there is no relay to hold an Arc key), and production is built with `NEXT_PUBLIC_ARC_ENABLED=1`.

Stellar → Arc runs over the same wrapper and the same fee schedule as Solana. Every part of it is
built and tested; what remains needs a key or a decision. **Nothing here had moved real money when
this was written.**

What was verified against the live chains (`pnpm check:arc` repeats it, read-only): Arc is chain
5042; its TokenMessengerV2 holds Stellar's messenger as domain 27 and Stellar's holds Arc's as
domain 26, byte for byte; Arc's minter maps Stellar USDC to `0x3600…0000`, a 6-decimal ERC-20;
Iris prices `27 → 26` for both Fast and Standard.

In this order, because each step depends on the one before:

1. **Commit domain 26 on the wrapper.** Only domain 5 was allowed on v1 (`get_domains` →
   `[{"domain":5,"evm_style":false}]`), so an Arc burn would revert with `DomainNotAllowed`. As
   `ADMIN`: `propose_domain` with `{"domain":26,"evm_style":true}`, wait out the 48-hour timelock,
   then `commit_domain`. `evm_style: true` is what makes the contract insist on a left-padded
   20-byte recipient. No redeploy.
2. **Give the relay an Arc wallet.** Generate a fresh 32-byte key, set it as
   `RELAY_ARC_PRIVATE_KEY` on Convex, and send it a few USDC on Arc. Do not reuse another key.
   The relay's `health` action (and `/api/health`) reports this wallet next to the Solana one.
3. **Run one transfer yourself** before anyone else can: burn a small amount to an Arc address you
   control, and watch it arrive. This is the first real Arc mint; the gas figure in the relay's
   `packages/cctp-evm/src/health.ts` (deleted with the relay) was an assumption until then.
4. **Flip `NEXT_PUBLIC_ARC_ENABLED=1`** in Vercel and redeploy. It is inlined at build time, so a
   running deployment cannot be switched over — which is the point: the UI should not offer Arc
   until 1 and 2 are done.

The fee is the same as Solana's (0.10%, 0.30 USDC floor), and Circle's delivery fee comes out of it.
v2 charges no separate account fee (`account_fee` is 0): opening a Solana token account is priced
inside Circle's delivery fee, and an Arc mint creates nothing.

Known gaps, none of which lose money silently but all worth knowing:

- The UI checks an Arc address's shape and EIP-55 checksum, and refuses the zero address, system
  and burn addresses and Circle's own contracts. It cannot tell a wallet from a contract that
  rejects tokens, or see USDC's blocklist. A mint to either reverts on chain after the burn; the
  transfer stays claimable, but it would not complete.
- Arc's Fast Transfer allowance is set by Circle and was not checked here. Iris quotes a zero fee
  for both thresholds today.

## Turning on the Arc wrapper

Transfers out of Arc are free today: the page calls Circle directly. `XebraCctpWrapper.sol`
(`contracts/arc-evm`) takes Stellar's fee on them (0.10%, 0.30 USDC floor, Circle's delivery fee paid
out of it). **Deployed on Arc mainnet** on 2026-10-15 at `0x11b30470DAE40B2Fc27b7AA90dc58e6B4fE9f4c3`
(`deployments/mainnet.json`) and pinned in `XEBRA_WRAPPERS`; steps 1–4 below are done, the page does
not use it until step 6, and no mainnet transfer has gone through it yet. Its keys are files in
`~/.xebra-mainnet` on the maintainer's machine, like the Stellar admin and pauser identities.

What is proven: the Foundry suite (unit, fuzz, and a deploy against Circle's real Arc testnet
contracts in a fork), and on 2026-10-14 a deployment on Arc testnet
(`0xEdf6867df28F6A5EdE4c3B701c9E9e5091FDef75`) carrying five real transfers through
`scripts/test-arc-wrapper-testnet.sh`: Base Sepolia, OP Sepolia, Arbitrum Sepolia and Avalanche Fuji
each received 1.70 of 2 USDC, and a brand-new Solana devnet wallet 2.70 of 3 with its USDC account
opened by Circle. Circle executed exactly the `maxFee` the wrapper passed every time. The burn cannot
be run in a local fork, because Arc's USDC moves through Arc-only precompiles.

Unlike the Soroban wrapper, this one holds the principal for the length of the transaction (see "What
is not a risk" below). In this order:

1. **Two EVM keys, held by different people**, for admin and pauser (`cast wallet new`, then
   `cast wallet import <name> --private-key …`, or a hardware wallet), and an address for fees.
2. **A deployer** keystore holding at least 0.2 USDC on Arc mainnet. The deployment costs about 0.083
   (4.14M gas at 20 gwei, measured on testnet); the script refuses to start with less than 0.2. Give
   the admin and pauser a few cents each too: their calls cost 0.001–0.002 USDC.
3. **Deploy.** `pnpm --filter @xebra/network-config build`, then
   `NETWORK=mainnet ACCOUNT=<deployer> ADMIN=0x… PAUSER=0x… FEE_RECIPIENT=0x… scripts/deploy-arc-wrapper.sh`
   for the dry run, and again with `CONFIRM="deploy the arc wrapper to mainnet"`. It reads the
   contract back and records it in `deployments/mainnet.json` under `arcWrapper`.
4. **Pin it.** Set `XEBRA_WRAPPERS = { arc: "0x…" }` in `packages/network-config/src/evm-chains.ts`
   and `apps/web/lib/evm-chains.ts`; a test holds both to the deployment record. The address is never
   read from the environment, because a transfer approves it for the whole amount.
5. **Verify the source** on Arc's block explorer (`forge verify-contract`).
6. **Switch it on and send your own transfer first.** `NEXT_PUBLIC_ARC_USE_WRAPPER=1` in Vercel, then
   a small transfer from the live site, and `NETWORK=mainnet scripts/arc-wrapper-admin.sh status` to
   see the fee accrue.
7. **Keep `maxTransfer` at 100 USDC** through the bug bounty. Raising it is
   `scripts/arc-wrapper-admin.sh propose-params …` and a 48-hour wait.

## 3. One more reason to deploy the wrapper early

Moot since the relay was removed: nobody sponsors a mint any more, so there is nothing to grief.

Until it exists, nothing on chain distinguishes a burn made through this app from any other CCTP
user's burn on Stellar — Circle's contract serves everyone. So `/api/relay/burns` cannot tell whose
mint it is being asked to pay for, and it is bounded rather than authenticated: burns older than an
hour are refused, and sponsorship stops after 200 mints in 24 hours. That caps the loss; it does
not prevent a griefer inside the bounds from having their own transfers sponsored.

The wrapper removes the vector, because then the watcher only ever sees burns we were paid a fee
on. It is on this list for revenue; this is the second reason.

## 4. What was left on my side

Done since this document was first written, so you do not have to ask for them:

- The relay running unattended against a live Convex deployment — the thing this section used to
  list as the one open item. It has now picked up a burn, waited on Circle's attestation, and
  submitted the mint with nobody watching.
- The frontend deployed to Vercel, at [xebra.exchange](https://xebra.exchange/).
- The self-serve claim page (`/claim`), so a user can complete their own transfer when nobody
  sponsors the mint. This is what makes the no-hang promise usable rather than merely true.
- Hot-wallet alerting: a Convex cron that fails loudly, and `GET /api/health` returning 503 for any
  free uptime monitor to page on. Both went with the relay.
- CI, running lint, typecheck, `vitest`, `cargo test` and `forge test` on every push. `pnpm lint`
  had never passed before this; it does now.

What is still genuinely open is steps 6–8 of §5 below: the bug bounty has not been published, and
`MAX_TRANSFER` has not been raised past its cautious starting value.

Not on the deployment path: seeding `chains`, `assets` and `corridors`. They have readers and no
writer, so `apps/api` throws on every quote against an empty table — but the bridge UI quotes from
a Soroban simulation and Circle's API, so nothing deployed here needs it.

## 5. Sequence

Steps 1–5 are done. 6–8 are what is still open.

1. ~~`scripts/check-cctp-interface.sh` — Circle can redeploy their contracts.~~
2. ~~Deploy the wrapper with parameters from §1. Record `deployments/mainnet.json`.~~
3. ~~Fill `STELLAR_CCTP_WRAPPER_CONTRACT_ID` and `NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID`
   in `.env.production`, plus `SOROBAN_START_LEDGER` at the deploy ledger.~~
4. ~~`npx convex deploy`, then deploy the frontend. `NEXT_PUBLIC_*` are inlined at build time, so
   they must be set in Vercel before the build, not after.~~
5. ~~Transfer your own money through the deployed stack. Then do it with the relay stopped, and
   complete the mint by hand, and write down that you did — the same standard
   `scripts/e2e-demo/` set for the escrow.~~
6. Raise `MAX_TRANSFER` in steps, through the timelock, as clean transfers accumulate.
7. Publish the bug bounty. Its duration is the only audit this contract gets, so treat it as a
   real gate.
8. Open it up.

## What is not a risk

Worth being clear, because most bridge failures are custody failures and this one cannot be.

The Soroban wrapper never holds principal. The user is `caller` on `deposit_for_burn`, so USDC
moves from the user directly to Circle inside a single transaction — if any part of it fails, the
whole transaction reverts and the user still has their money. `withdraw_fees` can only ever move the
accrued-fee counter, so a stolen admin key cannot reach a transfer in flight.

The EVM wrapper does hold the principal, for the length of one transaction: Circle's EVM messenger
burns from `msg.sender`, so the wrapper pulls the amount, approves exactly what it burns, and burns.
It reverts unless the allowance to Circle is back to zero and it still holds at least what it owes
the fee recipient, so between transactions it holds fees and nothing else, and `withdrawFees` can
move only those.

And `destination_caller` is set to zero, which makes every message permissionlessly mintable.
If this company disappears mid-transfer, the burned USDC is still claimable by anyone holding
Circle's attestation, forever. That is a property of the design, not of our uptime.
