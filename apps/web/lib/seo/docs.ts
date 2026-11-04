import { EVM_CHAINS, type EvmChainId } from "../evm-chains";
import { CONTRACTS, FEES, usdc } from "./facts";
import { type Faq, faqFor } from "./faq";
import { ENDPOINT_NAMES, type RouteInfo } from "./routes";

/**
 * Every page the site writes for people and for AI assistants, as Markdown.
 *
 * One source, three outputs: the HTML page (rendered at build time), the same text at `<page>.md`,
 * and `llms.txt`/`llms-full.txt`, which index and concatenate them. Nothing can say one thing on the
 * page and another to an assistant, because there is only one thing.
 */
export interface Doc {
  /** The page: `/fees`. The home page is `/`. */
  path: string;
  /** Its Markdown copy: `/fees.md`; the home page's is `/index.md`. */
  markdownPath: string;
  /** For `<title>`, without "· Xebra". */
  title: string;
  description: string;
  /** How llms.txt groups it. */
  section: "overview" | "docs" | "routes";
  markdown: string;
  breadcrumb: Array<{ name: string; path: string }>;
  faq?: Faq[];
  route?: RouteInfo;
}

const md = (path: string) => (path === "/" ? "/index.md" : `${path}.md`);

const xebraFeeRule = `${FEES.bps / 100}% of the amount, at least ${FEES.minFeeUsdc} USDC`;

function overview(routes: RouteInfo[], arcViaWrapper: boolean): Doc {
  const fromStellar = routes.filter((r) => r.from === "stellar").map((r) => ENDPOINT_NAMES[r.to]);
  const fromArc = routes.filter((r) => r.from === "arc").map((r) => ENDPOINT_NAMES[r.to]);
  return {
    path: "/",
    markdownPath: md("/"),
    title: "Xebra — native USDC between chains",
    description:
      "Bridge native USDC between Stellar, Solana, Arc and EVM chains over Circle's CCTP. No wrapped tokens, no custody, and every transfer claimable.",
    section: "overview",
    breadcrumb: [{ name: "Xebra", path: "/" }],
    markdown: `# Xebra: native USDC between chains

Xebra moves native USDC between blockchains over Circle's Cross-Chain Transfer Protocol (CCTP). Circle burns the USDC on the chain you send from and mints the same amount of native USDC on the chain you send to. There is no wrapped token, no liquidity pool, and nobody holds your funds in between.

## What you can do

- **From Stellar** to ${list(fromStellar)}, through Xebra's contract on Stellar, with one signature in Freighter or LOBSTR.
${fromArc.length ? `- **From Arc** to ${list(fromArc)}.\n` : ""}
Every live route has its own page under [routes](/routes).

## How it works

1. You sign one transfer on the chain you send from.
2. Circle attests the burn once that chain has finalised it.
3. Circle's Forwarding Service mints the USDC to your recipient and pays the gas there. It usually takes a few minutes.

If delivery ever fails, the transfer is still attested and anyone can finish it: [claim it yourself](/claim). More in [how it works](/how-it-works).

## Fees

From Stellar, Xebra charges ${xebraFeeRule}, and Circle's delivery fee is paid out of that, not added on top. ${arcViaWrapper ? "From Arc the same rule applies." : "From Arc there is no Xebra fee, only Circle's delivery fee."} Details on [fees](/fees).

## Safety

Xebra's contracts are open source and cap each transfer through them at ${FEES.maxTransferUsdc} USDC while they have had no external audit; they can be paused instantly and any other change waits 48 hours. See [security](/security).
`,
  };
}

function howItWorks(): Doc {
  return {
    path: "/how-it-works",
    markdownPath: md("/how-it-works"),
    title: "How USDC moves between chains",
    description:
      "How a Xebra transfer works: Circle burns USDC on one chain, attests it, and mints native USDC on the other. What you sign, timing, and failed deliveries.",
    section: "docs",
    breadcrumb: crumbs("How it works", "/how-it-works"),
    markdown: `# How Xebra moves USDC between chains

Xebra is an interface and a fee contract on top of Circle's Cross-Chain Transfer Protocol (CCTP), the protocol Circle built to move USDC between blockchains without wrapping it.

## Burn, attest, mint

1. **Burn.** You send USDC to Circle's contract on the chain you send from, naming the recipient on the other chain. Circle burns it.
2. **Attest.** Circle waits for that chain to finalise the burn, then signs an attestation: a message saying this USDC was burned, for this recipient, on this destination.
3. **Mint.** Circle's Forwarding Service submits the attestation on the destination chain, which mints the same amount of native USDC to the recipient. The Forwarding Service pays the destination's gas and takes its delivery fee out of the amount.

Because the USDC on the destination is minted by Circle itself, it is the same native USDC as anyone else's there, not a bridged copy.

## What you sign

- **From Stellar**, one transaction in Freighter or the LOBSTR extension. Xebra's contract on Stellar takes its fee and hands the burn to Circle in that same transaction, so either both happen or neither does.
- **From Arc**, two prompts in your EVM wallet: approving the amount, then the transfer itself. Arc charges its gas in USDC, so keep a few cents in the wallet.

## How long it takes

Usually a few minutes: the time for the source chain to finalise, for Circle to attest, and for the Forwarding Service to submit the mint. The bridge shows the transfer's progress until the USDC has arrived.

## If delivery fails

Nothing is lost. Each transfer names no particular party to complete it, so once Circle has attested the burn, anyone can submit the mint. If the Forwarding Service ever fails, open [claim](/claim), paste the burn's transaction hash, and submit the mint from your own wallet; you pay that chain's gas. A Standard transfer's attestation never expires.

## Recipients on Solana

USDC on Solana is held in a token account that belongs to a wallet. You give the bridge the wallet address; it works out the token account. If the wallet has none yet, Circle opens it during delivery, for a higher delivery fee that the bridge shows before you sign.

## Related

- [Fees](/fees)
- [Routes](/routes)
- [Security](/security)
- [Questions](/faq)
`,
  };
}

function fees(routes: RouteInfo[], arcViaWrapper: boolean): Doc {
  const stellarCaps = routes.filter((r) => r.from === "stellar");
  const arcCaps = routes.filter((r) => r.from === "arc");
  const capRow = (r: RouteInfo) =>
    `| ${ENDPOINT_NAMES[r.from]} → ${ENDPOINT_NAMES[r.to]} | ${usdc(r.deliveryCapUnits)} USDC${
      r.deliveryCapNewAccountUnits !== null
        ? ` (${usdc(r.deliveryCapNewAccountUnits)} when Circle opens the account)`
        : ""
    } |`;
  return {
    path: "/fees",
    markdownPath: md("/fees"),
    title: "Fees for bridging USDC",
    description: `What a Xebra transfer costs: ${xebraFeeRule} from Stellar, Circle's delivery fee included${arcViaWrapper ? ", and the same from Arc" : "; from Arc, Circle's delivery fee only"}.`,
    section: "docs",
    breadcrumb: crumbs("Fees", "/fees"),
    markdown: `# Fees for bridging USDC with Xebra

The bridge always shows exactly what the recipient will get before you sign, read live from the contracts and from Circle. This page explains how that figure is made. Figures are as set on the contracts on ${FEES.asOf}; they can only change after a public 48-hour wait.

## From Stellar

Xebra's fee is **${xebraFeeRule}**. Circle's delivery fee is paid **out of** Xebra's fee, not added on top: if Circle's fee is ever the larger of the two, you pay Circle's fee and Xebra keeps nothing.

| You send | Fee | Recipient gets |
|---|---|---|
| 10 USDC | 0.30 USDC | 9.70 USDC |
| 50 USDC | 0.30 USDC | 49.70 USDC |
| 100 USDC | 0.30 USDC | 99.70 USDC |

The only other cost is the Stellar network fee, a fraction of a cent in XLM. Each transfer is ${FEES.minTransferUsdc} to ${FEES.maxTransferUsdc} USDC.

## From Arc

${
  arcViaWrapper
    ? `Transfers out of Arc go through Xebra's contract on Arc with the same rule: **${xebraFeeRule}**, with Circle's delivery fee paid out of it.`
    : "There is **no Xebra fee** on transfers out of Arc: your wallet calls Circle directly. You pay Circle's delivery fee, usually a few cents, which is taken out of the amount."
} Arc charges gas in USDC, a fraction of a cent per transaction; keep a few cents in the wallet.

## Circle's delivery fee

Circle's Forwarding Service charges for submitting the mint on the destination and paying the gas there. It differs by chain and moves with gas prices; the bridge reads Circle's live quote. Xebra refuses to sign a delivery fee above these limits, and never one above a tenth of the amount:

| Route | Most Circle may charge |
|---|---|
${[...stellarCaps, ...arcCaps].map(capRow).join("\n")}

## Small transfers

Because Circle's fee may be at most a tenth of what is burned, the smallest transfer depends on the route and on Circle's fee that day. From Stellar it is about 1 USDC to Arc, about 2 USDC to an existing Solana account and more to a new one. The bridge tells you if an amount is too small before you sign.

## Related

- [How it works](/how-it-works)
- [Routes](/routes)
`,
  };
}

function routesIndex(routes: RouteInfo[]): Doc {
  const bySource = new Map<string, RouteInfo[]>();
  for (const r of routes) bySource.set(r.from, [...(bySource.get(r.from) ?? []), r]);
  const sections = [...bySource.entries()]
    .map(
      ([from, rs]) =>
        `## From ${ENDPOINT_NAMES[from as RouteInfo["from"]]}\n\n${rs
          .map((r) => `- [${ENDPOINT_NAMES[r.from]} to ${ENDPOINT_NAMES[r.to]}](/bridge/${r.slug})`)
          .join("\n")}`,
    )
    .join("\n\n");
  return {
    path: "/routes",
    markdownPath: md("/routes"),
    title: "Supported routes for bridging USDC",
    description: `Every route Xebra bridges native USDC on today: ${routes.length} routes between Stellar, Solana, Arc and EVM chains over Circle's CCTP.`,
    section: "docs",
    breadcrumb: crumbs("Routes", "/routes"),
    markdown: `# Supported routes for bridging USDC

Xebra moves native USDC over Circle's CCTP on these ${routes.length} routes. Each page has the fees, timing and what to do if a transfer gets stuck.

${sections}

More destinations from Stellar are added one at a time: each needs a 48-hour wait on the contract before it goes live, and appears here when it does.
`,
  };
}

function security(arcViaWrapper: boolean): Doc {
  return {
    path: "/security",
    markdownPath: md("/security"),
    title: "Security, contracts and custody",
    description:
      "Xebra's contracts and their addresses, what they can and cannot do with your USDC, how they are governed, their audit status, and how to report a problem.",
    section: "docs",
    breadcrumb: crumbs("Security", "/security"),
    markdown: `# Security, contracts and custody

## Contracts

| Contract | Chain | Address |
|---|---|---|
| Xebra fee wrapper v2 | Stellar | [\`${CONTRACTS.stellarWrapper.address}\`](${CONTRACTS.stellarWrapper.explorer}) |
| Xebra fee wrapper | Arc | [\`${CONTRACTS.arcWrapper.address}\`](${CONTRACTS.arcWrapper.explorer}) |

Both are open source: [github.com/drydocs/xebra](https://github.com/drydocs/xebra). Burning, attesting and minting are Circle's contracts and Circle's service.

## Custody

- **From Stellar**, your USDC goes from your wallet to Circle inside the one transaction you sign. Xebra's contract takes its fee in the same transaction and never holds the principal.
- **From Arc**, ${
      arcViaWrapper
        ? "Circle's contract burns from whoever calls it, so Xebra's contract on Arc holds the USDC for the length of that one transaction. It fails the transaction unless it burned exactly what it should and holds nothing beyond its own fees."
        : "your wallet calls Circle's contract directly. Xebra's contract on Arc is deployed but not used by the bridge yet."
    }
- Every transfer can be completed by anyone once Circle has attested it, so a transfer never depends on Xebra being online. See [claim](/claim).

## Limits and governance

- Each transfer through Xebra's contracts is capped at ${FEES.maxTransferUsdc} USDC while they have had no external audit.
- The fee can never exceed 1%, and Circle's delivery fee can never exceed a set limit per chain or a tenth of the transfer. These ceilings are written into the contracts.
- A pauser can stop new transfers instantly. Every change that loosens anything (fees, limits, chains, keys) is announced on chain and takes effect only after 48 hours, during which the pauser can cancel it.

## Audits

The contracts have **not had an external audit**. They are tested (unit, property and fork tests, and real transfers on testnet and mainnet), and limits are kept low until that changes.

## Reporting a problem

Do not open a public issue for anything that could put funds at risk. Use GitHub's private vulnerability reporting on [the repository](https://github.com/drydocs/xebra/security), as described in its SECURITY.md.
`,
  };
}

function faqDoc(faq: Faq[]): Doc {
  return {
    path: "/faq",
    markdownPath: md("/faq"),
    title: "Questions about bridging USDC",
    description:
      "Answers about Xebra: native or wrapped USDC, fees, timing, stuck transfers, custody, wallets, limits and audits.",
    section: "docs",
    breadcrumb: crumbs("Questions", "/faq"),
    faq,
    markdown: `# Questions about bridging USDC with Xebra

${faq.map((f) => `## ${f.q}\n\n${f.a}`).join("\n\n")}
`,
  };
}

function claimDoc(): Doc {
  return {
    path: "/claim",
    markdownPath: md("/claim"),
    title: "Claim a stuck USDC transfer",
    description:
      "Finish a stuck CCTP transfer yourself: paste the burn's transaction hash and submit the mint on the destination from your own wallet.",
    section: "docs",
    breadcrumb: crumbs("Claim", "/claim"),
    markdown: `# Claim a stuck USDC transfer

Use this page when a transfer was burned but did not arrive. Circle's attestation for a burn is public and names no particular party to complete it, so anyone holding it can submit the mint, including you.

## How

1. Open [claim](${"/claim"}) and choose the chain the burn was made on.
2. Paste the burn's transaction hash. The page asks Circle for the attestation.
3. Connect a wallet on the destination chain (Phantom for Solana, any EVM wallet otherwise) and submit the mint. You pay that chain's gas.

If the recipient on Solana has no USDC account yet, the page opens it first, as a separate transaction.

## What it costs

On an EVM chain, that chain's gas. On Solana, the transaction fee plus about 0.0007 SOL of permanent rent, and about 0.0015 SOL more if a USDC account has to be opened.

## When it says "already minted"

Circle's Forwarding Service got there first: the transfer was delivered and there is nothing to claim.
`,
  };
}

function routeDoc(r: RouteInfo, all: RouteInfo[]): Doc {
  const from = ENDPOINT_NAMES[r.from];
  const to = ENDPOINT_NAMES[r.to];
  const toEvm = r.to !== "solana" && r.to !== "stellar";
  const fromStellar = r.from === "stellar";
  const viaXebra = r.via !== "circle";
  const title = `Bridge USDC from ${from} to ${to}`;
  const feeRow = viaXebra
    ? `${xebraFeeRule}, with Circle's delivery fee paid out of it`
    : "None: you pay Circle's delivery fee only";
  const recipient = toEvm
    ? `any ${to} address (0x…)`
    : `any Solana wallet address; the bridge finds its USDC account${r.deliveryCapNewAccountUnits !== null ? ", and Circle opens one if it is missing" : ""}`;
  const wallet = fromStellar
    ? "Freighter or the LOBSTR extension"
    : "any browser EVM wallet (MetaMask, Rabby and others)";
  const limits = viaXebra
    ? `${FEES.minTransferUsdc} to ${FEES.maxTransferUsdc} USDC per transfer`
    : "No Xebra limit; Circle's fee may be at most a tenth of the amount";
  const evmSource = r.from !== "stellar" ? EVM_CHAINS[r.from as EvmChainId] : null;
  const siblings = all.filter((o) => o.from === r.from && o.slug !== r.slug);
  return {
    path: `/bridge/${r.slug}`,
    markdownPath: md(`/bridge/${r.slug}`),
    title,
    description: `Send native USDC from ${from} to ${to} over Circle's CCTP. ${viaXebra ? `Fee ${FEES.bps / 100}%, at least ${FEES.minFeeUsdc} USDC` : "No Xebra fee"}, usually minutes, and claimable if delivery fails.`,
    section: "routes",
    breadcrumb: [
      { name: "Xebra", path: "/" },
      { name: "Routes", path: "/routes" },
      { name: `${from} to ${to}`, path: `/bridge/${r.slug}` },
    ],
    route: r,
    markdown: `# ${title}

Send USDC from ${from} to ${to} with Xebra. Circle burns it on ${from} and mints the same amount of native USDC on ${to}: no wrapped token, no pool, and nobody holds it in between.

## At a glance

| | |
|---|---|
| You send | USDC on ${from}, from ${wallet} |
| You receive | Native USDC on ${to}, at ${recipient} |
| Xebra fee | ${feeRow} |
| Circle's delivery fee | Quoted live before you sign; Xebra refuses more than ${usdc(r.deliveryCapUnits)} USDC${r.deliveryCapNewAccountUnits !== null ? ` (${usdc(r.deliveryCapNewAccountUnits)} when Circle opens the account)` : ""} |
| Amount | ${limits} |
| Speed | Usually a few minutes${evmSource?.fast ? "; Fast transfers are offered for a small extra fee" : ""} |
| If it gets stuck | Claim it yourself at [claim](/claim) |

## How to send

1. Open [the bridge](/?from=${r.from}&to=${r.to}) with ${from} and ${to} selected.
2. Connect ${wallet}${r.from === "arc" ? "; keep a few cents of USDC for Arc's gas" : ""}.
3. Enter the amount and the ${to} address. The bridge shows the fee and exactly what will arrive.
4. ${fromStellar ? "Sign once." : "Approve the amount, then confirm the transfer."}
5. Watch it arrive; the bridge follows Circle's attestation and delivery.

## If it does not arrive

The transfer is not lost. Once Circle has attested the burn, anyone can mint it on ${to}: open [claim](/claim), paste the transaction hash, and submit the mint from your own wallet, paying ${to}'s gas.

${siblings.length ? `## Other routes from ${from}\n\n${siblings.map((o) => `- [${from} to ${ENDPOINT_NAMES[o.to]}](/bridge/${o.slug})`).join("\n")}\n` : ""}`,
  };
}

function crumbs(name: string, path: string) {
  return [
    { name: "Xebra", path: "/" },
    { name, path },
  ];
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Every document, for the routes on offer. Pure: `live.ts` supplies the routes and flags from the
 * build and the contract; tests supply their own.
 */
export function buildDocs(routes: RouteInfo[], arcViaWrapper: boolean): Doc[] {
  return [
    overview(routes, arcViaWrapper),
    howItWorks(),
    fees(routes, arcViaWrapper),
    routesIndex(routes),
    security(arcViaWrapper),
    faqDoc(faqFor(arcViaWrapper)),
    claimDoc(),
    ...routes.map((r) => routeDoc(r, routes)),
  ];
}
