/**
 * @xebra/solver — fill bot for the Stellar->Solana corridor, run as one process.
 *
 * It polls Soroban RPC for `IntentOpened` on the Stellar-source XebraEscrow, re-reads the escrow
 * from the chain before spending anything, delivers on Solana through the adapter, then claims
 * on Stellar. No event bus, no database: the cursor and a record of what it has delivered live in
 * one state file (`SOLVER_STATE_FILE`). See docs/intent-layer-plan.md and fill-loop.ts.
 *
 * v1 scope: Stellar->Solana only. The Arc->Stellar corridor's solver loop (Stellar DEX
 * path-payment fills) is not implemented here — see the frozen v1 spec for that behavior.
 */

import {
  TokenAccountNotFoundError,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection as SolanaConnection, Keypair as SolanaKeypair } from "@solana/web3.js";
import { Keypair as StellarKeypair, rpc } from "@stellar/stellar-sdk";
import { readEscrow } from "@xebra/chain-adapters";
import { startObservability } from "@xebra/observability";
import pino from "pino";
import { createSolanaFillAdapter } from "./adapters/solana-fill.js";
import { createStellarClaimAdapter } from "./adapters/stellar-claim.js";
import { loadConfig } from "./config.js";
import { processOpenedIntent } from "./fill-loop.js";
import { FileJournal } from "./journal.js";
import { type IntentEventSource, pollOpenedIntentsOnce } from "./poll-intents.js";

const logger = pino({ name: "solver" });

/** About a day of ledgers at ~5 s each: more than any intent still worth filling. */
const LOOKBACK_LEDGERS = 17_280;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const config = loadConfig();
  const obs = startObservability({ serviceName: "solver" });

  const solanaConnection = new SolanaConnection(config.SOLANA_RPC_URL, "confirmed");
  const solanaKeypair = SolanaKeypair.fromSecretKey(
    Buffer.from(config.SOLVER_SOLANA_KEYPAIR, "base64"),
  );
  const sorobanServer = new rpc.Server(config.SOROBAN_RPC_URL);
  const stellarKeypair = StellarKeypair.fromSecret(config.SOLVER_STELLAR_SECRET);

  // Backs docs/architecture.md §11's "per-chain solver inventory low" alert: recorded on every
  // fill quote, so a Grafana panel/alert can watch this gauge directly rather than needing the
  // separate solver_inventory_snapshots table populated first.
  const inventoryGauge = obs.meter.createGauge("solver_inventory_amount", {
    description:
      "Solver's Solana token balance for a destination-asset mint, sampled on each fill quote.",
  });

  const fill = createSolanaFillAdapter(solanaConnection, solanaKeypair, {
    async getBalance(mint) {
      const ata = getAssociatedTokenAddressSync(mint, solanaKeypair.publicKey);
      let amount: bigint;
      try {
        amount = (await getAccount(solanaConnection, ata)).amount;
      } catch (err) {
        if (err instanceof TokenAccountNotFoundError) {
          amount = 0n;
        } else {
          throw err;
        }
      }
      inventoryGauge.record(Number(amount), { mint: mint.toBase58() });
      return amount;
    },
  });
  const claim = createStellarClaimAdapter(
    sorobanServer,
    config.STELLAR_ESCROW_CONTRACT_ID,
    stellarKeypair,
    config.STELLAR_NETWORK_PASSPHRASE,
  );

  const journal = new FileJournal(config.SOLVER_STATE_FILE);
  const escrow = {
    read: (intentHash: string) =>
      readEscrow(
        sorobanServer,
        config.STELLAR_NETWORK_PASSPHRASE,
        config.STELLAR_ESCROW_CONTRACT_ID,
        intentHash,
      ),
  };

  const startLedger =
    config.SOROBAN_START_LEDGER ??
    Math.max(1, (await sorobanServer.getLatestLedger()).sequence - LOOKBACK_LEDGERS);
  const source: IntentEventSource = {
    getEvents: (cursor) =>
      sorobanServer.getEvents({
        filters: [{ type: "contract", contractIds: [config.STELLAR_ESCROW_CONTRACT_ID] }],
        ...(cursor ? { cursor } : { startLedger }),
        limit: 100,
      }),
  };

  let cursor = journal.getCursor();
  let running = true;
  // Finish the intent in hand, then stop: killing the process between a delivery and its claim is
  // the one thing the journal exists to survive, not something to do on purpose.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.info({ signal }, "solver: stopping after the current intent");
      running = false;
    });
  }

  logger.info(
    { contract: config.STELLAR_ESCROW_CONTRACT_ID, cursor, startLedger },
    "solver: watching for IntentOpened events",
  );

  while (running) {
    try {
      let more = true;
      while (more && running) {
        const page = await pollOpenedIntentsOnce(source, cursor);
        for (const { intentHash, intent } of page.intents) {
          const outcome = await processOpenedIntent(intentHash, intent, {
            fill,
            claim,
            logger,
            escrow,
            journal,
          });
          logger.info({ intentHash, outcome }, "solver: processed intent");
        }
        // Advance only after every intent on the page was handled. A crash re-reads the page,
        // and the journal and the on-chain status make that safe.
        if (page.cursor && page.cursor !== cursor) {
          cursor = page.cursor;
          await journal.setCursor(cursor);
        }
        more = page.more;
      }
    } catch (err) {
      logger.error({ err }, "solver: poll failed, will retry");
    }
    await sleep(config.POLL_INTERVAL_MS);
  }

  await obs.shutdown();
}

main().catch((err) => {
  logger.error({ err }, "solver: fatal startup error");
  process.exit(1);
});
