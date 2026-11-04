/**
 * The real Solana leg, on devnet, against the testnet escrow from scripts/e2e-demo/README.md.
 * Nothing here is stubbed: the solver's own Solana fill adapter delivers a real SPL token and
 * the real Soroban claim asserts that delivery's signature.
 *
 *   MODE=setup   create (once) an SPL mint on devnet and fund the solver's inventory; print the
 *                hex values the Stellar `open` call needs.
 *   MODE=run     poll the escrow, fill with the real adapter, claim.   (ESCROW, SOLVER_SECRET)
 *   MODE=verify  fetch the delivery from devnet and check it the way anyone could: memo = intent
 *                hash, right mint, right recipient, enough tokens.      (HASH, SIG)
 *
 * SOLANA_RPC_URL defaults to devnet. Set it to http://localhost:8899 (and MINT_FILE to a separate
 * file) to run against `solana-test-validator`: the same runtime, but a private chain nobody else
 * can check, so say so wherever the result is recorded.
 *
 * Keys live in ~/.xebra-testnet (outside the repo): sol-payer.json is the solver, sol-owner.json
 * the recipient. Devnet SOL has to come from https://faucet.solana.com; the RPC faucet is closed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  TokenAccountNotFoundError,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Networks, Keypair as StellarKeypair, rpc } from "@stellar/stellar-sdk";
import { readEscrow, verifyDelivery } from "@xebra/chain-adapters";
import { hex32ToBytes } from "@xebra/intent-schema";
import pino from "pino";
import { createSolanaFillAdapter } from "../src/adapters/solana-fill.js";
import { createStellarClaimAdapter } from "../src/adapters/stellar-claim.js";
import { processOpenedIntent } from "../src/fill-loop.js";
import { FileJournal } from "../src/journal.js";
import { pollOpenedIntentsOnce } from "../src/poll-intents.js";

const DIR = `${homedir()}/.xebra-testnet`;
const MINT_FILE = process.env.MINT_FILE ?? `${DIR}/devnet-mint.json`;
const conn = new Connection(
  process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  "confirmed",
);
const loadKey = (f: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"))));
const solver = loadKey("sol-payer.json");
const recipient = loadKey("sol-owner.json");
const hex = (k: PublicKey) => Buffer.from(k.toBytes()).toString("hex");

async function retry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries) throw err;
      console.log(
        `  (network error, retry ${i}/${tries - 1}: ${(err as Error).message.slice(0, 60)})`,
      );
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function setup() {
  const sol = (await retry(() => conn.getBalance(solver.publicKey))) / 1e9;
  console.log("solver", solver.publicKey.toBase58(), "has", sol, "SOL");
  if (sol < 0.02) throw new Error("solver needs about 0.02 devnet SOL: https://faucet.solana.com");

  let mint: PublicKey;
  if (existsSync(MINT_FILE)) {
    mint = new PublicKey(JSON.parse(readFileSync(MINT_FILE, "utf8")).mint);
    console.log("reusing mint", mint.toBase58());
  } else {
    mint = await retry(() => createMint(conn, solver, solver.publicKey, null, 6));
    writeFileSync(MINT_FILE, JSON.stringify({ mint: mint.toBase58() }));
    console.log("created mint", mint.toBase58());
  }
  const ata = await retry(() =>
    getOrCreateAssociatedTokenAccount(conn, solver, mint, solver.publicKey),
  );
  if (ata.amount < 100_000_000n) {
    await retry(() => mintTo(conn, solver, mint, ata.address, solver, 1_000_000_000n));
    console.log("minted 1000 tokens of inventory to", ata.address.toBase58());
  }
  console.log(`MINT=${mint.toBase58()}`);
  console.log(`DEST_ASSET_HEX=${hex(mint)}`);
  console.log(
    `DEST_ADDRESS_HEX=${hex(recipient.publicKey)}   (recipient ${recipient.publicKey.toBase58()})`,
  );
}

async function run() {
  const escrowId = process.env.ESCROW;
  const secret = process.env.SOLVER_SECRET;
  if (!escrowId || !secret) throw new Error("set ESCROW and SOLVER_SECRET");
  const logger = pino({ name: "devnet-real-fill" });
  const server = new rpc.Server("https://soroban-testnet.stellar.org");
  const journal = new FileJournal(process.env.STATE_FILE ?? `${DIR}/devnet-solver-state.json`);

  const fill = createSolanaFillAdapter(conn, solver, {
    async getBalance(mint) {
      try {
        return (await getAccount(conn, getAssociatedTokenAddressSync(mint, solver.publicKey)))
          .amount;
      } catch (err) {
        if (err instanceof TokenAccountNotFoundError) return 0n;
        throw err;
      }
    },
  });
  const claim = createStellarClaimAdapter(
    server,
    escrowId,
    StellarKeypair.fromSecret(secret),
    Networks.TESTNET,
    "https://horizon-testnet.stellar.org",
  );
  const escrow = {
    read: (h: string) => retry(() => readEscrow(server, Networks.TESTNET, escrowId, h)),
  };

  const startLedger = (await retry(() => server.getLatestLedger())).sequence - 5000;
  const source = {
    getEvents: (cursor: string | undefined) =>
      retry(() =>
        server.getEvents({
          filters: [{ type: "contract", contractIds: [escrowId] }],
          ...(cursor ? { cursor } : { startLedger }),
          limit: 100,
        }),
      ),
  };

  let cursor = journal.getCursor();
  let more = true;
  while (more) {
    const page = await pollOpenedIntentsOnce(source, cursor);
    for (const { intentHash, intent } of page.intents) {
      // Only act on intents for the mint this script set up; the escrow may hold older ones.
      const wanted = JSON.parse(readFileSync(MINT_FILE, "utf8")).mint as string;
      if (hex(new PublicKey(wanted)) !== intent.destAsset.assetId.replace(/^0x/, "")) continue;
      console.log("detected", intentHash);
      const outcome = await processOpenedIntent(intentHash, intent, {
        fill,
        claim,
        logger,
        escrow,
        journal,
      });
      console.log(
        "OUTCOME",
        JSON.stringify(outcome, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
      );
    }
    if (page.cursor && page.cursor !== cursor) {
      cursor = page.cursor;
      await journal.setCursor(cursor);
    }
    more = page.more;
  }
}

async function verify() {
  const hash = process.env.HASH;
  const sig = process.env.SIG;
  if (!hash || !sig) throw new Error("set HASH and SIG");
  const mint = new PublicKey(JSON.parse(readFileSync(MINT_FILE, "utf8")).mint);
  const tx = await retry(() =>
    conn.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }),
  );
  if (!tx) throw new Error("transaction not found on devnet");
  const result = verifyDelivery({
    tx,
    intentHash: hex32ToBytes(hash as `0x${string}`),
    mint,
    minAmount: 1_000_000n,
    recipient: recipient.publicKey,
  });
  console.log(
    "VERIFY",
    JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
  const bal = await retry(() =>
    getAccount(conn, getAssociatedTokenAddressSync(mint, recipient.publicKey)),
  );
  console.log("RECIPIENT BALANCE", bal.amount.toString(), "of mint", mint.toBase58());
}

const mode = process.env.MODE;
if (mode === "setup") await setup();
else if (mode === "run") await run();
else if (mode === "verify") await verify();
else throw new Error("set MODE=setup|run|verify");
