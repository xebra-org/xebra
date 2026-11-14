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
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { dirname, resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { decodeEventLog, parseAbiItem, toEventSelector } from "viem";

// Node gives each address 250 ms before trying the next; on a slow link that fails hosts that work.
setDefaultAutoSelectFamilyAttemptTimeout(2_000);

const here = dirname(new URL(import.meta.url).pathname);
const argOut = process.argv.indexOf("--out");
const OUT = resolve(
  argOut > -1
    ? process.argv[argOut + 1]
    : resolve(here, "../../../evidence/near-intents/transfers.json"),
);

const ONECLICK = "https://1click.chaindefuser.com";
const ARC_RPC = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";
const STELLAR_RPC = process.env.SOROBAN_RPC_URL || "https://mainnet.sorobanrpc.com";

const ARC_WRAPPER = "0x11b30470DAE40B2Fc27b7AA90dc58e6B4fE9f4c3";
/** The Arc wrapper's first `BridgeInitiated` (seq 1) is in block 31094669; nothing comes earlier. */
const ARC_FIRST_BLOCK = 31_094_000n;
const ARC_LOG_SPAN = 5_000n; // the public RPC refuses wider eth_getLogs ranges
const STELLAR_WRAPPER = "CCPVTWII2TW6VVSVA4JQ2KFHICGBG4QVAHPIGUPSIW3E4VNPUI4Y2WQR";

/** CCTP domains of the chains `@xebra/sdk/intents` uses as hubs (DEFAULT_HUBS). */
const HUBS = { 6: "base", 3: "arbitrum", 5: "solana" };
/** 1Click statuses that will not change again. */
const FINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

const ARC_EVENT = parseAbiItem(
  "event BridgeInitiated(bytes32 indexed transferId, uint64 indexed seq, address indexed user, uint32 destinationDomain, bytes32 mintRecipient, uint256 amount, uint256 fee, uint256 netBurned, uint256 forwardFee, uint256 wrapperTake, uint32 minFinalityThreshold, bytes32 recipientOwner)",
);

const usdc = (units, decimals = 6) => Number(units) / 10 ** decimals;
const hex = (b) => `0x${Buffer.from(b).toString("hex")}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch, trying again (up to six times, backing off) when the network fails or the endpoint
 * rate-limits. Returns the response for anything else, errors included.
 */
async function request(url, init = {}) {
  for (let attempt = 0; ; attempt++) {
    let res = null;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      if (attempt >= 6) throw e;
    }
    if (res && res.status !== 429) return res;
    if (res && attempt >= 6) return res;
    await sleep(1000 * 2 ** attempt);
  }
}

async function rpc(url, method, params) {
  for (let attempt = 0; ; attempt++) {
    const res = await request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await res.json();
    if (!body.error) return body.result;
    // Arc's public RPC says "rate limit exceeded" in a 200.
    if (/rate limit/i.test(body.error.message) && attempt < 6) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`${method}: ${body.error.message}`);
  }
}

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

// --- reading the wrappers ---------------------------------------------------------------------

async function arcTransfers(fromBlock) {
  const topic = toEventSelector(ARC_EVENT);
  const latest = BigInt(await rpc(ARC_RPC, "eth_blockNumber", []));
  const found = [];
  for (let a = fromBlock; a <= latest; a += ARC_LOG_SPAN) {
    await sleep(250);
    const b = a + ARC_LOG_SPAN - 1n < latest ? a + ARC_LOG_SPAN - 1n : latest;
    const logs = await rpc(ARC_RPC, "eth_getLogs", [
      {
        address: ARC_WRAPPER,
        topics: [topic],
        fromBlock: `0x${a.toString(16)}`,
        toBlock: `0x${b.toString(16)}`,
      },
    ]);
    for (const log of logs) {
      const { args } = decodeEventLog({ abi: [ARC_EVENT], data: log.data, topics: log.topics });
      const block = await rpc(ARC_RPC, "eth_getBlockByNumber", [log.blockNumber, false]);
      found.push({
        id: `arc:${args.transferId}`,
        source: "arc",
        sourceTx: log.transactionHash,
        sourceTxUrl: `https://explorer.arc.io/tx/${log.transactionHash}`,
        at: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(),
        sender: args.user,
        domain: Number(args.destinationDomain),
        mintRecipient: args.mintRecipient,
        recipientOwner: args.recipientOwner,
        amount: usdc(args.amount),
        xebraFee: usdc(args.wrapperTake),
        circleFee: usdc(args.forwardFee),
      });
    }
  }
  return { found, cursor: latest + 1n };
}

async function stellarTransfers(cursorLedger) {
  const health = await rpc(STELLAR_RPC, "getHealth");
  let gap = null;
  let start = cursorLedger ?? health.oldestLedger;
  if (start < health.oldestLedger) {
    gap = { from: start, to: health.oldestLedger - 1 };
    start = health.oldestLedger;
  }
  const topic = xdr.ScVal.scvSymbol("bridge_initiated").toXDR("base64");
  const found = [];
  let page = { startLedger: start };
  for (;;) {
    const res = await rpc(STELLAR_RPC, "getEvents", {
      ...page,
      filters: [{ type: "contract", contractIds: [STELLAR_WRAPPER], topics: [[topic, "**"]] }],
      pagination: { limit: 200, ...(page.cursor ? { cursor: page.cursor } : {}) },
    });
    for (const e of res.events) {
      const v = scValToNative(xdr.ScVal.fromXDR(e.value, "base64"));
      found.push({
        id: `stellar:${hex(v.transfer_id)}`,
        source: "stellar",
        sourceTx: e.txHash,
        sourceTxUrl: `https://stellar.expert/explorer/public/tx/${e.txHash}`,
        at: e.ledgerClosedAt,
        sender: v.user,
        domain: Number(v.destination_domain),
        mintRecipient: hex(v.mint_recipient),
        recipientOwner: v.recipient_owner ? hex(v.recipient_owner) : null,
        amount: usdc(v.amount, 7),
        xebraFee: usdc(v.wrapper_take ?? 0, 7),
        circleFee: usdc(v.forward_fee ?? 0, 7),
      });
    }
    // The RPC scans a limited stretch of ledgers per call and hands back a cursor where it
    // stopped, events or not, so follow it to the latest ledger rather than stopping on a short page.
    const at = res.cursor ? Number(BigInt(res.cursor.split("-")[0]) >> 32n) : res.latestLedger;
    if (at >= res.latestLedger) break;
    page = { cursor: res.cursor };
  }
  return { found, cursor: health.latestLedger + 1, gap };
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
