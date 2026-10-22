# MCP server

`https://xebra.exchange/mcp` is a remote [Model Context Protocol](https://modelcontextprotocol.io) server
(Streamable HTTP, stateless, no sign-in). An assistant connected to it can find Xebra, see which routes are
live, price a transfer and hand the person a link. **It cannot send funds.** No tool signs, holds a key or
moves USDC; the person opens the link and approves in their own wallet.

| Tool | What it does |
|---|---|
| `list_routes` | Every source and the destinations it reaches right now, with the chain ids the other tools take |
| `quote_transfer` | Fee, what the recipient receives, Circle's status, for `from`, `to`, `amount` |
| `create_transfer_link` | A `xebra.exchange/?from=…&to=…&amount=…&recipient=…` link that opens the bridge prefilled |
| `get_transfer_status` | Circle's state for a burn hash; points a failed delivery at `/claim` |

All four are read-only. Prices come from the same code the page uses (`lib/forward-fee.ts`,
`lib/evm-forward-fee.ts`) and the same Iris budget, so what an assistant says matches what the page shows.
A recipient is checked against the destination chain's rules before it goes into a link.

## Where it lives

- `app/mcp/route.ts` — the HTTP endpoint (POST only, open CORS, 16 KB body cap)
- `lib/mcp/protocol.ts` — JSON-RPC and the MCP methods this needs (`initialize`, `ping`, `tools/list`, `tools/call`), no SDK
- `lib/mcp/tools.ts` — the tools, with their network reads injected so they are tested with fakes
- `lib/mcp/server.ts` — the real wiring: the contract's committed domains, the site's own `/api/circle-health` and `/api/delivery` handlers
- `server.json` — the registry entry

## Trying it

```
curl -s https://xebra.exchange/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_routes","arguments":{}}}'
```

Or add `https://xebra.exchange/mcp` as a custom connector in Claude, or in ChatGPT's developer mode. Both
were not yet tried against the live site when this was written: a reported client behaviour is to attempt
OAuth discovery even on a server that asks for none, so test the real connector before announcing it.

## Being found

Publishing `server.json` to the official registry needs the domain proven (a DNS TXT record or
`/.well-known/mcp-registry-auth`) and is the owner's step:

```
mcp-publisher login dns --domain xebra.exchange
mcp-publisher publish
```

`/.well-known/mcp` is not used: that part of the standard is still unsettled. Search ranking and what a
model answers cannot be set from our side; this makes Xebra findable and citable.
