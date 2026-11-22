# Cutover to wrapper v2

**Status (2026-10-14): carried out.** `forwarding-v2` was merged to `main` on 2026-09-30 (87fa729), and
production (built from `main`) points at v2 with Arc switched on; `/api/relay/*` and `/api/health` are
404 and `scripts/smoke-prod.sh` passes. Of "After cutover": Arc is enabled, the admin panel shows both
contracts' remaining rent, and the docs have been rewritten. v1 is still deployed and not paused, and
v2's `max_transfer` is still 100 USDC. Everything below is the checklist as written.

Written 2026-09-24. What it takes to move the live app from wrapper v1 plus the relay to wrapper v2
plus Circle's Forwarding Service, in order, with how to tell each step worked and how to back out.

## Where things stand

| | State |
|---|---|
| Wrapper v2 | **Deployed and proven on mainnet.** `CCPVTWII2TW6VVSVA4JQ2KFHICGBG4QVAHPIGUPSIW3E4VNPUI4Y2WQR`. One real transfer through it (3.7 USDC to a Solana wallet with no account) was forwarded by Circle in 40 s. |
| Web app on `forwarding-v2` | Built, tested, builds clean. Not committed, not pushed, not deployed. |
| Production app (`xebra-sandy.vercel.app`) | **The old build**: wrapper v1, relay routes. Its own health route reports `RELAY_SOLANA_KEYPAIR not set`, so **a transfer made on it today is burned and never delivered**; the owner has to claim it at `/claim`. Every day this waits is a day that is true. |
| Convex `knowing-zebra-183` | Still the relay's functions and tables. `IRIS_BUDGET_SECRET` is set. |
| Vercel env | `IRIS_BUDGET_SECRET` set. `NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID` is still v1's id. |

The verification for every step below is `scripts/smoke-prod.sh`, which is read-only and can point at
any URL.

## Decisions for you before starting

1. **Pause v1 now?** With the relay off, the live app accepts transfers nobody delivers. `pause()` on v1
   (the pauser key, one transaction, reversible by the admin) makes the live app refuse them with a clear
   error until cutover. Recommended if the cutover is more than a day away. If you say yes I do it.
2. **Arc on or off at launch?** `NEXT_PUBLIC_ARC_ENABLED=1` shows Arc in the picker. Arc is in v2's
   domain list and forwarding to Arc was proven on mainnet directly, but **no transfer to Arc has gone
   through the wrapper on mainnet**. Recommended: launch Solana only, send one small Arc transfer, then
   enable Arc (a redeploy, since it is a build-time variable).
3. **One real-wallet transfer from the new UI before production.** The test that passed used the
   Stellar CLI, which authorises as the transaction source. A browser wallet (Freighter and others) signs
   a separate authorisation tree, and that is exactly where v1's first mainnet attempts failed
   (`approval_expiration_ledger`, argument-by-argument auth matching). v2 changed the request, so this is
   the single remaining thing nothing has exercised. It costs about 3.6 USDC for Solana (or 1 USDC to
   Arc) and is best done on the preview deployment in step 4. Skipping it is your call; it is the one
   step I would not skip.
4. **Commit.** Vercel deploys from GitHub (`xebra-org/xebra`). Nothing here has been committed, and
   `deployments/mainnet.json` records v2 as deployed from an uncommitted tree. Commit the branch (no
   co-author line, per your rule) before step 3.

## How the smallest transfer works (so nobody is surprised)

The contract's minimum is 1 USDC, but Circle's delivery fee may not exceed a tenth of what is burned, so the
real minimum depends on the route and on Circle's fee that minute. Checked against the live contract at the
boundary (one stroop either side): about **1 USDC to Arc**, about **1.9 USDC to an existing Solana account**
(fee 0.17), about **3.3 USDC to a Solana wallet with no USDC account** (fee 0.33). The page computes this
from the live fee and the contract's own parameters and says it under the amount field, with 5% headroom,
instead of showing a contract error. The default amount is now 5 USDC and the quick buttons are 5, 10, 100.
Circle's fee for a new account moved 0.331, 0.345, 0.413 within a quarter of an hour, so a transfer sized
right at the minimum can be refused and need a retry.

## The steps

### 1. Commit and push the branch (Vercel builds a preview from it)

```bash
git add -A            # review `git status` first: .secrets/ is ignored, film/ and others are untracked
git commit -m "Forwarding wrapper v2, no relay, Circle pre-flight and rate budget"
git push -u origin forwarding-v2
```

Check: Vercel shows a Preview deployment for the branch. It will **fail to work correctly** until step 3,
which is expected: it is built before its variables are right.

### 2. Convex

Convex will not deploy a schema that leaves out a table that still has rows, so clear the two relay
tables first. They hold public transaction hashes and Circle's public attestations, nothing secret.

1. Dashboard → `knowing-zebra-183` → Data → `relayJobs` → delete all documents; same for `watcherCursors`.
2. Confirm `IRIS_BUDGET_SECRET` is set: `cd apps/web && npx convex env list --prod` (shows names).
3. Build the workspace package the functions import, then deploy:
   ```bash
   pnpm --filter @xebra/cctp-client build
   cd apps/web && npx convex deploy
   ```
4. Remove anything still named `RELAY_*` from the deployment.

Check: dashboard shows one table, `irisBudget`, and the functions `irisBudget:acquire`, `rateLimited`,
`current`. The old production app's relay routes stop working at this moment; they are already not
delivering anything.

### 3. Vercel environment

For **Production and Preview** (a preview built without these is a false test):

| Variable | Value | Note |
|---|---|---|
| `NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID` | `CCPVTWII2TW6VVSVA4JQ2KFHICGBG4QVAHPIGUPSIW3E4VNPUI4Y2WQR` | **Build-time**: changing it needs a redeploy. Set Production only when step 5 is about to run, because the old code cannot talk to v2. |
| `IRIS_BUDGET_SECRET` | the same value as on Convex | done; must match exactly or the app silently counts alone |
| `CONVEX_URL` | `https://knowing-zebra-183.convex.cloud` | read at runtime |
| `NEXT_PUBLIC_ARC_ENABLED` | leave unset (decision 2) | |
| anything `RELAY_*` | delete | |

### 4. Verify the preview

Preview URLs are behind Vercel's deployment protection, so give the script the bypass secret (Project →
Settings → Deployment Protection → Protection Bypass for Automation):

```bash
BASE_URL=https://<the preview url> VERCEL_BYPASS_SECRET=<secret> ./scripts/smoke-prod.sh
```

Every line must be `ok`. In particular `the shared counter is in use` proves Convex and Vercel agree on the
secret. Then, decision 3: open the preview in a browser with a real Stellar wallet and send the smallest
amount that works. Expect: a quote that shows one fee; one wallet prompt; a receipt that goes from
"waiting" to "delivered" with a link to the destination transaction, in about a minute.

### 5. Production

1. Set `NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID` to v2's id for **Production**.
2. Merge `forwarding-v2` into `main` (Vercel builds production from `main`).
3. When the build is ready:
   ```bash
   BASE_URL=https://xebra-sandy.vercel.app ./scripts/smoke-prod.sh
   ```
   All `ok`, exit status 0. A `down` in the Circle lines is Circle being unhealthy at that moment, not the app; re-run.
4. Watch the first real transfers on the receipt and in `scripts/burn-verdicts.py`-style checks against Iris
   (`forwardState` should read `COMPLETE`, not `FAILED`).

## If something goes wrong

**Do not roll back to the old deployment.** It talks to v1 and there is no relay, so it is the state that
loses users' delivery. Stop the new one from accepting transfers instead; each of these is instant and
reversible:

| Problem | Action | Who |
|---|---|---|
| Anything doubtful, stop everything | `pause()` on v2 | pauser or admin key |
| One destination misbehaves (Circle changes its hook, fees spike) | `tighten_domain(domain, forward=false, ...)`. The page then refuses that route before signing | pauser or admin key |
| Worried about exposure | lower `max_transfer` (instant; raising it needs the 48 h timelock) | admin key |
| A forward failed for someone | they claim at `/claim` (attestation is public; they pay destination gas) | the user |
| The shared counter stops working | nothing: each instance counts alone; `budgetBackend: local` in `/api/circle-health` says so | |

`pause` and `tighten_domain` take the pauser or admin identity; the keys are the `xebra-pauser` and
`xebra-admin` Stellar CLI identities, each holding 2 XLM for fees.

## After cutover

- **Retire v1.** Pause it, withdraw its 0.2 USDC of accrued fees (admin only), and stop paying its rent.
  v1's code rent runs out around 2027-01-07 if nobody extends it (archived and restorable, not lost).
- **Upkeep.** v2's code rent runs out around 2027-01-22 unless extended, and costs about 17 XLM a month at
  today's rates. `xebra-deployer` holds about 2 XLM. Top it up before December, and put "remaining code
  lifetime" on the admin dashboard. Anyone can pay an extension:
  `stellar contract extend --wasm-hash b5227c305b916c80a81d675dd8fbd8103e7d62e91c501e044ec93e365e686cd8 --ledgers-to-extend <n> --durability persistent --source-account xebra-deployer`
  and the same with `--id` for the contract instance. Re-run `scripts/dry-run-deploy-v2.sh` for the current rate.
- **Raise `max_transfer`** above 100 USDC once enough clean transfers have gone through (48 h timelock).
- **Rewrite the docs** that still describe the relay: `README.md`, `SECURITY.md`, `docs/deploying.md`,
  `docs/go-live.md`, `docs/environments.md`, `docs/architecture.md`.
- **Enable Arc** (decision 2), then the same for any further chain: add the domain (48 h timelock),
  confirm Circle lists it as a forwarding destination, quote it, send one small transfer.
