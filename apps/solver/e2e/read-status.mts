/**
 * Prints an escrow's events and its current state, read from Stellar testnet with the same
 * `readEscrow` the solver uses.   ESCROW=C... HASH=0x... npx tsx e2e/read-status.mts
 */
import { Networks, rpc } from "@stellar/stellar-sdk";
import { decodeSorobanEvents, readEscrow } from "@xebra/chain-adapters";

const escrow = process.env.ESCROW;
const hash = process.env.HASH;
if (!escrow || !hash) throw new Error("set ESCROW and HASH");

const server = new rpc.Server(process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org");

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= 6) throw err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

const latest = (await retry(() => server.getLatestLedger())).sequence;
const events = await retry(() =>
  server.getEvents({
    filters: [{ type: "contract", contractIds: [escrow] }],
    startLedger: latest - 3000,
    limit: 100,
  }),
);
for (const e of decodeSorobanEvents(events.events)) {
  console.log("event", e.eventType, "tx", e.txRef, "ledger", e.blockOrLedgerNumber);
}

const view = await retry(() => readEscrow(server, Networks.TESTNET, escrow, hash));
console.log(
  view
    ? `status ${view.status} | solver ${view.solver} | bond ${view.solverBond} | delivered ${view.deliveredAmount} | destTxRef ${Buffer.from(view.destTxRef ?? []).toString()}`
    : "no such escrow",
);
