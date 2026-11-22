import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  type Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import {
  EVM_CHAINS,
  STELLAR_CCTP_FORWARDER,
  SUI_DOMAIN,
  type VerifiedBurn,
  verifyMessage,
} from "@xebra/sdk/core";
import { APTOS_CCTP_DOMAIN, aptosDestinations } from "../aptos/config";
import { describeRejectedTransaction } from "../cctp-bridge";
import { env } from "../env";
import { readAttestation } from "./attestation";

/** Solana's CCTP domain, a source of burns into Stellar like Sui. */
const SOLANA_DOMAIN = 5;

/**
 * The Stellar half: check a recipient can receive, read Circle's attestation of a burn into Stellar,
 * and complete the transfer with `mint_and_forward` from the relayer account.
 *
 * Circle's Forwarding Service delivers to Stellar from no chain at all, so every transfer into
 * Stellar is finished this way: from Sui, from Solana, and from every EVM chain in the table.
 *
 * Every refusal here happens before a fee is spent. `prepareTransaction` simulates the call first,
 * so a message that was already minted, or a forwarder that would revert, fails there for free.
 */

export interface RecipientStatus {
  exists: boolean;
  hasTrustline: boolean;
  /** USDC held, in stroops; zero without a trustline. */
  balance: bigint;
}

const MISSING_TRUSTLINE = "trustline entry is missing for account";

function stellarRpc(): rpc.Server {
  return new rpc.Server(env.sorobanRpcUrl, { timeout: 10_000 });
}

function isAccountNotFoundError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as {
      code?: unknown;
      status?: unknown;
      message?: unknown;
      response?: { status?: unknown };
    };
    if (e.code === 404 || e.status === 404 || e.response?.status === 404) {
      return true;
    }
    if (typeof e.message === "string" && /account not found/i.test(e.message)) {
      return true;
    }
  }
  if (err instanceof Error && /account not found/i.test(err.message)) {
    return true;
  }
  return false;
}

export async function recipientStatus(recipient: string): Promise<RecipientStatus> {
  const server = stellarRpc();
  let account: Awaited<ReturnType<rpc.Server["getAccount"]>>;
  try {
    account = await server.getAccount(recipient);
  } catch (err) {
    if (isAccountNotFoundError(err)) {
      return { exists: false, hasTrustline: false, balance: 0n };
    }
    throw err;
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
    if (sim.error.includes(MISSING_TRUSTLINE)) {
      return { exists: true, hasTrustline: false, balance: 0n };
    }
    throw new Error(`could not check the recipient's USDC trustline: ${sim.error}`);
  }
  const held = sim.result ? scValToNative(sim.result.retval) : 0n;
  return { exists: true, hasTrustline: true, balance: BigInt(held as bigint | number | string) };
}

/**
 * The chains whose burns into Stellar this relayer completes: Sui, Solana and every EVM chain we
 * list. Solana (5) is here whether or not this deployment builds Solana burns (`SOLANA_SENDS_TO`):
 * anyone can burn on Solana toward Stellar, and the completion is safe for any burn that verifies.
 */
export const STELLAR_INBOUND_SOURCES: readonly number[] = [
  SUI_DOMAIN,
  SOLANA_DOMAIN,
  ...Object.values(EVM_CHAINS).map((c) => c.cctpDomainId),
];

/**
 * `STELLAR_INBOUND_SOURCES`, plus Aptos while Aptos may send to Stellar (`APTOS_ENABLED` and
 * `stellar` in `APTOS_SENDS_TO`). Read on each call, so the switch takes effect without a rebuild.
 */
export function stellarInboundSources(): readonly number[] {
  return aptosDestinations().includes("stellar")
    ? [...STELLAR_INBOUND_SOURCES, APTOS_CCTP_DOMAIN]
    : STELLAR_INBOUND_SOURCES;
}

function verify(message: string): VerifiedBurn {
  return verifyMessage(hexBytes(message), {
    tokenMessenger: env.cctpTokenMessengerId,
    sources: stellarInboundSources(),
  });
}

export type CompleteResult =
  | { status: "pending"; reason?: string; retryAfterMs?: number }
  | { status: "unknown"; reason?: string }
  | { status: "delivered" }
  | { status: "refused"; reason: string }
  | { status: "submitted"; hash: string; ledger?: number }
  | { status: "failed"; hash?: string; reason?: string; ledger?: number };

const RETRY_AFTER_MS = 5_000;

// A Vercel instance serves many requests; this stops the same instance from sending one digest twice
// at once. Two instances racing is possible and costs one failed (reverted) fee, never funds; the
// loser re-reads `mintState` after its transaction fails, so its caller still hears "delivered".
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
    const server = stellarRpc();
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

/** Extracts a contract error code (`Error(Contract, #N)`) when Soroban names one; never raw trace text. */
function contractErrorCode(raw: string): string | null {
  const match = raw.match(/Error\(Contract,\s*#(\d+)\)/);
  return match ? `contract error #${match[1]}` : null;
}

type PrepareMintOutcome =
  | { ok: true; prepared: Transaction }
  | { ok: false; delivered: true }
  | { ok: false; delivered: false; reason: string };

/**
 * Simulates a mint transaction and distinguishes real Soroban contract refusals (`isSimulationError`)
 * from RPC transport outages (which are rethrown so routes return 502/503 `upstream_unavailable`).
 */
async function prepareMintTransaction(
  server: rpc.Server,
  tx: Transaction,
  context: string,
): Promise<PrepareMintOutcome> {
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    if (sim.error.includes(NONCE_ALREADY_USED)) {
      return { ok: false, delivered: true };
    }
    console.error(`[stellar-side] ${context} simulation refused`, sim.error);
    const decoded = contractErrorCode(sim.error);
    return {
      ok: false,
      delivered: false,
      reason: decoded
        ? `Stellar would not accept this mint (${decoded}).`
        : "Stellar would not accept this mint.",
    };
  }
  return { ok: true, prepared: rpc.assembleTransaction(tx, sim).build() };
}

export type ClaimPlan =
  | { ok: true; xdr: string; recipient: string; amount: bigint }
  | { ok: false; reason: string; delivered?: boolean };

/**
 * The unsigned mint, with the person who will pay for it as the source account, for their own
 * wallet to sign. The same checks as `completeBurn`, and the same freebie: a mint that would revert
 * fails in simulation here, before anyone is asked to sign.
 */
export async function planClaim(
  digest: string,
  payer: string,
  sourceDomain: number = SUI_DOMAIN,
): Promise<ClaimPlan> {
  const att = await readAttestation(digest, sourceDomain);
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
    burn = verify(att.message);
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
  const server = stellarRpc();
  const account = await server.getAccount(payer);
  const tx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: env.stellarNetworkPassphrase,
  })
    .addOperation(mintCall(att))
    .setTimeout(300)
    .build();
  const prep = await prepareMintTransaction(server, tx, "planClaim");
  if (!prep.ok) {
    return prep.delivered
      ? { ok: false, reason: "This transfer was already completed.", delivered: true }
      : { ok: false, reason: prep.reason };
  }
  return {
    ok: true,
    xdr: prep.prepared.toXDR(),
    recipient: burn.recipient,
    amount: burn.amount,
  };
}

export async function completeBurn(
  digest: string,
  relayerSecret: string,
  sourceDomain: number = SUI_DOMAIN,
  opts: { minAmount?: bigint; confirmTimeoutMs?: number; confirmPollMs?: number } = {},
): Promise<CompleteResult> {
  const key = `${sourceDomain}:${digest}`;
  if (inFlight.has(key)) return { status: "pending", reason: "already being completed" };
  inFlight.add(key);
  try {
    const att = await readAttestation(digest, sourceDomain);
    if (att.state !== "complete") {
      return att.state === "pending"
        ? { status: "pending" }
        : { status: "unknown", reason: att.reason };
    }

    let burn: VerifiedBurn;
    try {
      burn = verify(att.message);
    } catch (err) {
      return { status: "refused", reason: err instanceof Error ? err.message : "invalid message" };
    }

    // The relayer pays XLM for every completion; a floor keeps dust burns from draining it.
    if (opts.minAmount !== undefined && burn.amount < opts.minAmount) {
      return {
        status: "refused",
        reason: `Xebra completes transfers of at least ${Number(opts.minAmount) / 1e6} USDC. Smaller ones can be claimed by anyone who pays the Stellar fee.`,
      };
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
    const server = stellarRpc();
    const account = await server.getAccount(keypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: "1000000",
      networkPassphrase: env.stellarNetworkPassphrase,
    })
      .addOperation(mintCall(att))
      .setTimeout(180)
      .build();

    const prep = await prepareMintTransaction(server, tx, "completeBurn");
    if (!prep.ok) {
      if (prep.delivered) return { status: "delivered" };
      return {
        status: "refused",
        reason: `${prep.reason} If the USDC has already arrived, it was completed earlier.`,
      };
    }
    const prepared = prep.prepared;
    prepared.sign(keypair);
    const sent = await server.sendTransaction(prepared);
    switch (sent.status) {
      case "PENDING":
      case "DUPLICATE": {
        // stellar-sdk 13 cannot decode protocol 23+ result meta, so confirm through Horizon's JSON.
        // Once sendTransaction succeeded, always return `{ status: "submitted", hash }` even if
        // confirmation cannot be read.
        const confirmed = await confirmViaHorizon(
          sent.hash,
          opts.confirmTimeoutMs,
          opts.confirmPollMs,
        ).catch((err) => {
          console.error("[stellar-side] Horizon confirmation failed", err);
          return null;
        });
        if (!confirmed) return { status: "submitted", hash: sent.hash };
        if (confirmed.successful) {
          return { status: "submitted", hash: sent.hash, ledger: confirmed.ledger };
        }
        // Failed on chain. If another instance completed the same message first, the nonce is now used
        // and the USDC has arrived: tell the caller it was delivered, not that it failed.
        if ((await mintState(att, keypair.publicKey())) === "delivered") {
          return { status: "delivered" };
        }
        return { status: "failed", hash: sent.hash, ledger: confirmed.ledger };
      }
      case "TRY_AGAIN_LATER":
        return {
          status: "pending",
          retryAfterMs: RETRY_AFTER_MS,
          reason: "Stellar is busy and declined to queue the mint right now. Try again shortly.",
        };
      default:
        return {
          status: "failed",
          reason: describeRejectedTransaction(sent, "mint", keypair.publicKey()),
        };
    }
  } finally {
    inFlight.delete(key);
  }
}

const HORIZON_POLL_TIMEOUT_MS = 5_000;

export async function confirmViaHorizon(
  hash: string,
  timeoutMs = 45_000,
  pollMs = 2_500,
): Promise<{ successful: boolean; ledger: number } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${env.horizonUrl}/transactions/${hash}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(HORIZON_POLL_TIMEOUT_MS),
      });
      if (r.ok) {
        const t = (await r.json()) as { successful: boolean; ledger: number };
        return { successful: t.successful, ledger: t.ledger };
      }
      if (r.status === 429 || r.status >= 500) {
        console.error(`[stellar-side] Horizon confirmation returned ${r.status} for ${hash}`);
      }
    } catch (err) {
      console.error(`[stellar-side] Horizon confirmation error for ${hash}`, err);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((res) => setTimeout(res, Math.min(pollMs, remaining)));
  }
  return null;
}
