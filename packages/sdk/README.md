# @xebra/sdk

Move native USDC between chains over Circle CCTP. Xebra prices the transfer and builds the
transactions; your user's wallet signs them. Xebra never holds keys or funds.

```sh
npm install @xebra/sdk
# or
pnpm add @xebra/sdk
yarn add @xebra/sdk
bun add @xebra/sdk
```

## Quickstart

```ts
import { XebraApiError, createXebraClient } from "@xebra/sdk";

const xebra = createXebraClient();

// What would 25 USDC from Stellar to Base cost, and what arrives?
// (For Solana, also pass `recipient`: a wallet with no USDC account costs more to deliver to.)
const quote = await xebra.quote({ from: "stellar", to: "base", amount: "25" });
console.log(`${quote.recipientGets} USDC arrives; fees ${quote.fees.total}`);

// Build it for this sender and recipient. Nothing is signed or sent.
const { steps } = await xebra.createTransfer({
  from: "stellar",
  to: "base",
  amount: "25",
  sender: "G...",          // the Stellar account that signs
  recipient: "0x...",      // who receives on Base
  maxTotalFee: quote.fees.total, // refuse if fees rose since the quote
});
// Have the wallet sign steps[i].tx in order, submit, then follow the burn:
// const status = await xebra.waitForDelivery("stellar", burnTxHash);
```

Errors carry a stable `code` and a sentence for a person:

```ts
try {
  await xebra.quote({ from: "stellar", to: "base", amount: "500" });
} catch (err) {
  if (err instanceof XebraApiError && err.code === "amount_above_maximum") {
    console.log(`At most ${err.extra.maximum} USDC per transfer.`);
  }
}
```

## Rebalancing USDC inside NEAR Intents (market makers)

NEAR Intents keeps one USDC balance per chain. When your Base USDC is full and your Avalanche USDC
is empty, `createRebalancer` moves your own money across over CCTP: withdraw from NEAR Intents to
your wallet, burn, and Circle mints straight into a 1Click deposit address that credits your
Intents account. Every step is signed by your keys; Xebra holds nothing.

```ts
import { createXebraClient } from "@xebra/sdk";
import { createRebalancer } from "@xebra/sdk/intents";

const rb = createRebalancer({
  xebra: createXebraClient(),
  oneClick: { apiKey: process.env.ONECLICK_API_KEY }, // your partner key; only the withdrawal needs it
});
const req = {
  intentsAccount: "mm.near",
  from: "base",
  to: "avax",
  amount: "100000",
  fromWallet: "0xYourBaseWallet",
  toWallet: "0xYourAvalancheWallet", // refunds land here if the mint comes too late
};

const e = await rb.estimate(req); // dry quotes only; also prices the same move as one Intents swap
if (e.better === "rebalance") {
  const w = await rb.startWithdrawal(req); // sign w.intent.payload with mm.near's key
  await rb.submitWithdrawal(w, signed);
  const withdrawn = await rb.waitFor(w.depositAddress);
  if (withdrawn !== "SUCCESS") throw new Error(`withdrawal ${withdrawn}: nothing to burn`);
  const d = await rb.prepareDeposit(req, { amount: w.receives });
  // sign and send d.build.steps from 0xYourBaseWallet, then:
  const deposited = await rb.waitFor(d.depositAddress);
  if (deposited !== "SUCCESS") console.warn(`deposit ${deposited}: see below`);
}
```

`waitFor` returns the end state rather than throwing, so check it before the next step:

- Withdrawal `SUCCESS`: the USDC is in `fromWallet`; build the burn. `REFUNDED`: it went back to
  your Intents `from` balance; start again with a new quote. `FAILED`: 1Click could not finish it;
  do not build a burn, ask `rb.status(w.depositAddress)` and 1Click support with that address.
- Deposit `SUCCESS`: credited to your Intents `to` balance. `REFUNDED`: Circle's mint came after
  the deposit address expired, so 1Click sent the USDC to `toWallet`; deposit it into Intents
  again. `FAILED`: ask 1Click support with `d.depositAddress`; never burn the same amount twice.
- `waitFor` throws when its deadline passes first: the move may still settle, so check
  `rb.status(...)` before doing anything again.

Live dry quotes on 2026-11-14 for 100,000 USDC from Base: Avalanche, Polygon, Optimism and Monad
cost 0.05 to 0.10 USDC this way, and NEAR Intents had no market maker to quote the same move as one
swap. Only routes Xebra runs are offered (`GET /v1/routes`).

## What is in the package

| Import | For |
|---|---|
| `@xebra/sdk` | The API client, the wire schemas and types, error codes |
| `@xebra/sdk/core` | Pure helpers: chains, amounts, fee arithmetic, address checks |
| `@xebra/sdk/build` | Building the unsigned transactions yourself, against your own RPC |
| `@xebra/sdk/intents` | NEAR Intents: route checks, deposits into 1Click, market-maker rebalancing |
| `@xebra/sdk/openapi` | The OpenAPI 3.1 document; also shipped as `@xebra/sdk/openapi.json` |

Amounts are decimal strings of USDC with at most six places (`"12.5"`), never numbers.

The client (`@xebra/sdk`) runs anywhere `fetch` does. The Stellar helpers in `/core` and the builders
in `/build` use `@stellar/stellar-sdk`, which needs a global `Buffer`: Node has one; in a browser
bundle, provide it as you would for stellar-sdk (for example `globalThis.Buffer = Buffer` from the
`buffer` package).

Documentation: https://docs.xebra.exchange · API: https://api.xebra.exchange/v1 · Licence: Apache-2.0
