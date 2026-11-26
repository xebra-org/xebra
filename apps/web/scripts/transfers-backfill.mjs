#!/usr/bin/env node
/**
 * One-time backfill of Xebra's transfer record: what the hourly job (`transfers-record.mjs`)
 * cannot reach because Stellar's RPC keeps only seven days of events. Writes
 * `scripts/data/transfers-backfill.json`, which the hourly job merges into the public record.
 *
 * Two sources, both read from public endpoints and both checkable by anyone:
 *
 *   1. Every transfer through Xebra's Stellar contracts (v1 and v2) sent by a Stellar account in
 *      Xebra's circle: Xebra's own accounts, every account that has sent through the contracts in
 *      the live record, and every account those created (`create_account`), to `DEPTH` steps.
 *      Horizon lists each account's operations; the archive RPC reads each transaction's
 *      `bridge_initiated` event, so each row is the contract's own record. A transfer sent from an
 *      account outside that circle before the live record began is not found here; the record
 *      compares its count with the contracts' own `get_seq` and says how many are missing.
 *   2. `LISTED`: transfers from before Xebra had a contract, a fee or a relayer on that route,
 *      given by their burn and checked against Circle's record (`listedTransfer`): Circle must have
 *      the burn, have signed it, and name the mint. Nothing unchecked is written.
 *
 * Transfers into Stellar that Xebra's relayer signed are read by the hourly job itself, from the
 * relayer's whole history, so they are not repeated here.
 *
 *   node scripts/transfers-backfill.mjs [--record <transfers.json>]
 *
 * `--record` adds the senders already in a record file (the live `transfers.json`) as seeds.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { STELLAR_RELAYERS, listedTransfer, stellarAccountTransfers } from "./lib/chain-readers.mjs";

const here = dirname(new URL(import.meta.url).pathname);
const OUT = resolve(here, "data/transfers-backfill.json");

/** Xebra's public Stellar accounts (docs/concepts/security.mdx, deployments/mainnet.json) and team wallets. */
const SEEDS = [
  "GBTVJ6JACFRBNI6BETAY4CWYWYNJHX43TGNEAVC3YQCSPPPY4R7H5TBN", // admin
  "GBZWUXOTGHAAWMFNG262QPRIJJ77XI44VHZ4GAO4XYGPL43TDKAQVF42", // pauser
  "GCTKQAVT2YZBOJTZI2BZQG3O7NCZLS5D5UBCV7NHTR4Y2XG5OBC3BDQ5", // fee recipient
  ...STELLAR_RELAYERS, // relayer, deployer
  "GBFI4X5ERTTOBZ22N54INR5ELPRLSIDGN7ZIXHZDH5CBIMDYFVSQSJHM", // sender of the transfers in the docs
];
const DEPTH = 4;

/**
 * Burns from before the route had a Xebra contract, fee or relayer. Each is in
 * apps/docs/content/docs/concepts/mainnet-transfers.mdx or was sent from the same Sui wallet in the
 * Sui pilot (6 to 8 Nov 2026), and each is checked against Circle before it is written.
 */
const LISTED = [
  {
    chain: "stellar",
    tx: "92421fa248da1b1d4418784d5bd91adc4238dae72120e8f740920db7381905a7",
    // Circle's record of this early burn does not name the mint; the docs do.
    mint: "58dVHAebBDVHWpjRYeGn52YJB8MFsLkgJHefcNgMBgkpYN7LxzdpGNE1tnGcPzGmwFLbDTqg7C7kHzCh4Ja6HZs5",
    note: "The first Xebra transfer, sent before Xebra's Stellar contract existed.",
  },
  { chain: "sui", tx: "9hjSiHimU8nfpeWwFHau61czUBhVRqr7goiPxhvVUbR1", note: "Sui pilot." },
  { chain: "sui", tx: "6LxiBGvU5tEiFam7f76uTzbpjwoL5muQfYT9q6LcLA1b", note: "Sui pilot." },
  { chain: "sui", tx: "8JD7n6LKB7XXypLexF4kysjYEtKsjPPijPzPjqBtJMwd", note: "Sui pilot." },
  { chain: "sui", tx: "EUyJJwVBkEdbwHFCnYYseheYkcSn5byML7jkiekM5uDg", note: "Sui pilot." },
  {
    chain: "sui",
    tx: "F7qiEMaT7q7pbfQ2H44SeV4URQQVfNpffmpt3J5yH8pD",
    note: "The first Sui to Monad transfer, delivered by Circle.",
  },
];

const argRecord = process.argv.indexOf("--record");
const seeds = new Set(SEEDS);
if (argRecord !== -1) {
  const record = JSON.parse(readFileSync(resolve(process.argv[argRecord + 1]), "utf8"));
  for (const t of record.transfers ?? []) {
    if (t.source === "stellar" && /^G[A-Z2-7]{55}$/.test(t.sender ?? "")) seeds.add(t.sender);
  }
}

const rows = new Map();
const scanned = [];
let frontier = [...seeds];
const seen = new Set(frontier);
for (let depth = 0; depth <= DEPTH && frontier.length; depth++) {
  const next = [];
  for (const account of frontier) {
    const { found, created } = await stellarAccountTransfers(account);
    for (const r of found) rows.set(r.id, r);
    scanned.push(account);
    console.log(`depth ${depth} ${account}: ${found.length} transfer(s)`);
    if (depth < DEPTH) {
      for (const a of created) {
        if (!seen.has(a)) {
          seen.add(a);
          next.push(a);
        }
      }
    }
  }
  frontier = next;
}

for (const item of LISTED) {
  const row = await listedTransfer(item);
  rows.set(row.id, row);
  console.log(`listed ${item.chain} ${item.tx}: ${row.amount} USDC to ${row.domain}`);
}

const transfers = [...rows.values()].sort((a, b) => a.at.localeCompare(b.at));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      about:
        "Xebra transfers older than the hourly record can read, each read from the chains by apps/web/scripts/transfers-backfill.mjs. Merged into transfers.json by transfers-record.mjs.",
      generatedAt: new Date().toISOString(),
      stellarAccountsScanned: scanned.length,
      transfers,
    },
    null,
    2,
  )}\n`,
);
console.log(`${transfers.length} transfer(s) from ${scanned.length} account(s). Wrote ${OUT}`);
