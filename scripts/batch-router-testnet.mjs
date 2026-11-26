#!/usr/bin/env node
// Measures and (optionally) sends a batch through XebraBatchRouter on Stellar TESTNET.
//
//   node scripts/batch-router-testnet.mjs <count> [arc|solana] [amount_usdc] [--send] [--same]
//   node scripts/batch-router-testnet.mjs 5 mix:arc,base,avalanche,optimism,solana [--send]
//
// mix: one transfer per listed chain, each to our own wallet there (one EVM key is the same address on
// every EVM chain; Solana goes to the devnet token account below). BATCH_ENV picks the ids file.
//
// Without --send it only simulates and prints what the transaction would cost against the
// network's per-transaction limits. --same makes every request byte-identical (the "split one big
// transfer" case); otherwise each request goes to a different recipient ("one send to many").
//
// Testnet only, by construction: the network passphrase, RPC and contract ids are fixed below or
// read from .secrets/batch-router-testnet.env (written when the contracts were deployed).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "packages/sdk/package.json"));
const {
  Address,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} = require("@stellar/stellar-sdk");

const RPC_URL = "https://soroban-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const IDENTITY = "xebra-fwdtest";
const env = Object.fromEntries(
  readFileSync(join(ROOT, process.env.BATCH_ENV ?? ".secrets/batch-router-testnet.env"), "utf8")
    .trim()
    .split("\n")
    .map((l) => l.split("=")),
);

const args = process.argv.slice(2);
const count = Number(args[0] ?? 2);
const dest = args.find((a) => a === "arc" || a === "solana") ?? "arc";
const amountUsdc = Number(args.find((a) => /^\d+(\.\d+)?$/.test(a) && a !== args[0]) ?? 1);
const SEND = args.includes("--send");
const SAME = args.includes("--same");
const DOMAINS = {
  ethereum: 0,
  avalanche: 1,
  optimism: 2,
  arbitrum: 3,
  solana: 5,
  base: 6,
  polygon: 7,
  unichain: 10,
  arc: 26,
};
const MIX = (args.find((a) => a.startsWith("mix:")) ?? "").slice(4).split(",").filter(Boolean);
const DOMAIN = DOMAINS[dest];
// Per transfer: [domain, chain name]. A mix ignores <count> and sends one per listed chain.
const plan = MIX.length
  ? MIX.map((c) => [DOMAINS[c], c])
  : Array.from({ length: count }, () => [DOMAIN, dest]);

const secret = execFileSync("stellar", ["keys", "show", IDENTITY]).toString().trim();
const kp = Keypair.fromSecret(secret);
const user = kp.publicKey();

function ownEvm() {
  const own = JSON.parse(readFileSync(join(ROOT, ".secrets/arc-testnet-recipient.json"), "utf8"));
  return Buffer.concat([
    Buffer.alloc(12),
    Buffer.from((Array.isArray(own) ? own[0] : own).address.slice(2), "hex"),
  ]);
}

function recipientBytes(i, chain) {
  if (MIX.length) {
    if (chain !== "solana") return ownEvm();
    return Buffer.from("000b95cfcf91874cf7d5116f5955ba91ba66639628c42a567b1c9f359c073a1b", "hex");
  }
  if (dest === "arc") {
    // i = 0 is our own Arc testnet wallet (so a sent batch is observable); the rest are distinct
    // throwaway addresses (testnet USDC only).
    const own = JSON.parse(readFileSync(join(ROOT, ".secrets/arc-testnet-recipient.json"), "utf8"));
    const ownAddr = (Array.isArray(own) ? own[0] : own).address.slice(2);
    const hex = SAME || i === 0 ? ownAddr : i.toString(16).padStart(2, "0").repeat(20);
    return Buffer.concat([Buffer.alloc(12), Buffer.from(hex, "hex")]);
  }
  // Solana devnet: the faucet-claimant token account proven to accept forwarded mints.
  // 1BFGaohSJcK9rDJubEetAthshXTLfSbMfcZWAtQNGRx, base58-decoded.
  return Buffer.from("000b95cfcf91874cf7d5116f5955ba91ba66639628c42a567b1c9f359c073a1b", "hex");
}

function encodeReq(r) {
  return nativeToScVal(
    {
      user: new Address(r.user),
      amount: r.amount,
      destination_domain: r.destinationDomain,
      mint_recipient: r.mintRecipient,
      max_fee: r.maxFee,
      min_finality_threshold: r.minFinalityThreshold,
      recipient_needs_account: false,
      recipient_owner: Buffer.alloc(32),
      approval_expiration_ledger: r.approvalExpirationLedger,
      max_wrapper_fee: r.maxWrapperFee,
      deadline: r.deadline,
    },
    {
      type: {
        user: ["symbol", null],
        amount: ["symbol", "i128"],
        destination_domain: ["symbol", "u32"],
        mint_recipient: ["symbol", "bytes"],
        max_fee: ["symbol", "i128"],
        min_finality_threshold: ["symbol", "u32"],
        recipient_needs_account: ["symbol", "bool"],
        recipient_owner: ["symbol", "bytes"],
        approval_expiration_ledger: ["symbol", "u32"],
        max_wrapper_fee: ["symbol", "i128"],
        deadline: ["symbol", "u64"],
      },
    },
  );
}

const server = new rpc.Server(RPC_URL);
async function maxFeeFor(domain) {
  const quote = await (
    await fetch(`https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/27/${domain}?forward=true`)
  ).json();
  const tier = quote.find((q) => q.finalityThreshold === 2000);
  return BigInt(tier.forwardFee.high) * 10n; // 6-dec units -> 7-dec stroops, 1.0x high
}
const fees = {};
for (const [d] of plan) fees[d] ??= await maxFeeFor(d);
const maxFee = fees[plan[0][0]];
const { sequence } = await server.getLatestLedger();
const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
const amount = BigInt(Math.round(amountUsdc * 1e7));

const reqs = [];
for (let i = 0; i < plan.length; i++) {
  const [domain, chain] = plan[i];
  // Circle's fee may be at most a tenth of the burn: Solana's ~0.107 needs more than 1 USDC.
  const amt = chain === "solana" && amount < 13_000_000n ? 13_000_000n : amount;
  reqs.push(
    encodeReq({
      user,
      amount: amt,
      destinationDomain: domain,
      mintRecipient: recipientBytes(i, chain),
      maxFee: fees[domain],
      minFinalityThreshold: 2000,
      approvalExpirationLedger: sequence + 50,
      maxWrapperFee: amt,
      deadline,
    }),
  );
}

const account = await server.getAccount(user);
const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE })
  .addOperation(
    new Contract(env.ROUTER).call("batch", new Address(user).toScVal(), xdr.ScVal.scvVec(reqs)),
  )
  .setTimeout(300)
  .build();

const sim = await server.simulateTransaction(tx);
const tag = `n=${plan.length} dest=${MIX.length ? MIX.join("+") : dest} amount=${amountUsdc} ${SAME ? "same" : "distinct"} maxFee=${maxFee}`;
if (rpc.Api.isSimulationError(sim)) {
  const m = sim.error.match(
    /(contract events size bytes: \d+ > \d+|Error\([A-Za-z]+, #?[A-Za-z0-9]+\)|exceeded[^"\n]*)/,
  );
  console.log(`${tag}  FAIL  ${m ? m[0] : sim.error.slice(0, 300)}`);
  process.exit(SEND ? 1 : 0);
}

const data = sim.transactionData.build();
const res = data.resources();
const eventsBytes = (sim.events ?? [])
  .filter((e) => e.event().type().name === "contract")
  .reduce((n, e) => n + e.event().toXDR().length, 0);
const fp = res.footprint();
console.log(
  `${tag}  OK  instr=${res.instructions()} readB=${(res.diskReadBytes ?? res.readBytes).call(res)} writeB=${res.writeBytes()} ` +
    `footprint=${fp.readOnly().length}+${fp.readWrite().length} events~${eventsBytes}B ` +
    `resourceFee=${sim.minResourceFee} stroops (${Number(sim.minResourceFee) / 1e7} XLM)`,
);

if (!SEND) process.exit(0);

// SDK 13 cannot parse protocol-23 TransactionMeta v4, so read the status over raw JSON-RPC.
async function rawGetTx(hash) {
  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash } }),
  });
  return (await r.json()).result;
}

const prepared = rpc.assembleTransaction(tx, sim).build();
prepared.sign(kp);
const sent = await server.sendTransaction(prepared);
if (sent.status !== "PENDING") {
  console.log("send failed:", sent.status, JSON.stringify(sent.errorResult ?? sent));
  process.exit(1);
}
console.log("hash", sent.hash);
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const got = await rawGetTx(sent.hash);
  if (got.status === "NOT_FOUND") continue;
  console.log("status", got.status);
  if (got.status !== "SUCCESS") console.log("  result", got.resultXdr);
  process.exit(got.status === "SUCCESS" ? 0 : 1);
}
console.log("timed out waiting for", sent.hash);
process.exit(1);
