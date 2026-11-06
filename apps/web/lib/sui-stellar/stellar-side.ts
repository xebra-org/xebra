import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import { env } from "../env";
import { readAttestation } from "./attestation";
import { STELLAR_CCTP_FORWARDER, SUI_DOMAIN, type VerifiedBurn, verifyMessage } from "./cctp";

/**
 * The Stellar half: check a recipient can receive, read Circle's attestation of a Sui burn, and
 * complete the transfer with `mint_and_forward` from the relayer account.
 *
 * Every refusal here happens before a fee is spent. `prepareTransaction` simulates the call first,
 * so a message that was already minted, or a forwarder that would revert, fails there for free.
 */

export interface RecipientStatus {
  exists: boolean;
  hasTrustline: boolean;
}

const MISSING_TRUSTLINE = "trustline entry is missing for account";

export async function recipientStatus(recipient: string): Promise<RecipientStatus> {
  const server = new rpc.Server(env.sorobanRpcUrl);
  let account: Awaited<ReturnType<rpc.Server["getAccount"]>>;
  try {
    account = await server.getAccount(recipient);
  } catch {
    return { exists: false, hasTrustline: false };
  }
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: env.stellarNetworkPassphrase,
  })
    .addOperation(
      new Contract(env.usdcSacAddress).call("balance", Address.fromString(recipient).toScVal()),
    )
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    if (sim.error.includes(MISSING_TRUSTLINE)) return { exists: true, hasTrustline: false };
    throw new Error(`could not check the recipient's USDC trustline: ${sim.error}`);
  }
  return { exists: true, hasTrustline: true };
}

export type CompleteResult =
  | { status: "pending" | "unknown"; reason?: string }
  | { status: "delivered" }
  | { status: "refused"; reason: string }
  | { status: "submitted" | "failed"; hash: string; ledger?: number };

// A Vercel instance serves many requests; this stops the same instance from sending one digest twice
// at once. Two instances racing is possible and costs one failed (reverted) fee, never funds.
const inFlight = new Set<string>();

function hexBytes(hex: string): Buffer {
  return Buffer.from(hex.replace(/^0x/, ""), "hex");
}

/**
 * Circle's Stellar MessageTransmitter fails `receive_message` with contract error 6908 when the
 * message's nonce has been used. Observed on mainnet 2026-11-06: simulating a message that had just
 * been minted failed with exactly `Error(Contract, #6908)`, while the same call simulated fine
 * before it was minted.
 */
const NONCE_ALREADY_USED = "Error(Contract, #6908)";

function mintCall(att: { message: string; attestation: string }) {
  return new Contract(STELLAR_CCTP_FORWARDER).call(
    "mint_and_forward",
    nativeToScVal(hexBytes(att.message), { type: "bytes" }),
    nativeToScVal(hexBytes(att.attestation), { type: "bytes" }),
  );
}

/**
 * Whether the mint for an attested message has already happened. Simulation only: nothing is
 * signed or sent. `source` is any existing account (the recipient will do); a simulation needs a
 * sequence number but no signature.
 */
export async function mintState(
  att: { message: string; attestation: string },
  source: string,
): Promise<"delivered" | "open" | "unknown"> {
  try {
    const server = new rpc.Server(env.sorobanRpcUrl);
    const account = await server.getAccount(source);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: env.stellarNetworkPassphrase,
    })
      .addOperation(mintCall(att))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationError(sim)) return "open";
    return sim.error.includes(NONCE_ALREADY_USED) ? "delivered" : "unknown";
  } catch {
    return "unknown";
  }
}

export type ClaimPlan =
  | { ok: true; xdr: string; recipient: string; amount: bigint }
  | { ok: false; reason: string; delivered?: boolean };

/**
 * The unsigned mint, with the person who will pay for it as the source account, for their own
 * wallet to sign. The same checks as `completeBurn`, and the same freebie: a mint that would revert
 * fails in simulation here, before anyone is asked to sign.
 */
export async function planClaim(digest: string, payer: string): Promise<ClaimPlan> {
  const att = await readAttestation(digest);
  if (att.state !== "complete") {
    return {
      ok: false,
      reason:
        att.state === "pending"
          ? "Circle has not attested this burn yet."
          : `Circle has no attestation for this burn yet (${att.reason}).`,
    };
  }
  let burn: VerifiedBurn;
  try {
    burn = verifyMessage(hexBytes(att.message), { tokenMessenger: env.cctpTokenMessengerId });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "invalid message" };
  }
  const recipient = await recipientStatus(burn.recipient);
  if (!recipient.exists || !recipient.hasTrustline) {
    return {
      ok: false,
      reason: recipient.exists
        ? "The recipient has no USDC trustline. Add one, then try again."
        : "The recipient account does not exist on Stellar yet. Fund it, add a USDC trustline, then try again.",
    };
  }
  const server = new rpc.Server(env.sorobanRpcUrl);
  const account = await server.getAccount(payer);
  const tx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: env.stellarNetworkPassphrase,
  })
    .addOperation(mintCall(att))
    .setTimeout(300)
    .build();
  try {
    const prepared = await server.prepareTransaction(tx);
    return { ok: true, xdr: prepared.toXDR(), recipient: burn.recipient, amount: burn.amount };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(NONCE_ALREADY_USED)) {
      return { ok: false, reason: "This transfer was already completed.", delivered: true };
    }
    return { ok: false, reason: `Stellar would not accept this mint (${msg.slice(0, 200)}).` };
  }
}

export async function completeBurn(digest: string, relayerSecret: string): Promise<CompleteResult> {
  if (inFlight.has(digest)) return { status: "pending", reason: "already being completed" };
  inFlight.add(digest);
  try {
    const att = await readAttestation(digest);
    if (att.state !== "complete") {
      return att.state === "pending"
        ? { status: "pending" }
        : { status: "unknown", reason: att.reason };
    }

    let burn: VerifiedBurn;
    try {
      burn = verifyMessage(hexBytes(att.message), { tokenMessenger: env.cctpTokenMessengerId });
    } catch (err) {
      return { status: "refused", reason: err instanceof Error ? err.message : "invalid message" };
    }

    // A mint to an account without a trustline cannot land, and the USDC would sit at the forwarder.
    const recipient = await recipientStatus(burn.recipient);
    if (!recipient.exists || !recipient.hasTrustline) {
      return {
        status: "refused",
        reason: recipient.exists
          ? "The recipient has no USDC trustline. Add one, then try again."
          : "The recipient account does not exist on Stellar yet. Fund it, add a USDC trustline, then try again.",
      };
    }

    const keypair = Keypair.fromSecret(relayerSecret);
    const server = new rpc.Server(env.sorobanRpcUrl);
    const account = await server.getAccount(keypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: "1000000",
      networkPassphrase: env.stellarNetworkPassphrase,
    })
      .addOperation(mintCall(att))
      .setTimeout(180)
      .build();

    let prepared: Awaited<ReturnType<rpc.Server["prepareTransaction"]>>;
    try {
      prepared = await server.prepareTransaction(tx);
    } catch (err) {
      // Simulation failed, so nothing was sent and no fee was spent. The usual cause is a message
      // that was already minted (a retry after success); the raw reason is passed on, not guessed at.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes(NONCE_ALREADY_USED)) return { status: "delivered" };
      return {
        status: "refused",
        reason: `Stellar would not accept this mint (${msg.slice(0, 200)}). If the USDC has already arrived, it was completed earlier.`,
      };
    }
    prepared.sign(keypair);
    const sent = await server.sendTransaction(prepared);
    if (sent.status === "ERROR") throw new Error("the network rejected the transaction");

    // stellar-sdk 13 cannot decode protocol 23+ result meta, so confirm through Horizon's JSON.
    const confirmed = await confirmViaHorizon(sent.hash);
    if (!confirmed) return { status: "submitted", hash: sent.hash };
    return confirmed.successful
      ? { status: "submitted", hash: sent.hash, ledger: confirmed.ledger }
      : { status: "failed", hash: sent.hash, ledger: confirmed.ledger };
  } finally {
    inFlight.delete(digest);
  }
}

async function confirmViaHorizon(
  hash: string,
  timeoutMs = 45_000,
): Promise<{ successful: boolean; ledger: number } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${env.horizonUrl}/transactions/${hash}`, { cache: "no-store" });
    if (r.ok) {
      const t = (await r.json()) as { successful: boolean; ledger: number };
      return { successful: t.successful, ledger: t.ledger };
    }
    await new Promise((res) => setTimeout(res, 2500));
  }
  return null;
}
