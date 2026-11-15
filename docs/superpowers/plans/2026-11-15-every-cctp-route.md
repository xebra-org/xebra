# Every CCTP route, never free

Owner decisions, 2026-11-15:

- **Every route CCTP supports**: the 30 chains in Circle's list that carry USDC (BNB is USYC only),
  every direction. Xebra had 19.
- **Re-add Ethereum, Linea, Plume and EDGE** (removed earlier as weak spots).
- **Never free, but cheap**: a flat USDC fee on every route without a Xebra contract, paid as its
  own transfer to Xebra's fee address on the source chain (the 2026-11-13 plan,
  `2026-11-13-fee-tiers-and-stellar-relayer.md`): **0.10** where the transfer is delivered (Circle's
  Forwarding Service, or Xebra's Stellar relayer), **0.05** where the recipient claims. The Arc and
  Stellar contracts keep their own fee (0.05%, 0.10 floor).
- **Where Circle does not deliver** (Stellar, Sui, Aptos, Starknet, Injective, Morph, Pharos): the
  recipient claims at `/claim` first; a Xebra relayer per chain later. Stellar keeps its relayer.

Branch `every-route` (worktree `../xebra-routes`). One real transfer per route family before its
switch goes on in production; the user sets Vercel env and merges.

## Circle's list (2026-11-15)

| Group | Chains | Circle delivers | Fee |
|---|---|---|---|
| In Xebra | Arbitrum, Arc, Avalanche, Base, Codex, HyperEVM, Ink, Monad, OP, Polygon, Sei, Sonic, Unichain, World Chain, XDC, Solana | yes | 0.10 |
| In Xebra | Stellar | no (Xebra relayer) | 0.10 |
| In Xebra | Sui, Aptos | no | 0.05 (claim) |
| Re-add | Ethereum, Linea, Plume, EDGE | yes | 0.10 |
| New | Cronos, Plasma, X Layer | yes | 0.10 |
| New, EVM | Injective, Morph, Pharos | no | 0.05 (claim) |
| New, non-EVM | Starknet | no | 0.05 (claim) |

The fee is set by the destination: delivered 0.10, claimed 0.05.

## Phase A: the flat fee

1. SDK core: `XEBRA_FLAT_FEE = { deliver: 100_000n, claim: 50_000n }` and `flatFeeFor(dest)`.
   `planEvmFee` takes `xebraFee`: the amount is what leaves the wallet; the burn is
   `amount - xebraFee`; the tenth rule applies to the burn. Default 0 keeps old callers working.
2. SDK API: `TransferStep.id` gains `fee`. A new `UnsignedTx` kind for an Aptos entry-function call
   (Circle's burn is a fixed script, so the fee is its own transaction there). SDK minor release.
3. Fee addresses: `XEBRA_FEE_ADDRESS_EVM` (default the Arc wrapper's fee recipient
   `0x32e95718A4D9B60F2e4Fb1d371189ac5DD28211A`, an EOA), `_SOLANA`, `_SUI`, `_APTOS`. A source
   family without one is refused, not served free. Set all four on Vercel before merging.
4. Service: non-wrapper quotes carry the flat fee; builds add it.
   - EVM: `approve`, `burn`, then `fee` (USDC `transfer`). Wallets with `wallet_sendCalls` batch them.
   - Solana: a `TransferChecked` instruction in the burn transaction (atomic). Xebra's USDC account
     must exist.
   - Sui: `splitCoins` + `transferObjects` in the burn's programmable transaction (atomic).
   - Aptos: `burn`, then a `fee` step, `0x1::primary_fungible_store::transfer`.
5. UI: the EVM, Solana, Sui and Aptos forms show and send the fee the same way.
6. Docs (fees page, changelog, API reference), MCP parity snapshot, tests.

## Phase B: complete the 19

1. EVM to Solana from every EVM chain: route gating only (`evmDestinationsFrom`, `evmSources`,
   `isOfferedRoute`, SEO slugs), behind a list flag like the others.
2. EVM to Stellar: `stellarBurnRecipient`, `via: null`, Standard only, 1 USDC minimum, the relayer
   completes it; quote, build, status, claim and the form. Fee 0.10.
3. Tests per `reports/evm-to-non-evm-routes.md` §6.

## Phase C: chains Circle delivers to

Ethereum (0), Linea (11), Plume (22), EDGE (28), Cronos (32), Plasma (33), X Layer (37): chain table
entries (chain id, USDC, RPC, explorer, Fast, delivery cap), picker logos, mesh, Arc and Stellar
destinations. Probe Iris `fees/{s}/{d}?forward=true` for every pair first. Adding a destination to
the Arc or Stellar contract is an owner transaction with a 48 h timelock (user runs it).

## Phase D: EVM chains Circle does not deliver to

Injective (29), Morph (30), Pharos (31): destinations without forwarding (no hook, claim on arrival
through `/claim`'s EVM path), sources as any EVM chain. Fee 0.05 into them.

## Phase E: Sui and Aptos as destinations

New `BurnRecipient` kind (32-byte recipient, zero caller, no hook), `DestId` widened, a mint builder
against Circle's contracts on each, claim UI, status, `/v1/claims`. Fee 0.05.

## Phase F: Starknet

A new non-EVM chain both ways: wallet, burn, claim. Last.
