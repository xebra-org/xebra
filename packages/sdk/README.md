# @xebra/sdk

Move native USDC between chains over Circle CCTP. Xebra prices the transfer and builds the
transactions; your user's wallet signs them. Xebra never holds keys or funds.

```sh
npm install @xebra/sdk
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

## What is in the package

| Import | For |
|---|---|
| `@xebra/sdk` | The API client, the wire schemas and types, error codes |
| `@xebra/sdk/core` | Pure helpers: chains, amounts, fee arithmetic, address checks |
| `@xebra/sdk/build` | Building the unsigned transactions yourself, against your own RPC |
| `@xebra/sdk/openapi` | The OpenAPI 3.1 document; also shipped as `@xebra/sdk/openapi.json` |

Amounts are decimal strings of USDC with at most six places (`"12.5"`), never numbers.

The client (`@xebra/sdk`) runs anywhere `fetch` does. The Stellar helpers in `/core` and the builders
in `/build` use `@stellar/stellar-sdk`, which needs a global `Buffer`: Node has one; in a browser
bundle, provide it as you would for stellar-sdk (for example `globalThis.Buffer = Buffer` from the
`buffer` package).

Documentation: https://docs.xebra.exchange · API: https://api.xebra.exchange/v1 · Licence: Apache-2.0
