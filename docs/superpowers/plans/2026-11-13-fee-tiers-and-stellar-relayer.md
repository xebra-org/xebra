# Fee tiers and the Stellar relayer for every source

Owner decisions, 2026-11-13:

- **No v3 wrapper.** The Stellar v2 and Arc wrappers stay deployed as they are.
- **Four costs in every transfer:** Circle's CCTP fee, the sender's gas (the burn), the recipient's
  gas (the mint), and Xebra's fee.
- **Three tiers:**

  | Tier | The user pays | Xebra pays | Xebra's price |
  |---|---|---|---|
  | `self` | burn gas, Circle's fee, mint gas (signs on both chains) | nothing | **0.05** |
  | `deliver` | burn gas | Circle's fee and, where Circle does not deliver, the mint gas | **0.10 + mint gas + Circle's fee** |
  | `gasless` | nothing | burn gas, Circle's fee, mint gas | **0.15 + gas on both chains + Circle's fee** |

- **Collected as a separate USDC payment** to Xebra's fee address, signed with the burn. The
  relayer and the gas sponsor act only once it has landed, so `deliver` and `gasless` are
  enforced. `self` is honour-based: anyone can call Circle directly.
- **The Stellar relayer completes every transfer into Stellar**, not only Sui's: Circle's
  Forwarding Service does not deliver to Stellar from any chain.
- **Sui's built-in gasless transfers cannot carry a CCTP burn** (tested on mainnet 2026-11-13: the
  validator answers `Function …::deposit_for_burn::deposit_for_burn is not supported in gasless
  transactions`). `gasless` on Sui means Xebra sponsors the gas.

## Phase 1: the Stellar relayer for every source

1. `verifyMessage` (SDK core) takes the allowed source domains instead of Sui only.
2. Attestation by `(sourceDomain, tx)`; `completeBurn` and `planClaim` take a source domain.
3. `POST /api/stellar-inbound/complete {src, tx}` for any source; the Sui routes call the same code.
4. EVM to Stellar builds: `mintRecipient` and `destinationCaller` both the `CctpForwarder`, hook
   naming the recipient. Routes list `stellar` as a destination from EVM chains.
5. Gate: the relayer completes only burns whose fee payment it can see (Phase 2). Until then the
   gate is off and the relayer behaves as today.

## Phase 2: fee tiers

1. Core: `XEBRA_FEE = { self: 0.05, deliver: 0.10, gasless: 0.15 }`, `planTier(...)` returning
   `{ xebra, circle, sourceGas, destinationGas, total, paidToXebra }`.
2. Gas prices in USDC: Stellar fee in XLM at the XLM/USDC book price; EVM gas at the chain's gas
   price and native/USD (Arc pays gas in USDC); Sui at SUI/USD. Each estimate carries a margin.
3. `/v1/quote` returns the three tiers, each priced or refused with its reason. `/v1/transfers`
   takes `tier` and adds the fee payment step (USDC transfer to the fee address on the source
   chain). EVM wallets that support `wallet_sendCalls` get approve + burn + fee in one batch.
4. Fee registry (Convex): a fee payment is spent once, bound to one burn.
5. Wrapper chains (Stellar, Arc): send straight to Circle with the fee payment, or keep the wrapper
   at its live terms until the fee is tightened to zero. Owner to choose when the 10M cap lands.

## Phase 3: gasless

Stellar: fee-bump by a sponsor key. Sui: sponsored transaction (`setGasOwner`), sponsor signs only
a transaction it built and byte-compares. EVM: needs a contract or EIP-7702; out of scope without
a deployment.

## Out of scope

Deploying any new wrapper. Reusing the escrow contract.
