#!/usr/bin/env node
/**
 * The public record of Xebra's transfers, read from the chains and kept in one JSON file.
 *
 *   - Stellar and Arc: every `BridgeInitiated` event from Xebra's contracts.
 *   - Solana and Sui: every payment into Xebra's fee address made in the same transaction as
 *     Circle's burn (the transaction also carries the `xebra` memo on Solana).
 *   - Other EVM chains: every USDC payment into Xebra's fee address, marked `tagged` when the
 *     transaction carries Xebra's ERC-8021 code.
 *
 * Each row links to the transaction on an explorer, so anyone can check it. Each run reads only
 * what is new since the cursors in the file; a source that fails keeps its cursor and is read again
 * next time, so nothing is skipped. Stellar RPC keeps about seven days of events: run this at least
 * daily (a GitHub Action runs it hourly). Read-only, no keys.
 *
 * Fee addresses come from the same variables the site uses: NEXT_PUBLIC_XEBRA_FEE_ADDRESS_EVM,
 * _SOLANA and _SUI. A family without one is skipped.
 *
 *   node scripts/transfers-record.mjs --out <file>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EVM_CHAINS, isXebraTagged } from "@xebra/sdk/core";
import {
  ARC_FIRST_BLOCK,
  arcTransfers,
  evmFeeTransfers,
  solanaFeeTransfers,
  stellarTransfers,
  suiFeeTransfers,
} from "./lib/chain-readers.mjs";

const argOut = process.argv.indexOf("--out");
if (argOut === -1) {
  console.error("usage: node scripts/transfers-record.mjs --out <file>");
  process.exit(2);
}
const OUT = resolve(process.argv[argOut + 1]);

const FEE = {
  evm: process.env.NEXT_PUBLIC_XEBRA_FEE_ADDRESS_EVM || "",
  solana: process.env.NEXT_PUBLIC_XEBRA_FEE_ADDRESS_SOLANA || "",
  sui: process.env.NEXT_PUBLIC_XEBRA_FEE_ADDRESS_SUI || "",
};

/** CCTP domain to a name, for the page. */
const DOMAINS = {
  ...Object.fromEntries(Object.values(EVM_CHAINS).map((c) => [c.cctpDomainId, c.id])),
  5: "solana",
  8: "sui",
  9: "aptos",
  27: "stellar",
};

function load() {
  try {
    return JSON.parse(readFileSync(OUT, "utf8"));
  } catch {
    return { cursors: {}, transfers: [] };
  }
}

const state = load();
const cursors = { ...state.cursors };
const known = new Map(state.transfers.map((t) => [t.id, t]));
const gaps = [...(state.gaps ?? [])];
/** Where a source's record begins, when it does not reach back to the source's first transfer. */
const coverage = { ...(state.coverage ?? {}) };
const errors = [];

/**
 * Runs one source within a time budget, so one slow public node cannot hold up the rest. On failure
 * or timeout the source keeps its old cursor and the next run reads the same stretch again.
 */
async function source(name, read, budgetMs = 120_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${budgetMs / 1000} s`)), budgetMs);
  });
  try {
    const { found, cursor, gap, startedAt } = await Promise.race([read(cursors[name]), timeout]);
    if (startedAt && !coverage[name]) coverage[name] = startedAt;
    for (const t of found) {
      const to = t.domain === null || t.domain === undefined ? null : (DOMAINS[t.domain] ?? null);
      known.set(t.id, { ...t, to });
    }
    if (gap) {
      gaps.push({ source: name, ...gap });
      console.warn(`${name}: ledgers ${gap.from} to ${gap.to} are older than the RPC keeps.`);
    }
    if (cursor !== undefined && cursor !== null) cursors[name] = String(cursor);
    console.log(`${name}: ${found.length} new`);
  } catch (e) {
    errors.push({ source: name, at: new Date().toISOString(), message: String(e.message ?? e) });
    console.warn(`${name}: not read this run (${e.message ?? e})`);
  } finally {
    clearTimeout(timer);
  }
}

// Arc's first run reads the contract's whole history in 5,000-block steps: give it time.
await source("arc", (c) => arcTransfers(c ? BigInt(c) : ARC_FIRST_BLOCK), 30 * 60_000);
await source("stellar", (c) => stellarTransfers(c ? Number(c) : undefined), 10 * 60_000);
if (FEE.solana) await source("solana", (c) => solanaFeeTransfers(FEE.solana, c));
if (FEE.sui) await source("sui", (c) => suiFeeTransfers(FEE.sui, c));
if (FEE.evm) {
  // Arc's transfers go through the contract; its fee address only sees a fee when the contract is
  // switched off for the site, so it is read like any other chain.
  // Each chain has its own node, so they are read side by side.
  await Promise.all(
    Object.values(EVM_CHAINS).map((chain) =>
      source(`evm:${chain.id}`, (c) =>
        evmFeeTransfers(chain, FEE.evm, c ? BigInt(c) : undefined, isXebraTagged),
      ),
    ),
  );
}

const transfers = [...known.values()].sort((a, b) => b.at.localeCompare(a.at));
const round = (n) => Math.round(n * 1e6) / 1e6;
const bySource = {};
for (const t of transfers) {
  bySource[t.source] ??= { transfers: 0, usdcSent: 0, xebraFees: 0 };
  bySource[t.source].transfers += 1;
  bySource[t.source].usdcSent = round(bySource[t.source].usdcSent + (t.amount ?? 0));
  bySource[t.source].xebraFees = round(bySource[t.source].xebraFees + (t.xebraFee ?? 0));
}

const out = {
  about:
    "Every Xebra transfer found on chain: Stellar and Arc from Xebra's contract events; Solana, Sui and other EVM chains from payments into Xebra's fee address (in the burn's own transaction on Solana and Sui, tagged with Xebra's ERC-8021 code on EVM). Each row links to its transaction. Written by apps/web/scripts/transfers-record.mjs.",
  updatedAt: new Date().toISOString(),
  totals: {
    transfers: transfers.length,
    usdcSent: round(transfers.reduce((s, t) => s + (t.amount ?? 0), 0)),
    xebraFees: round(transfers.reduce((s, t) => s + (t.xebraFee ?? 0), 0)),
    bySource,
  },
  cursors,
  ...(Object.keys(coverage).length ? { coverage } : {}),
  ...(gaps.length ? { gaps } : {}),
  ...(errors.length ? { lastRunErrors: errors } : {}),
  transfers,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(
  `${transfers.length} transfer(s), ${out.totals.usdcSent} USDC, ${out.totals.xebraFees} USDC in fees; ${errors.length} source(s) not read. Wrote ${OUT}`,
);
// A source that timed out may still have requests in flight; the record is written, so stop.
process.exit(0);
