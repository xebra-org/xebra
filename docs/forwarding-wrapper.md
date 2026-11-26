# Forwarding wrapper (v2)

Status (2026-10-14): **implemented in `contracts/stellar-cctp-wrapper-v2` (84 tests), deployed to
mainnet on 2026-09-24, and what the live web app has used since 2026-09-30.** v1 is retired. The
dated sections below are the record of how it got there.

**Decision, 2026-09-21: the relay is removed, not kept as a fallback.** A forward that fails is the
owner's to claim at `/claim`; nobody holds a funded key to mint on their behalf. Everything below
that used to say "the relay falls back" now says "the owner claims". See "No relay" for what that
changes and what protects users instead.

## Why

Until now a relay paid the destination gas: SOL on Solana, USDC on Arc. That is a hot wallet to
refill for every destination, and it is why adding a chain meant adding a funded key.

Circle's CCTP Forwarding Service removes it. Burn with a fixed hook and Circle broadcasts the
destination `receiveMessage` itself, taking its fee in USDC out of the minted amount. Verified for
Stellar → Arc on **both testnet and mainnet** (2026-09-20, results below). Circle's docs never say
whether a Stellar-*origin* burn is forwarded: their chain table's "Forwarding Service" column lists
which chains can be a forwarding *destination* (Stellar cannot; that is not our direction). An
earlier draft of this document misread that column as "Stellar unsupported".

| Run | `max_fee` | Result |
|---|---|---|
| mainnet, 1 USDC → Arc | 21,430 (1.3× quote) | forwarded in ~3 min, recipient got 0.978570, `feeExecuted` = 21,430 |
| mainnet, 1 USDC → Solana, token account exists | 177,302 (**1.0×** `high`) | forwarded (`COMPLETE`), recipient got 0.822698, `feeExecuted` = 177,302, Circle's wallet paid the SOL |
| mainnet, 1 USDC → Solana, **no token account** | 361,541 (**1.0×** `high`, with `includeRecipientSetup`) | forwarded, Circle **created the account**, recipient got 0.638459, `feeExecuted` = 361,541, the recipient wallet still held 0 SOL |
| testnet, 1 USDC | 2× and 1× quote | forwarded; `feeExecuted` = the whole `max_fee` both times |
| testnet, 1 USDC | ~0.25× quote | **not forwarded**: Iris `FAILED / INSUFFICIENT_FEE`, `feeExecuted` 0, attested but unminted; minted by hand from an unrelated wallet for ~1 cent, recipient got the full amount |

Two facts drive the whole design:

1. **Circle charges the entire `max_fee`, not the lower quote.** So `max_fee` is a price the
   recipient pays, and a signed request that carries a large one hands that money to Circle.
2. **A `max_fee` below Circle's requirement does not lose money.** The burn is attested and
   unminted; anyone can mint it (`destination_caller` is zero). It only needs a fallback minter.

## What does not change

Everything that makes v1 safe carries over unchanged, because none of it conflicts:

- The wrapper never holds a user's principal. The user is `caller` on the burn, USDC moves from
  the user straight to Circle, argument-bound by the user's signature.
- `destination_caller` is zero. Every burn stays permissionlessly mintable, so a dead Circle
  forwarder or a dead Xebra still leaves the transfer claimable. This is also what
  Circle's forwarder requires.
- `usdc` and `token_messenger` are immutable; no upgrade entrypoint; the 48h timelock on anything
  that loosens; pause is instant.
- The user signs the whole `BridgeRequest`, including `max_fee`, the recipient and the fee cap.

v2 is a **new contract at a new id**. v1's WASM hash and git commit are pinned in
`deployments/mainnet.json`; editing v1 in place would break that provenance, and a Soroban
contract that holds no funds between transactions needs no migration.

## The transfer path

Per request, the wrapper takes one of two paths, decided on chain from signed inputs:

```
forward path  = domain.forward  AND ( NOT req.recipient_needs_account  OR  domain.account_creation )
plain path    = everything else   (exactly v1: deposit_for_burn, nobody mints it for you)
```

Every EVM destination and every existing Solana account is forwarded with the plain 32-byte hook. A
first-time Solana recipient (`recipient_needs_account`) is forwarded too when the domain has
`account_creation` on: the wrapper then builds Circle's 65-byte extended hook from the signed
`recipient_owner`, and Circle's forwarder creates the token account and pays the rent and gas. With
`account_creation` off, that transfer takes the plain path. **With no relay, the plain path delivers
nothing by itself** — the burn is attested and then waits for its owner to claim it — so the web app
must treat `forwarded: false` in `quote` as "do not send", and turning account creation off means
first-time Solana recipients cannot use the product until it is turned back on. The flag and the
owner are signed by the user, so the path is bound by the signature.

Rules on the signed owner, so the request means one thing: it must be zero unless
`recipient_needs_account` is set; it must be non-zero when Circle is to create the account; and it
may never equal `mint_recipient`, because the wallet address in place of the token account is what
stranded the first mainnet burn. The contract cannot check that `mint_recipient` really is the ATA
derived from the owner (Soroban has no ed25519 curve check); Circle enforces it and fails the forward
if it is wrong, so the front end must derive it.

> **Correction (2026-09-21), and an open design change.** An earlier draft said Circle's forwarder
> *cannot* create a Solana token account. That was an inference from a shallow read, and it is
> wrong. Circle's Forwarding Service page documents an extended hook (`cctp-forward`, version 0,
> length 33, then an ATA-creation flag byte and the recipient owner's 32-byte address) and a fee
> estimate parameter, `includeRecipientSetup=true`, whose `forwardFee` covers the rent. Using it
> would let first-time Solana recipients be forwarded too, so we would need **no SOL at all**,
> which is the point of this whole design. **Proven on mainnet on 2026-09-21** (see the table above:
> a 65-byte hook, mint recipient = the derived token account, `forwardFee` from
> `includeRecipientSetup=true`), and **built into the contract** the same day (see "Contract surface
> changes" and "Testnet results").

## Fee model

The user-facing promise is unchanged: **the recipient gets `amount − fee`**, where `fee` is the
familiar `max(0.10%, 0.30 USDC)` (plus the account fee on the plain path, which the web app no longer uses). The forward fee is paid
*out of* that fee, not on top of it.

Let `A` = amount, `M` = the validated `max_fee` (Circle's forward fee, charged in full),
`base` = `max(A·bps, min_fee)`.

```
fee          = max(base, M)          what the user pays in total
wrapper_take = fee − M               what Xebra keeps (accrues, and is the only thing pulled)
after        = A − wrapper_take
remainder    = after mod 10          stays in the user's wallet (7→6 decimal boundary)
burned       = after − remainder
recipient    = burned − M            what arrives  =  A − fee − remainder
```

Worked examples (fee schedule 0.10% / 0.30 floor):

| Transfer | `M` | `fee` | Xebra keeps | Recipient gets |
|---|---|---|---|---|
| 10 USDC → Arc | 0.0215 | 0.3000 | 0.2785 | 9.7000 |
| 10 USDC → Solana | 0.1500 | 0.3000 | 0.1500 | 9.7000 |
| 1,000 USDC → Arc | 0.0215 | 1.0000 | 0.9785 | 999.0000 |
| 10 USDC → Ethereum | 1.13 | rejected: `M` > 10% of net |  |  |
| 100 USDC → Ethereum | 1.13 | 1.1300 | 0.0000 | 98.8700 |

When `M ≥ base` the user pays `M` and Xebra keeps nothing on that transfer: gas is passed through
at cost rather than the transfer being refused. `wrapper_take` is never negative.

`max_wrapper_fee` (the user's signed ceiling on our fee) bounds the **total** `fee`, so a
`commit_params` landing in the same ledger still cannot overcharge a signed request.

## Bounds on `M` (the new risk)

Because Circle takes all of `max_fee`, a bad `max_fee` is a way to move a user's money to Circle.
Three bounds, none of which the front end can override:

1. `M > 0`. Zero can only fail.
2. `M ≤ domain.max_forward_fee`, a per-chain cap set by the admin under the timelock, and itself
   capped by a compile-time ceiling (`MAX_FORWARD_FEE_CEILING`, 2 USDC) no admin can exceed.
3. `M ≤ 10%` of the burned amount (the same 10% rule v1 applies to Circle fees).

The signed `max_fee` is visible to the user in the request they sign. A cap per chain matters
because forward fees differ by two orders of magnitude (Arc ≈ $0.02, Solana ≈ $0.15, Ethereum ≈
$1.13, live Iris quotes).

## Contract surface changes

- `TokenMessenger` gains `deposit_for_burn_with_hook(..., hook_data: Bytes)`; the wrapper passes
  the compile-time constant `FORWARD_HOOK` (`"cctp-forward"` right-padded to 32 bytes) and nothing
  else. A caller cannot supply arbitrary hook data.
- `DomainCfg { domain, evm_style, forward, max_forward_fee, account_creation,
  max_forward_fee_new_account }`. Creating an account roughly doubles Circle's fee (about $0.34 vs
  $0.17 on Solana), so it has its own cap; the plain cap must not block it and the account cap must
  not loosen ordinary transfers. `account_creation` needs `forward` and a non-EVM destination, and its
  cap needs to be positive and under the same 2 USDC ceiling; the cap is zero when it is off.
- `BridgeRequest` adds `recipient_owner` (signed; rules above).
- `Quote` adds `forward_fee` (`M`), `forwarded` and `account_created`; `fee` stays "everything we
  charge". On the creation path `account_fee` is zero: the rent is inside `M`, not a second charge.
- New errors: `RecipientOwnerMissing`, `RecipientOwnerUnexpected`, `MintRecipientIsOwner`.
- `quote(amount, recipient_needs_account, destination_domain, max_fee)`: the price now depends on
  the destination and on `M`, so the quote must be given both.
- `BridgeInitiated` adds `forwarded`, `forward_fee`, `wrapper_take`, `account_created` and
  `recipient_owner`, so an indexer can tell which burns to expect Circle to mint.
- `propose_domain` may now *replace* an existing domain's config (timelocked), where v1 refused.
- `tighten_domain(caller, domain, forward, max_forward_fee, account_creation,
  max_forward_fee_new_account)`: instant, admin **or pauser**, may only turn things off or lower a cap,
  never the reverse. Account creation rides on forwarding, so turning `forward` off turns it off too
  and zeroes its cap, which cannot leave a half-configured domain. **It is not a kill switch:** with
  `forward` off, `bridge` still accepts transfers to that domain and burns them on the plain path,
  which nobody mints, so each recipient has to claim at `/claim`. To stop transfers to a domain,
  use `remove_domain` (admin or pauser, instant) or `pause`.

## Failure modes

| What goes wrong | What happens | Recovery |
|---|---|---|
| `M` below Circle's requirement (quote moved) | Iris `FAILED / INSUFFICIENT_FEE`, no fee, unminted | owner claims at `/claim` |
| Circle's forwarder is down or slow | burn attested, unminted | owner claims at `/claim` |
| Circle changes the hook format | forwards fail like the above | `remove_domain` (or `pause`) stops new transfers; owners of affected ones claim |
| Owner and Circle both mint the same message | second reverts on `used_nonce`, costs ~1 cent | none needed |
| User overpays `M` | recipient pays the difference | bounded by the caps above |

None of these lose principal: the recipient is fixed inside the attested message, and the attested
message is public and never expires.

## No relay

There is no funded key that mints for users. That removes the hot wallets and the per-chain gas
float, and it moves one risk onto the user: **a burn whose forward fails is theirs to claim**, paying
destination gas themselves (well under a cent on Arc; about 0.001 SOL on Solana, more with account
rent). Three things keep that from being a trap.

1. **A pre-flight check refuses to start a transfer while Circle looks unwell.**
   `GET /api/circle-health?dest=solana|arc[&newAccount=1]` probes Circle's forward-fee quote for the
   route (which also has to look sane: a `high` fee above the 2 USDC ceiling is refused) and its
   public attestation keys. `down` disables the Bridge button and is checked again right before
   signing. It retries once before believing a failure, because a cold serverless instance has
   timed out on its first call to Circle. It cannot see an attestation *indexer* stall (Circle's
   sandbox stopped indexing new Stellar burns for about a day while its quote and key endpoints
   answered normally), and it deliberately does not use `status.circle.com`, whose raw feed has
   flagged CCTP as a major outage since 2025-12-05 while it worked.
2. **A rate budget keeps us from being blocked.** Circle's Iris allows 40 requests per second and
   blocks a caller for five minutes above it. Every Iris call from our servers goes through one
   counter (`irisFetch`): a fixed second plus the weighted previous second, limit 30 per second,
   held in a Convex document so all serverless instances share it, and a 330 second stand-down after
   any 429. Being held back or blocked is reported as `degraded` ("status unavailable"), never
   `down`: it stops us *reading* Circle, not Circle minting.
3. **The receipt tells the truth about a failure.** `/api/delivery?tx=` reads Iris's `forwardState`
   and `forwardTxHash` for the burn: `delivered` links to the destination transaction; `failed`
   (Iris shows it as soon as the message is attested) and `claimable` send the owner to
   `/claim?tx=…` with the cost stated; `unknown` (we could not ask) is its own message and never
   shown as progress.

What this does **not** do: it does not retry a failed forward for the user, and it does not refund
`M` (Circle charges the whole `max_fee` when a forward succeeds; a failed one is unminted, not
charged). If failed forwards turn out to be common in production, the honest fix is a better
`max_fee` policy, not a relay.

## Testnet results (2026-09-20)

v2 deployed to Stellar testnet as `CAUZXEUMQUBJBADXMAMUR5LRTDXQNHEQNX4HGN4WYMNJLXA7GHF7SOSQ` (WASM
sha256 `3da8655ae02f426b6a177a8f1fc68fa21d81270a97e9498a9b644c458ef2399f`), Arc forwarded with a
0.10 USDC cap, against Circle's real testnet TokenMessengerMinter and the Iris sandbox.

**One real transfer through the wrapper**, 10 USDC to an Arc testnet address
(`29fddc7ab20a133a60c6c0f029c17e02dd6a9643102f47c0e151d405df5db6ba`), `max_fee` 304,070 (Iris's
high quote × 1.3):

| Check | Expected | Observed |
|---|---|---|
| on-chain `quote` | fee 0.30, Circle 0.030407, we keep 0.269593 | identical |
| user debited | `wrapper_take + net_burned` = 10.000000 | 17 → 7 USDC |
| wrapper balance and `accrued` | 0.269593 each | 0.269593 each |
| hook on the attested message | `cctp-forward` constant | `0x636374702d…0000` |
| Circle forwards it | `forwardState: COMPLETE` | COMPLETE, forward tx `0x9d4ce52d…fdc14`, ~4 min |
| `feeExecuted` | `max_fee` (Circle takes it all) | 30,407 |
| recipient receives | `amount − fee` = 9.700000 | **9.700000** exactly |

**Guards on the deployed contract** (free simulations): `max_fee` above the cap → `#40`; zero →
`#39`; unconfigured domain → `#7`; user's fee ceiling below the fee → `#19`; Solana-shaped
recipient on an EVM domain → `#9`; below the 10 USDC minimum → `#12`; finality 0 → `#10`. A request
that overdraws the wallet reverts the whole transaction inside Circle's USDC contract.

**Kill switch with real signatures** (second instance
`CBH4IDBNNXQT5SVVUW7VUDGWOX5RID7K7WXRBUYGULZDKBW2UYYXPF7U`): a stranger calling `tighten_domain` is
refused (`#1`); the pauser turns forwarding off in one transaction, emitting `domain_tightened`,
after which `quote` returns the plain-path fee (`forwarded: false`, `wrapper_take` = the full fee);
turning it back on instantly is refused (`#31`). Unit tests use `mock_all_auths`, so this is the
only place the auth checks are exercised for real.

**Not covered by any test yet:** an under-priced `max_fee` *through the wrapper* (the wrapper
cannot know Circle's requirement, so it forwards and Circle answers `INSUFFICIENT_FEE`; the same
Circle behaviour was measured directly on testnet and recovered by hand), Solana forwarding, and
any of the off-chain changes.

**Account creation (2026-09-21).** A second testnet instance,
`CBPSSU5N3LHOK57LTJSTSWKHJU2JS5VZV7HVKON6NKB5VK3BMMLHA45R`, with Solana `account_creation` on. A full
`bridge` for a first-time Solana recipient simulated cleanly against Circle's real testnet messenger,
and Circle's own `deposit_for_burn` event carried exactly the expected hook: the fixed 32-byte header
with length 33, the flag `01`, then the owner, 65 bytes, and not the plain hook. The rejection cases
returned the designed codes: owner missing `#43`, owner given without needing an account `#44`,
wallet address as the token account `#45`, `max_fee` above the account cap `#40`. Not sent for real,
because Circle's sandbox indexer is down; the same path is proven on mainnet (table above).

The unit tests were mutation-checked: five deliberate breakages of the contract (hook length, hook
flag, cap selection, the wallet-as-recipient check, the kill-switch normalisation) were each caught by
the new tests.

## What deploying v2 to mainnet costs (dry run, 2026-09-21)

Measured with `scripts/dry-run-deploy-v2.sh`, which simulates an unsigned upload over Soroban RPC and
broadcasts nothing. XLM was about 0.209 USDC when this was run.

| | XLM | Basis |
|---|---|---|
| Upload the v2 code (57,448 bytes optimized) | 63.08 | simulated on mainnet |
| Instantiate | about 0.25 | v1's real instantiation charged 0.18 |
| Keep the deployer account alive | 1.00 | reserve |
| **Needed on the deployer** | **about 64.3** | about 13.4 USDC |
| Upkeep, v2 code rent | about 17 per month | measured slope on v1's code, scaled by size |

- The upload is expensive because it is prepaid rent for the code entry's minimum lifetime (about
  120 days) plus write fees, and both scale with the size of the wasm. v1's real upload charged 49.61
  XLM for 43,319 bytes. v2 is 33% larger (57,448), which is what the extra 13 XLM is.
- **Rent does not stop.** After the first ~120 days someone has to extend the code's lifetime, about
  17 XLM a month for v2 at today's network settings (v1 costs about 13). Anyone can pay an extension,
  and a lapsed code entry is archived and restorable, not lost. The admin dashboard should show the
  remaining lifetime for both contracts. Retiring v1 stops its share.
- The size is already tuned (`opt-level = "z"`, LTO, `strip`, `wasm-opt`). The only lever left is
  removing features, at roughly 0.37 XLM per month per KB of wasm.
- The rent rate is a network setting and can change; re-run the script before deploying.

## Deployed to mainnet (2026-09-24)

`CCPVTWII2TW6VVSVA4JQ2KFHICGBG4QVAHPIGUPSIW3E4VNPUI4Y2WQR`, recorded in `deployments/mainnet.json`
under `cctpWrapperV2` (wasm `b5227c30…`, deployed from an uncommitted tree, so the record carries a
`sourceSha256` of the crate as well as the wasm hash). v1 is untouched and still what the live web app
points at. Read back from the chain: admin, pauser and fee recipient as in v1; fee 0.10% with a 0.30
USDC floor; **min transfer 1 USDC** (the contract floor was lowered from 10 for this deploy) and
**max transfer 100 USDC**; Arc and Solana both forwarded, Solana with account creation. The real cost
was about 54.7 XLM (simulation said 63.9; unused refundable rent came back). Live quote checks: 1 USDC
to Arc is accepted, 2.5 USDC to Solana is accepted, 1 USDC to Solana is refused with `#41` (the
delivery fee would exceed a tenth of the burn), 0.9 USDC is refused with `#12`.

**First real transfer through it, 2026-09-24:** 3.7 USDC from Stellar to a Solana wallet with no USDC
account (`scripts/test-wrapper-v2-mainnet.sh`). Stellar tx
`cca4af89bff152915eacf4fc1650db49d71e1dd57a9725d7a97e6421162cd7b3`; Circle reported the forward
`COMPLETE` 40 seconds after submission (Solana tx
`2fpvybw9SE5A599N8w5JtERWduo8eDJJc7mZoPFXHJRgtP5HDJfXMJ68vYKzFQUZEAAchzv3bsPLsEv4BkNz3Wvs`). On Solana the
token account that Circle created holds exactly 3.369231 USDC (3.7 less the 0.330769 delivery fee) and the
wallet's SOL did not change. This is the wrapper, the hook, account creation and Circle's forward proven
together on mainnet. Two things it showed: the smallest amount that works for a new Solana wallet is about
10x Circle's fee (about 3.4 USDC, not the contract's 1 USDC minimum), and Circle's `high` fee for that case
moved 0.3445 -> 0.4127 -> 0.331 USDC within a quarter of an hour, so the bound is what refuses a transfer
sized close to it. The `max_fee` used was the live `high` quote at 1.0x and it was accepted.

## Rollout

Carried out, with one change: v2 went to mainnet with Arc and Solana (account creation on) together,
and the web app moved from v1 to v2 in one step on 2026-09-30 ([`cutover-v2.md`](./cutover-v2.md)).

1. Testnet end to end through the wrapper. **Done**, above.
2. Review, then deploy v2 to mainnet with **Arc only** (`forward: true`, `max_forward_fee` ≈ 0.10).
   v1 stays live and serves Solana until Solana forwarding is proven. **v1 depends on the relay
   this branch removes, so the web app cannot be deployed from this branch while v1 is what it
   points at.** Cut over in one step: v2 deployed and its domains committed, then the web app.
3. One real small transfer through v2 on mainnet before the UI points at it.
4. Solana forwarding is now proven on mainnet for both cases (2026-09-21). Add account creation to
   v2, enable Solana, then retire v1 by removing its domains.

## What Circle's docs say, and do not say (read 2026-09-21)

Read from the CCTP concept pages, the technical guide, the Stellar reference, the Stellar → Arc
quickstart and the OpenAPI spec. Fetched through a summarising tool, so wording is close, not exact.

**The lowest accepted `max_fee` is not documented anywhere.** The forwarding page says only that the
fee "is to cover gas costs on the destination chain and a small service fee", that Circle "quotes
gas dynamically", and that no tier or minimum is stated. The API spec calls `forwardFee`
`low` / `medium` / `high` "the {low, medium, high} gas estimate plus forwarding fee" and never says
which one must be met. So the floor is empirical and, because it tracks destination gas, it moves.
What is documented about `max_fee`: it is a gas budget. "Choosing a lower maxFee results in a lower
priority fee on the destination chain"; a higher one "can result in faster confirmation"; leftover
budget "is spent as an additional priority fee" and Circle "does not refund for excess gas". That is
why `feeExecuted` equalled `max_fee` in every run, and it means a bigger `max_fee` buys speed, not
just safety.

**Things the design must not assume:**

- `forwardErrorCode` and `forwardErrorDetails` are **not in the published spec**, and `forwardState`
  is documented only by an example (`PENDING`). Our fallback trigger cannot rest on them alone: keep
  the time-based fallback (a stalled forward), and treat `FAILED` as an early hint.
- The spec names the middle quote tier `medium`; the live API returns `med`. Read `high` only, or
  tolerate both.
- **Iris is rate limited to 40 requests per second, and exceeding it blocks the caller for five
  minutes (HTTP 429).** Every Iris call from our servers (the delivery status a receipt polls, `/claim`,
  the pre-flight check) now shares one budget; see "No relay" and `packages/cctp-client/src/iris-budget.ts`.
- Attestation is documented as fast on Stellar (Standard: 1 confirmation, about 5 s; Arc about 0.5 s;
  Solana about 25 s), and Circle's own quickstart polls every 5 s and allows up to 5 minutes. We
  observed 1 to 3 minutes to attest and 3 to 4 to forward, so a grace period well above 5 minutes is
  right, and the sandbox has been slower still.
- **Expiry.** Pre-finality (Fast) messages carry a 24-hour `expirationBlock` and can be re-attested
  with `POST /v2/reattest/{nonce}`. Standard messages do not. Every Stellar burn we have made,
  including the first mainnet v1 transfer that *requested* finality 1000, was executed at 2000 with
  `expirationBlock` 0, so "the attestation never expires" holds for Stellar-origin transfers. Keep
  that qualifier if this claim is repeated anywhere.
- `delayReason` (`insufficient_fee`, `amount_above_max`, `insufficient_allowance_available`) belongs
  to Fast Transfer delays, not to forwarding failures.
- Circle: "Do not hardcode fee values. Fees can change at any time." The forwarding page's flat
  "$0.05 for all other destinations" is a stale static figure; the live quotes are about $0.02 on Arc
  and $0.14 on Solana. Always read the API.
- Upfront fees (paying the forward fee on the source chain so the recipient gets the full amount) are
  marked unavailable with **Stellar as the source**, so the recipient always bears the forward fee.
- The Stellar → Arc quickstart burns with finality 1000 and `maxFee` 100,000 in **7-decimal** units,
  which agrees with the units and rounding used here.

## Open questions

- **ATA creation through the forwarder: done.** Built into v2 with unit tests (including one that
  pins the exact 65 bytes mainnet accepted) and simulated on testnet against Circle's real messenger.
  The front end derives the token account from the owner (the contract cannot), quotes with
  `includeRecipientSetup=true`, and passes the owner (2026-09-24). A
  failed creation forward is claimed by the owner like any other, but the claim then also has to
  create the token account, which `/claim` already handles. A real testnet burn of this path is blocked by Circle's sandbox indexer, but the path itself is
  proven on mainnet.
- **The minimum accepted `max_fee` is undocumented.** Circle's API spec calls `forwardFee` `low`,
  `medium`, `high` "gas estimate plus forwarding fee" and does not say which tier is required.
  Circle's forwarding page says the whole budget is consumed (any gas left over is spent as extra
  priority fee and not refunded), which matches `feeExecuted` = `max_fee` in every run.

- **Minimum accepted `max_fee`** is unknown: testnet accepted 24,383 and 5,046 was rejected. It
  has not been bisected, and it moves with Circle's quote.
- **Headroom over the quote.** The earlier 1.3× was a guess carried over from the first Arc test.
  Sampled on mainnet over three minutes, Solana's `low` tier was stable (0.7% spread), `med` moved
  ~6% and `high` ~5%, so `high` already sits about 22% above `low`. Two mainnet Solana burns at
  exactly 1.0× of `high` both forwarded, even though the quote rose 7 to 9% between checking it and
  sending. Circle takes the whole `max_fee`, so headroom is pure cost (and comes out of our margin).
  The default is 1.0×; the untested part is how far *below* `high` still works, and on the data so
  far it is not worth finding out (`low` vs `high` is about $0.03 per transfer).
- **A recipient with USDC but no SOL cannot move it.** The fresh test wallet now holds 0.638 USDC and
  0 SOL; sending it anywhere needs SOL for the Solana fee. That is true of any Solana wallet, not
  something forwarding causes, but first-time recipients are exactly the users who arrive with none.
- **Margin policy on cheap chains.** On Arc Xebra keeps ~0.28 of a 0.30 fee; on Solana ~0.15. If
  that is not the intent, `min_fee` can be tuned per the existing params timelock.
- **No external audit** of v1 or v2. `params.max_transfer` is the blast-radius lever; start low.
