import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  AlreadyMintedError,
  type SuiBoundMessage,
  SuiCctpPausedError,
  buildSuiMint,
  readSuiBoundMessage,
} from "@xebra/sdk/build";
import { env } from "../env";
import { stellarDomainId } from "../server/iris";
import { readAttestation } from "../sui-stellar/attestation";
import { suiClient } from "../sui-stellar/client";
import type { CompleteResult } from "../sui-stellar/stellar-side";

/**
 * Xebra's Sui relayer: finishes a Stellar to Sui transfer by submitting Circle's attested mint on
 * Sui and paying the gas from Xebra's own Sui key, so the person never needs SUI.
 *
 * Circle does not deliver to Sui, so without this the recipient claims at `/claim` with a Sui
 * wallet that holds gas. The person asks for it with the "Pay the Sui network fee for me" box on
 * the Stellar form; the form then calls `POST /api/stellar-sui/complete` until the USDC lands.
 *
 * Anyone may call it for any Stellar burn, and that is safe by construction:
 *  - The USDC goes to the burn's `mintRecipient`, signed by Circle. The relayer only pays gas.
 *  - We only pay for burns made through Xebra's wrapper, which charged Xebra's fee (at least
 *    0.01 USDC against ~0.003 SUI of gas). A burn straight into Circle's contract is refused, so a
 *    stranger cannot drain the key by sending Circle dust.
 *  - Each message mints once (Circle's nonce), so the same burn cannot be paid for twice; a second
 *    call reads "already minted" from a free simulation and answers `delivered`.
 *  - The gas budget comes from that simulation and is capped (`MAX_GAS_MIST`) before signing.
 *
 * Self-claim keeps working whatever happens here: the wrapper always burns with a zero
 * `destination_caller`, so the recipient can still finish it at `/claim` if the relayer is off,
 * empty or refuses.
 */

/** Sui's CCTP domain. */
const SUI_DOMAIN = 8;

/** Stellar USDC (7 decimals) per CCTP base unit (6 decimals). */
const STROOPS_PER_CCTP_UNIT = 10n;

/** Most gas one mint may spend: 0.05 SUI. Real mints cost about 0.002 to 0.003 SUI. */
export const MAX_GAS_MIST = 50_000_000n;

/** The wrapper event every Xebra burn emits (`#[contractevent] BridgeInitiated`, snake_case topic). */
const BRIDGE_TOPIC = "bridge_initiated";

/**
 * The relayer's key from `SUI_RELAYER_SECRET` (a `suiprivkey1…` Ed25519 key, as `sui keytool
 * export` prints it), or null when the relayer is off: unset, or not a key we can read. The value is
 * never logged.
 */
export function suiRelayerKey(): Ed25519Keypair | null {
  const v = process.env.SUI_RELAYER_SECRET?.trim();
  if (!v) return null;
  try {
    return Ed25519Keypair.fromSecretKey(v);
  } catch {
    warnUnusableKey();
    return null;
  }
}

let warned = false;
function warnUnusableKey(): void {
  if (warned) return;
  warned = true;
  console.error(
    "SUI_RELAYER_SECRET is set but is not an Ed25519 suiprivkey1… key, so the Sui relayer is off. The value is not logged.",
  );
}

/** Whether Xebra pays the Sui gas for Stellar to Sui transfers on this deployment. */
export function stellarSuiRelayOn(): boolean {
  return env.cctpWrapperContractId !== null && suiRelayerKey() !== null;
}

/** What the wrapper said about a burn, read from its `bridge_initiated` event. */
export interface WrapperBurn {
  destinationDomain: number;
  /** 0x and 64 hex, lower case. */
  mintRecipient: string;
  /** What reached Circle, in Stellar USDC's own 7 decimals (stroops). */
  netBurned: bigint;
  forwarded: boolean;
}

function hex(bytes: Uint8Array): string {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Reads a `bridge_initiated` event's data, or null when it is not one. Pure. */
export function readWrapperBurn(value: unknown): WrapperBurn | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const recipient = v.mint_recipient;
  const domain = v.destination_domain;
  const net = v.net_burned;
  if (!(recipient instanceof Uint8Array) || recipient.length !== 32) return null;
  if (typeof domain !== "number" && typeof domain !== "bigint") return null;
  if (typeof net !== "bigint" && typeof net !== "number") return null;
  return {
    destinationDomain: Number(domain),
    mintRecipient: hex(recipient),
    netBurned: BigInt(net),
    forwarded: v.forwarded === true,
  };
}

/**
 * Why we will not pay for this burn, or null when we will: it must be the wrapper's own burn to Sui,
 * not forwarded, and match Circle's message exactly. Pure.
 */
export function burnProblem(burn: WrapperBurn | null, message: SuiBoundMessage): string | null {
  if (!burn) {
    return "This transfer was not sent through Xebra, so Xebra does not pay its Sui fee. It can still be claimed with any Sui wallet.";
  }
  if (burn.destinationDomain !== SUI_DOMAIN || burn.forwarded) {
    return "This transfer is not a Xebra transfer to Sui.";
  }
  // Stellar USDC has 7 decimals and CCTP messages 6: the real burn 04d26876…805d (2026-11-23) logged
  // net_burned 9900000 and Circle's message said 990000.
  if (
    burn.mintRecipient !== message.recipient.toLowerCase() ||
    burn.netBurned !== message.amount * STROOPS_PER_CCTP_UNIT
  ) {
    return "Circle's message does not match the Xebra transfer in this transaction.";
  }
  return null;
}

/** The ledger a Stellar transaction landed in, or null if the node does not have it. */
async function ledgerOf(txHash: string): Promise<number | null> {
  const res = await fetch(env.sorobanRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: { hash: txHash },
    }),
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Stellar RPC returned ${res.status}`);
  const body = (await res.json()) as { result?: { status?: string; ledger?: number } };
  if (body.result?.status !== "SUCCESS" || typeof body.result.ledger !== "number") return null;
  return body.result.ledger;
}

/**
 * The wrapper's `bridge_initiated` event in this transaction, read from Stellar RPC. Null when the
 * transaction did not call the wrapper (or the node no longer keeps it, about a week).
 */
export async function wrapperBurnIn(txHash: string): Promise<WrapperBurn | null> {
  const wrapper = env.cctpWrapperContractId;
  if (!wrapper) return null;
  const ledger = await ledgerOf(txHash);
  if (ledger === null) return null;
  const server = new rpc.Server(env.sorobanRpcUrl, { timeout: 10_000 });
  const topic = xdr.ScVal.scvSymbol(BRIDGE_TOPIC).toXDR("base64");
  const res = await server.getEvents({
    startLedger: ledger,
    filters: [{ type: "contract", contractIds: [wrapper], topics: [[topic]] }],
    limit: 200,
  });
  for (const e of res.events) {
    if (e.ledger !== ledger) break;
    if (e.txHash.toLowerCase() !== txHash.toLowerCase()) continue;
    return readWrapperBurn(scValToNative(e.value));
  }
  return null;
}

export interface RelayDeps {
  key: Ed25519Keypair;
  client?: SuiGrpcClient;
  readAttestation?: typeof readAttestation;
  wrapperBurnIn?: typeof wrapperBurnIn;
  buildSuiMint?: typeof buildSuiMint;
  /** Signs and sends the built mint; answers the digest and whether it succeeded. */
  execute?: (
    client: SuiGrpcClient,
    key: Ed25519Keypair,
    json: string,
  ) => Promise<{ digest: string; ok: boolean; error?: string }>;
}

/** Sends the mint `buildSuiMint` built and resolved, after checking its gas budget. */
async function executeMint(
  client: SuiGrpcClient,
  key: Ed25519Keypair,
  json: string,
): Promise<{ digest: string; ok: boolean; error?: string }> {
  const tx = Transaction.from(json);
  const budget = tx.getData().gasData.budget;
  if (budget === null || budget === undefined || BigInt(budget) > MAX_GAS_MIST) {
    throw new Error(`gas budget ${budget} is over the relayer's cap`);
  }
  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: key,
    include: { effects: true },
  });
  if (result.$kind === "Transaction") return { digest: result.Transaction.digest, ok: true };
  return {
    digest: result.FailedTransaction.digest,
    ok: false,
    error: JSON.stringify(result.FailedTransaction.status),
  };
}

// One Vercel instance never sends the same burn twice at once. Two instances racing costs one
// failed mint's gas, never funds: Circle's nonce lets only one land, and the loser re-reads it.
const inFlight = new Set<string>();

/**
 * Finishes one Stellar to Sui transfer. Every refusal happens before any gas is spent: the mint is
 * simulated while it is built, and a burn that was already minted answers `delivered`.
 */
export async function relayStellarToSui(txHash: string, deps: RelayDeps): Promise<CompleteResult> {
  const key = txHash.toLowerCase();
  if (inFlight.has(key)) return { status: "pending", reason: "already being completed" };
  inFlight.add(key);
  try {
    const att = await (deps.readAttestation ?? readAttestation)(txHash, stellarDomainId());
    if (att.state !== "complete") {
      return att.state === "pending"
        ? { status: "pending" }
        : { status: "unknown", reason: att.reason };
    }

    let message: SuiBoundMessage;
    try {
      message = readSuiBoundMessage(Buffer.from(att.message.replace(/^0x/, ""), "hex"));
    } catch (err) {
      return {
        status: "refused",
        reason: err instanceof Error ? err.message : "not a Sui transfer",
      };
    }

    const problem = burnProblem(await (deps.wrapperBurnIn ?? wrapperBurnIn)(txHash), message);
    if (problem) return { status: "refused", reason: problem };

    const client = deps.client ?? suiClient();
    const build = deps.buildSuiMint ?? buildSuiMint;
    const sender = deps.key.toSuiAddress();
    const args = { sender, message: att.message, attestation: att.attestation };

    let built: Awaited<ReturnType<typeof buildSuiMint>>;
    try {
      built = await build(client, args);
    } catch (err) {
      if (err instanceof AlreadyMintedError) return { status: "delivered" };
      if (err instanceof SuiCctpPausedError) return { status: "pending", reason: err.message };
      throw err;
    }

    const sent = await (deps.execute ?? executeMint)(client, deps.key, built.transaction);
    if (sent.ok) return { status: "submitted", hash: sent.digest };

    // Lost a race to another instance or to the recipient: the USDC is there all the same.
    try {
      await build(client, args);
    } catch (err) {
      if (err instanceof AlreadyMintedError) return { status: "delivered" };
    }
    console.error("stellar-sui relay mint failed", sent.digest, sent.error);
    return { status: "failed", hash: sent.digest, reason: "The Sui mint did not go through." };
  } finally {
    inFlight.delete(key);
  }
}
