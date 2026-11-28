#!/usr/bin/env node
/**
 * The public record of Xebra's transfers, read from the chains and kept in one JSON file.
 *
 *   - Stellar and Arc: every `BridgeInitiated` event from Xebra's contracts (both Stellar ones).
 *   - Into Stellar: every mint Xebra's relayer accounts signed (Sui, Solana, Aptos to Stellar).
 *   - Solana and Sui: every payment into Xebra's fee address made in the same transaction as
 *     Circle's burn (the transaction also carries the `xebra` memo on Solana).
 *   - Aptos and EVM chains: every USDC payment into Xebra's fee address, marked `tagged` on EVM when
 *     the transaction carries Xebra's ERC-8021 code.
 *   - `data/transfers-backfill.json`: older transfers the RPCs above no longer serve, written once
 *     by `transfers-backfill.mjs`, each read from the chains and linked the same way.
 *
 * Each row links to the transaction on an explorer, so anyone can check it. Each run reads only
 * what is new since the cursors in the file; a source that fails keeps its cursor and is read again
 * next time, so nothing is skipped. Stellar RPC keeps about seven days of events: run this at least
 * daily (a GitHub Action runs it three times an hour). Read-only, no keys.
 *
 * Fee addresses come from the same variables the site uses (NEXT_PUBLIC_XEBRA_FEE_ADDRESS_EVM,
 * _SOLANA, _SUI, _APTOS). When one is unset this falls back to the address the live site uses,
 * and says so loudly: a family is never skipped in silence.
 *
 *   node scripts/transfers-record.mjs --out <file>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EVM_CHAINS, isXebraTagged } from "@xebra/sdk/core";
import {
  ARC_FIRST_BLOCK,
  DOMAINS,
  aptosFeeTransfers,
  arcTransfers,
  contractCounts,
  evmFeeTransfers,
  solanaFeeTransfers,
  stellarRelayedTransfers,
  stellarTransfers,
  suiFeeTransfers,
} from "./lib/chain-readers.mjs";
import { mergeRows, totalsOf } from "./lib/record-merge.mjs";

const argOut = process.argv.indexOf("--out");
if (argOut === -1) {
  console.error("usage: node scripts/transfers-record.mjs --out <file>");
  process.exit(2);
}
const OUT = resolve(process.argv[argOut + 1]);
const BACKFILL = resolve(
  dirname(new URL(import.meta.url).pathname),
  "data/transfers-backfill.json",
);

/** A warning GitHub shows on the run's page, not only in its log. */
function warn(message) {
  if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Transfers record::${message}`);
  else console.warn(`WARNING: ${message}`);
}

/**
 * The fee addresses the live site uses (xebra.exchange, 26 Nov 2026). They are public by nature:
 * every fee transaction pays them, and the site ships them in its own scripts. EVM also keeps the
 * Arc contract's fee recipient, the site's default before its own variable was set.
 */
const LIVE_FEE_ADDRESSES = {
  evm: ["0x56E819D6F22B92abBEECfc3154E1E389330e17dd", "0x32e95718A4D9B60F2e4Fb1d371189ac5DD28211A"],
  solana: ["GERu2Lf3cHzxRx9Ue9pJyNE6WnosLrnyUR2zxQTwQhDg"],
  sui: ["0xad3cc362509703798caa24023957f3c381a73dfc6e9e963349d9114d79988508"],
  aptos: ["0x58c5010020298b5bd03c8184c6b92a0020fead9907aeedbc5919830f80b9617f"],
};

function feeAddresses(family) {
  const name = `NEXT_PUBLIC_XEBRA_FEE_ADDRESS_${family.toUpperCase()}`;
  const set = process.env[name]?.trim();
  if (!set) {
    warn(
      `${name} is not set; reading ${family} fees at the live site's address instead. Set the repository variable XEBRA_FEE_ADDRESS_${family.toUpperCase()}.`,
    );
    return LIVE_FEE_ADDRESSES[family];
  }
  // A changed address must not hide the fees paid to the old one.
  const all = [set, ...LIVE_FEE_ADDRESSES[family]];
  return all.filter((a, i) => all.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i);
}
const FEE = {
  evm: feeAddresses("evm"),
  solana: feeAddresses("solana"),
  sui: feeAddresses("sui"),
  aptos: feeAddresses("aptos"),
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
const errors = [];

/**
 * Runs one source within a time budget, so one slow public node cannot hold up the rest. On failure
 * or timeout the source keeps its old cursor and the next run reads the same stretch again.
 * A cursor that is not a string (the relayer's, one per account) is kept as JSON.
 */
async function source(name, read, budgetMs = 120_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${budgetMs / 1000} s`)), budgetMs);
  });
  try {
    const { found, cursor, gap } = await Promise.race([read(cursors[name]), timeout]);
    for (const t of found) known.set(t.id, t);
    if (gap) {
      gaps.push({ source: name, ...gap });
      warn(`${name}: ledgers ${gap.from} to ${gap.to} are older than the RPC keeps.`);
    }
    if (cursor !== undefined && cursor !== null) {
      cursors[name] = typeof cursor === "object" ? JSON.stringify(cursor) : String(cursor);
    }
    console.log(`${name}: ${found.length} new`);
  } catch (e) {
    errors.push({ source: name, at: new Date().toISOString(), message: String(e.message ?? e) });
    warn(`${name}: not read this run (${e.message ?? e})`);
  } finally {
    clearTimeout(timer);
  }
}

// Arc's first run reads the contract's whole history in 5,000-block steps: give it time.
await source("arc", (c) => arcTransfers(c ? BigInt(c) : ARC_FIRST_BLOCK), 30 * 60_000);
await source("stellar", (c) => stellarTransfers(c ? Number(c) : undefined), 10 * 60_000);
// The first run reads each relayer account's whole history from Horizon.
await source(
  "stellar-relayed",
  (c) => stellarRelayedTransfers(c ? JSON.parse(c) : {}),
  10 * 60_000,
);
for (const fee of FEE.solana) {
  await source(`solana:${fee}`, (c) => solanaFeeTransfers(fee, c ?? cursors.solana));
}
for (const fee of FEE.sui) {
  await source(`sui:${fee}`, (c) => suiFeeTransfers(fee, c ?? cursors.sui));
}
for (const fee of FEE.aptos) await source(`aptos:${fee}`, (c) => aptosFeeTransfers(fee, c));
// Arc's transfers go through the contract; its fee address only sees a fee when the contract is
// switched off for the site, so it is read like any other chain. Each chain has its own node, so
// they are read side by side.
await Promise.all(
  Object.values(EVM_CHAINS).map((chain) =>
    source(`evm:${chain.id}`, (c) =>
      evmFeeTransfers(chain, FEE.evm, c ? BigInt(c) : undefined, isXebraTagged),
    ),
  ),
);
// Cursors from before a family could have several addresses; their new names replace them.
for (const old of ["solana", "sui"]) {
  if (Object.keys(cursors).some((k) => k.startsWith(`${old}:`))) delete cursors[old];
}

let backfill = [];
try {
  backfill = JSON.parse(readFileSync(BACKFILL, "utf8")).transfers ?? [];
} catch (e) {
  warn(`the backfill file could not be read (${e.message}); older transfers are missing.`);
}

// Live rows first: a backfill row never replaces one already read live with the same proof.
const transfers = mergeRows([...known.values(), ...backfill], DOMAINS);
const totals = totalsOf(transfers);

/**
 * Each chain's contract count (Stellar's two contracts added up) beside the contract rows found:
 * the record says how many it is missing rather than look complete when it is not.
 */
let contracts = state.contracts ?? {};
try {
  const counts = await contractCounts();
  contracts = {};
  for (const [key, n] of Object.entries(counts)) {
    const chain = key.split(":")[0];
    contracts[chain] ??= { counted: 0, listed: 0 };
    contracts[chain].counted += n;
  }
  for (const [chain, c] of Object.entries(contracts)) {
    c.listed = transfers.filter((t) => t.proof === "contract" && t.source === chain).length;
    if (c.listed < c.counted) {
      warn(`${chain}: the contracts counted ${c.counted} transfers; the record lists ${c.listed}.`);
    }
  }
} catch (e) {
  warn(`the contracts' own counts could not be read (${e.message}).`);
}

const out = {
  about:
    "Every Xebra transfer found on chain: Stellar and Arc from Xebra's contract events; transfers into Stellar from the mints Xebra's relayer signed; Solana and Sui from Xebra's fee paid in the burn's own transaction; Aptos and other EVM chains from payments into Xebra's fee address (tagged with Xebra's ERC-8021 code on EVM); and early transfers from before those existed, checked against Circle's record. Each row links to its transaction. Written by apps/web/scripts/transfers-record.mjs.",
  updatedAt: new Date().toISOString(),
  totals,
  contracts,
  cursors,
  ...(gaps.length ? { gaps } : {}),
  ...(errors.length ? { lastRunErrors: errors } : {}),
  transfers,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(
  `${totals.transfers} transfer(s), ${totals.usdcSent} USDC, ${totals.chains} chains, ${totals.routes} routes, ${totals.xebraFees} USDC in fees; ${errors.length} source(s) not read. Wrote ${OUT}`,
);
// A source that timed out may still have requests in flight; the record is written, so stop.
process.exit(0);
