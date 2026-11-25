#!/usr/bin/env node
/**
 * How much USDC Xebra has carried into NEAR Intents, counted from the chain.
 *
 * A transfer into NEAR Intents through Xebra is an ordinary Xebra transfer whose mint recipient is
 * a 1Click deposit address on a hub chain (Base, Arbitrum or Solana). So:
 *
 *   1. Read every `BridgeInitiated` event from Xebra's wrappers (Arc, Stellar) that mints on a hub.
 *   2. Ask 1Click about the mint recipient: `GET /v0/status?depositAddress=...`. A deposit address
 *      it issued answers with the swap's status, amounts and NEAR transactions; any other address
 *      answers 404, and that transfer was an ordinary one.
 *
 * Because it starts from Xebra's own contract events, it counts every transfer into NEAR Intents
 * made through Xebra's contracts, whether from xebra.exchange, the API or the SDK. Transfers from
 * EVM chains without a wrapper go straight to Circle's contracts and are not visible here; those
 * started on xebra.exchange carry the `xebra` referral in 1Click instead.
 *
 * Read-only, no keys. The results are kept in a JSON file and each run only reads what is new.
 * Stellar RPC keeps about seven days of events, so run this at least weekly or Stellar transfers
 * older than that are missed (the run says so when it happens).
 *
 *   node scripts/near-intents-volume.mjs [--out <file>]
 *
 * Default file: ../../evidence/near-intents/transfers.json (from apps/web).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { ARC_FIRST_BLOCK, arcTransfers, request, stellarTransfers } from "./lib/chain-readers.mjs";

const here = dirname(new URL(import.meta.url).pathname);
const argOut = process.argv.indexOf("--out");
const OUT = resolve(
  argOut > -1
    ? process.argv[argOut + 1]
    : resolve(here, "../../../evidence/near-intents/transfers.json"),
);

const ONECLICK = "https://1click.chaindefuser.com";

/** CCTP domains of the chains `@xebra/sdk/intents` uses as hubs (DEFAULT_HUBS). */
const HUBS = { 6: "base", 3: "arbitrum", 5: "solana" };
/** 1Click statuses that will not change again. */
const FINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

/** The deposit address 1Click would have issued for a mint recipient on a hub. */
function depositAddressFor(domain, mintRecipient, recipientOwner) {
  if (HUBS[domain] === "solana") {
    // The deposit address is a Solana wallet; CCTP may name it or its USDC token account, so try
    // the owner first when the event carries one.
    const zero = /^0x0+$/.test(recipientOwner ?? "0x0");
    return [
      ...(zero ? [] : [new PublicKey(Buffer.from(recipientOwner.slice(2), "hex")).toBase58()]),
      new PublicKey(Buffer.from(mintRecipient.slice(2), "hex")).toBase58(),
    ];
  }
  return [`0x${mintRecipient.slice(-40)}`]; // EVM: the last 20 bytes
}

async function oneclickStatus(address) {
  const res = await request(`${ONECLICK}/v0/status?depositAddress=${address}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`1Click status ${res.status} for ${address}`);
  return res.json();
}

// --- the run ----------------------------------------------------------------------------------

function load() {
  try {
    return JSON.parse(readFileSync(OUT, "utf8"));
  } catch {
    return { cursors: {}, notIntents: [], transfers: [] };
  }
}

const state = load();
const known = new Map(state.transfers.map((t) => [t.id, t]));
const notIntents = new Set(state.notIntents);

const arc = await arcTransfers(state.cursors.arc ? BigInt(state.cursors.arc) : ARC_FIRST_BLOCK);
const stellar = await stellarTransfers(state.cursors.stellar);
if (stellar.gap) {
  console.warn(
    `Stellar ledgers ${stellar.gap.from} to ${stellar.gap.to} are older than the RPC keeps; transfers in them were not read.`,
  );
  state.gaps = [...(state.gaps ?? []), { chain: "stellar", ...stellar.gap }];
}

const candidates = [...arc.found, ...stellar.found].filter(
  (t) => t.domain in HUBS && !known.has(t.id) && !notIntents.has(t.id),
);
// Re-check the ones 1Click had not finished last time.
const recheck = state.transfers.filter((t) => !FINAL.has(t.intents.status));

for (const t of [...candidates, ...recheck]) {
  let status = null;
  let depositAddress = t.depositAddress;
  for (const addr of depositAddress
    ? [depositAddress]
    : depositAddressFor(t.domain, t.mintRecipient, t.recipientOwner)) {
    status = await oneclickStatus(addr);
    if (status) {
      depositAddress = addr;
      break;
    }
  }
  if (!status) {
    notIntents.add(t.id);
    continue;
  }
  const d = status.swapDetails ?? {};
  const asked = status.quoteResponse?.quoteRequest ?? {};
  known.set(t.id, {
    ...t,
    hub: HUBS[t.domain],
    depositAddress,
    intents: {
      status: status.status,
      updatedAt: status.updatedAt,
      depositedUsdc: d.depositedAmountFormatted ? Number(d.depositedAmountFormatted) : null,
      depositedUsd: d.depositedAmountUsd ? Number(d.depositedAmountUsd) : null,
      amountOut: d.amountOutFormatted ?? null,
      amountOutUsd: d.amountOutUsd ? Number(d.amountOutUsd) : null,
      destinationAsset: asked.destinationAsset ?? null,
      recipient: asked.recipient ?? null,
      referral: asked.referral ?? null,
      nearTxs: d.nearTxHashes ?? [],
      destinationTxs: (d.destinationChainTxHashes ?? []).map((x) => x.explorerUrl || x.hash),
    },
  });
}

const transfers = [...known.values()].sort((a, b) => a.at.localeCompare(b.at));
const done = transfers.filter((t) => t.intents.status === "SUCCESS");
const sum = (xs, f) => Math.round(xs.reduce((s, x) => s + (f(x) ?? 0), 0) * 1e6) / 1e6;
const bySource = {};
for (const t of done) {
  bySource[t.source] ??= { transfers: 0, usdcSent: 0 };
  bySource[t.source].transfers += 1;
  bySource[t.source].usdcSent = Math.round((bySource[t.source].usdcSent + t.amount) * 1e6) / 1e6;
}

const out = {
  about:
    "Transfers into NEAR Intents made through Xebra's wrapper contracts, found from their BridgeInitiated events and confirmed against 1Click's status API. Written by apps/web/scripts/near-intents-volume.mjs.",
  updatedAt: new Date().toISOString(),
  totals: {
    transfers: transfers.length,
    delivered: done.length,
    usdcSent: sum(done, (t) => t.amount),
    usdDeliveredOnNear: sum(done, (t) => t.intents.amountOutUsd),
    bySource,
  },
  cursors: { arc: arc.cursor.toString(), stellar: stellar.cursor },
  ...(state.gaps ? { gaps: state.gaps } : {}),
  transfers,
  notIntents: [...notIntents].sort(),
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);

console.log(
  `${transfers.length} transfer(s) into NEAR Intents through Xebra, ${done.length} delivered: ${out.totals.usdcSent} USDC sent, ${out.totals.usdDeliveredOnNear} USD delivered on NEAR.`,
);
for (const t of transfers) {
  console.log(
    `  ${t.at}  ${t.source.padEnd(7)} ${String(t.amount).padStart(10)} USDC -> ${t.hub} -> ${t.intents.status} ${t.intents.amountOut ?? ""} ${t.intents.recipient ?? ""}`,
  );
}
console.log(`Checked ${candidates.length} new hub-bound transfer(s); wrote ${OUT}`);
