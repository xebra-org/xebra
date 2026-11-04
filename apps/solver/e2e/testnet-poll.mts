/**
 * Live Stellar-testnet run of the solver's detect -> check -> claim path, using the same modules
 * `src/index.ts` wires together: poll-intents, readEscrow, processOpenedIntent, the real Soroban
 * claim adapter, and the file journal.
 *
 * WHAT IS NOT REAL: the Solana delivery. `stubFill` below delivers nothing and returns a fixed
 * reference, because Solana devnet's faucet was unavailable (see scripts/e2e-demo/README.md). So
 * the `claim` this posts asserts a delivery that never happened: on a testnet escrow with
 * throwaway keys that is a test of the Stellar half, and exactly the kind of claim the challenge
 * window exists to catch. Do not point this at an escrow holding real funds.
 *
 * Env: ESCROW (contract id), SOLVER_SECRET (S...), optionally STATE_FILE, START_LEDGER.
 */
import { Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { readEscrow } from "@xebra/chain-adapters";
import pino from "pino";
import { createStellarClaimAdapter } from "../src/adapters/stellar-claim.js";
import type { FillAdapter } from "../src/fill-loop.js";
import { processOpenedIntent } from "../src/fill-loop.js";
import { FileJournal } from "../src/journal.js";
import { pollOpenedIntentsOnce } from "../src/poll-intents.js";

const ESCROW = process.env.ESCROW ?? "";
const SECRET = process.env.SOLVER_SECRET ?? "";
if (!ESCROW || !SECRET) throw new Error("set ESCROW and SOLVER_SECRET");
const RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";

/** This network times out often; the solver's own loop retries on the next tick, a one-shot script must too. */
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

const logger = pino({ name: "testnet-poll", level: "info" });
const server = new rpc.Server(RPC_URL);
const journal = new FileJournal(process.env.STATE_FILE ?? "./testnet-poll-state.json");

const stubFill: FillAdapter = {
  quote: async (i) => ({ canFill: true, deliveredAmount: i.minDestAmount }),
  fill: async (i) => ({ destTxRef: "STUB-no-solana-delivery", deliveredAmount: i.minDestAmount }),
};
const claim = createStellarClaimAdapter(
  server,
  ESCROW,
  Keypair.fromSecret(SECRET),
  Networks.TESTNET,
);
const escrow = {
  read: (h: string) => retry(() => readEscrow(server, Networks.TESTNET, ESCROW, h)),
};

const startLedger =
  Number(process.env.START_LEDGER) || (await retry(() => server.getLatestLedger())).sequence - 5000;
const source = {
  getEvents: (cursor: string | undefined) =>
    retry(() =>
      server.getEvents({
        filters: [{ type: "contract", contractIds: [ESCROW] }],
        ...(cursor ? { cursor } : { startLedger }),
        limit: 100,
      }),
    ),
};

let cursor = journal.getCursor();
for (let pass = 1; pass <= 2; pass++) {
  console.log(`\n--- pass ${pass} (cursor ${cursor ?? "none"}) ---`);
  let more = true;
  while (more) {
    const page = await pollOpenedIntentsOnce(source, cursor);
    for (const { intentHash, intent, txRef } of page.intents) {
      console.log(
        "detected IntentOpened",
        intentHash,
        "in tx",
        txRef,
        "minDest",
        intent.minDestAmount,
      );
      const before = await escrow.read(intentHash);
      console.log("  chain says before:", before?.status);
      const outcome = await processOpenedIntent(intentHash, intent, {
        fill: stubFill,
        claim,
        logger,
        escrow,
        journal,
      });
      console.log(
        "  outcome:",
        JSON.stringify(outcome, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
      );
      const after = await escrow.read(intentHash);
      console.log(
        "  chain says after:",
        after?.status,
        "solver",
        after?.solver,
        "bond",
        after?.solverBond,
      );
    }
    if (page.cursor && page.cursor !== cursor) {
      cursor = page.cursor;
      await journal.setCursor(cursor);
    }
    more = page.more;
  }
  if (pass === 1) {
    // Second pass from a cold start of the cursor, to show a restart cannot deliver twice.
    cursor = undefined;
  }
}
