import type { IntentV2 } from "@xebra/intent-schema";
import type { Logger } from "pino";
import type { Journal } from "./journal.js";

/**
 * The solver's Watch->Fill->Claim pipeline (docs/architecture.md §7), generalized as
 * `FillAdapter`/`ClaimAdapter` interfaces so this orchestration logic is chain-agnostic and
 * fully unit-testable without a live Jupiter API or Soroban RPC connection — the same
 * separation pattern used throughout this codebase (the indexers' poll functions).
 * `apps/solver/src/adapters/*` supplies the concrete per-corridor implementations; `index.ts`
 * wires the one pair that exists (Solana fill, Stellar claim).
 */

export interface FillQuote {
  canFill: boolean;
  /** Only meaningful when `canFill` is true. */
  deliveredAmount: bigint;
  reason?: string;
}

export interface FillResult {
  /** The destination-chain delivery transaction reference (e.g. a Solana tx signature). */
  destTxRef: string;
  deliveredAmount: bigint;
}

export interface ClaimResult {
  /** The source-chain claim transaction reference. */
  claimTxRef: string;
}

export interface FillAdapter {
  /** Checks profitability/inventory without submitting anything. */
  quote(intent: IntentV2): Promise<FillQuote>;
  /** Delivers `destAsset` to `destAddress`, binding the intent hash into the delivery tx
   *  (memo, or whatever the destination chain's proof convention is). */
  fill(intent: IntentV2, intentHash: string): Promise<FillResult>;
}

export interface ClaimAdapter {
  /** Posts the solver's bond and asserts delivery on the source-chain escrow. */
  claim(intentHash: string, fill: FillResult): Promise<ClaimResult>;
}

/** What the chain says about an intent right now. The solver never trusts the event it read. */
export interface EscrowGate {
  /** `null` when the contract has no such escrow. Throws when the chain could not be read. */
  read(intentHash: string): Promise<{ status: string; expiry: bigint } | null>;
}

export type FillOutcome =
  | { status: "filled"; destTxRef: string; claimTxRef: string; deliveredAmount: bigint }
  | { status: "skipped"; reason: string }
  | { status: "failed"; stage: "check" | "fill" | "claim"; error: string };

/** Delivering on Solana and claiming on Stellar both take time; do not start an intent that cannot finish. */
export const DEFAULT_MIN_SECONDS_TO_EXPIRY = 180;

export interface ProcessDeps {
  fill: FillAdapter;
  claim: ClaimAdapter;
  logger: Logger;
  /** Re-reads the escrow before spending anything. Omit only in tests. */
  escrow?: EscrowGate;
  /** Remembers deliveries across restarts so a crash cannot cause a second one. */
  journal?: Journal;
  /** Unix seconds. */
  now?: () => number;
  minSecondsToExpiry?: number;
}

export async function processOpenedIntent(
  intentHash: string,
  intent: IntentV2,
  deps: ProcessDeps,
): Promise<FillOutcome> {
  const prior = deps.journal?.get(intentHash);
  if (prior?.claimTxRef) {
    return { status: "skipped", reason: "already filled and claimed by this solver" };
  }

  // Delivered on a previous run but never claimed: do not deliver again, only retry the claim,
  // and not even that once the chain says the escrow is no longer Open (the claim may have landed
  // while the confirmation was lost, which is exactly what stellar-sdk 13 did on testnet).
  if (prior) {
    if (deps.escrow) {
      try {
        const escrow = await deps.escrow.read(intentHash);
        if (!escrow || escrow.status !== "Open") {
          return {
            status: "skipped",
            reason: `delivery recorded; escrow is ${escrow?.status ?? "missing"}, not retrying the claim`,
          };
        }
      } catch (err) {
        return { status: "failed", stage: "check", error: describeError(err) };
      }
    }
    deps.logger.warn(
      { intentHash, destTxRef: prior.destTxRef },
      "solver: found an unclaimed delivery in the journal, retrying the claim only",
    );
    return claimDelivery(
      intentHash,
      { destTxRef: prior.destTxRef, deliveredAmount: prior.deliveredAmount },
      deps,
    );
  }

  if (deps.escrow) {
    let escrow: { status: string; expiry: bigint } | null;
    try {
      escrow = await deps.escrow.read(intentHash);
    } catch (err) {
      const error = describeError(err);
      deps.logger.error({ intentHash, error }, "solver: could not read the escrow, not filling");
      return { status: "failed", stage: "check", error };
    }
    if (!escrow) return { status: "skipped", reason: "no such escrow on chain" };
    if (escrow.status !== "Open") {
      return { status: "skipped", reason: `escrow is ${escrow.status}, not Open` };
    }
    const now = BigInt((deps.now ?? defaultNow)());
    const margin = BigInt(deps.minSecondsToExpiry ?? DEFAULT_MIN_SECONDS_TO_EXPIRY);
    if (escrow.expiry < now + margin) {
      return { status: "skipped", reason: "expires too soon to deliver and claim" };
    }
  }

  const quote = await deps.fill.quote(intent);
  if (!quote.canFill) {
    deps.logger.info({ intentHash, reason: quote.reason }, "solver: skipping unprofitable intent");
    return { status: "skipped", reason: quote.reason ?? "not profitable" };
  }

  let fillResult: FillResult;
  try {
    fillResult = await deps.fill.fill(intent, intentHash);
  } catch (err) {
    // Fill failed before any delivery happened — same as the spec's "thin DEX liquidity" failure
    // mode: fails atomically on the solver's side before any claim exists, no funds at risk.
    const error = describeError(err);
    deps.logger.error({ intentHash, error }, "solver: fill failed");
    return { status: "failed", stage: "fill", error };
  }

  deps.logger.info({ intentHash, destTxRef: fillResult.destTxRef }, "solver: delivered, claiming");

  try {
    await deps.journal?.recordFill(intentHash, fillResult);
  } catch (err) {
    // The money has moved. Do not stop: claim now, and make the failure impossible to miss.
    deps.logger.error(
      { intentHash, destTxRef: fillResult.destTxRef, error: describeError(err) },
      "solver: delivered but could not write the journal — do not restart before the claim lands",
    );
  }

  return claimDelivery(intentHash, fillResult, deps);
}

async function claimDelivery(
  intentHash: string,
  fillResult: FillResult,
  deps: ProcessDeps,
): Promise<FillOutcome> {
  try {
    const claimResult = await deps.claim.claim(intentHash, fillResult);
    try {
      await deps.journal?.recordClaim(intentHash, claimResult.claimTxRef);
    } catch (err) {
      deps.logger.error(
        { intentHash, claimTxRef: claimResult.claimTxRef, error: describeError(err) },
        "solver: claimed but could not write the journal",
      );
    }
    return {
      status: "filled",
      destTxRef: fillResult.destTxRef,
      claimTxRef: claimResult.claimTxRef,
      deliveredAmount: fillResult.deliveredAmount,
    };
  } catch (err) {
    // Per the spec's failure-mode table: "solver delivers but never claims: user keeps the
    // delivery, solver eats the loss. Solver's problem by design." — this is a real loss for
    // the solver, but not a protocol-level failure; log loudly (lost margin) rather than crash.
    const error = describeError(err);
    deps.logger.error({ intentHash, error }, "solver: delivered but claim failed — margin lost");
    return { status: "failed", stage: "claim", error };
  }
}

function defaultNow(): number {
  return Math.floor(Date.now() / 1000);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
