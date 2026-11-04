import {
  Account,
  BASE_FEE,
  Contract,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

/**
 * Reads one escrow entry straight from the Stellar-source XebraEscrow contract
 * (`get_escrow`), by simulating the call. Nothing is signed or submitted, so it needs no funded
 * account and no database: the contract is the source of truth for an intent's status.
 *
 * Both the solver (is this intent still open, and for how long?) and a future status page use this,
 * so they cannot disagree about what the chain says.
 */

export type EscrowStatus = "Open" | "Claimed" | "Challenged" | "Finalized" | "Refunded";

export interface EscrowView {
  status: EscrowStatus;
  /** Unix seconds. */
  expiry: bigint;
  /** 7 decimals. */
  sourceAmount: bigint;
  destChain: number;
  user: string;
  solver: string | null;
  /** The solver's asserted destination-chain delivery reference, as the raw bytes it posted. */
  destTxRef: Uint8Array | null;
  deliveredAmount: bigint;
  solverBond: bigint;
  /** Unix seconds; 0 until a claim. */
  claimedAt: bigint;
  challenger: string | null;
  challengerBond: bigint;
}

/** Just the slice of `rpc.Server` this needs, so a test can stand in for the network. */
export interface EscrowSimulator {
  simulateTransaction(
    tx: ReturnType<TransactionBuilder["build"]>,
  ): Promise<rpc.Api.SimulateTransactionResponse>;
}

/** Any well-formed account works as a simulation source; it is never signed with or charged. */
const SIMULATION_SOURCE = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));

/** `Error::EscrowNotFound` in contracts/stellar-soroban. */
const ESCROW_NOT_FOUND = 7;

const STATUSES: readonly EscrowStatus[] = [
  "Open",
  "Claimed",
  "Challenged",
  "Finalized",
  "Refunded",
];

export class EscrowReadError extends Error {}

/**
 * Returns the escrow for `intentHash` (0x-prefixed or bare 32-byte hex), or `null` when the
 * contract has no such entry. Throws `EscrowReadError` for anything else, so a caller cannot
 * mistake an RPC failure for "not found" and act on it.
 */
export async function readEscrow(
  server: EscrowSimulator,
  networkPassphrase: string,
  contractId: string,
  intentHash: string,
): Promise<EscrowView | null> {
  const hash = Buffer.from(intentHash.replace(/^0x/, ""), "hex");
  if (hash.length !== 32) {
    throw new EscrowReadError(`intent hash must be 32 bytes, got ${hash.length}`);
  }

  const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, "0"), {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      new Contract(contractId).call("get_escrow", nativeToScVal(hash, { type: "bytes" })),
    )
    .setTimeout(30)
    .build();

  let sim: rpc.Api.SimulateTransactionResponse;
  try {
    sim = await server.simulateTransaction(tx);
  } catch (err) {
    // Seen live on testnet (protocol 30): a read of an escrow whose ledger entry had expired comes
    // back with a transaction-data extension (an archived entry to restore) that stellar-sdk 13
    // cannot decode. Ordinary reads decode fine on both networks.
    if (err instanceof TypeError && err.message.includes("Bad union switch")) {
      throw new EscrowReadError(
        "get_escrow came back in a form this stellar-sdk cannot decode, which on testnet meant the " +
          "escrow's ledger entry had expired and needs restoring",
      );
    }
    throw err;
  }

  if (rpc.Api.isSimulationError(sim)) {
    if (sim.error.includes(`Error(Contract, #${ESCROW_NOT_FOUND})`)) return null;
    throw new EscrowReadError(`get_escrow simulation failed: ${sim.error}`);
  }
  const retval = sim.result?.retval;
  if (!retval) throw new EscrowReadError("get_escrow returned no value");

  return parseEscrow(scValToNative(retval));
}

/** Exported for tests: turns `scValToNative` output for an `EscrowEntry` into an `EscrowView`. */
export function parseEscrow(native: unknown): EscrowView {
  if (typeof native !== "object" || native === null) {
    throw new EscrowReadError("escrow entry is not a struct");
  }
  const e = native as Record<string, unknown>;

  return {
    status: parseStatus(e.status),
    expiry: toBigInt(e.expiry, "expiry"),
    sourceAmount: toBigInt(e.source_amount, "source_amount"),
    destChain: Number(toBigInt(e.dest_chain, "dest_chain")),
    user: toAddress(e.user, "user"),
    solver: optionalAddress(e.solver),
    destTxRef: e.dest_tx_ref instanceof Uint8Array ? e.dest_tx_ref : null,
    deliveredAmount: toBigInt(e.delivered_amount, "delivered_amount"),
    solverBond: toBigInt(e.solver_bond, "solver_bond"),
    claimedAt: toBigInt(e.claimed_at, "claimed_at"),
    challenger: optionalAddress(e.challenger),
    challengerBond: toBigInt(e.challenger_bond, "challenger_bond"),
  };
}

function parseStatus(value: unknown): EscrowStatus {
  // A unit-variant `#[contracttype]` enum decodes as a one-element array: ["Open"].
  const name = Array.isArray(value) ? value[0] : value;
  if (typeof name === "string" && (STATUSES as readonly string[]).includes(name)) {
    return name as EscrowStatus;
  }
  throw new EscrowReadError(`unknown escrow status: ${JSON.stringify(value)}`);
}

function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  throw new EscrowReadError(`escrow field ${field} is not an integer`);
}

function toAddress(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new EscrowReadError(`escrow field ${field} is not an address`);
}

function optionalAddress(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
