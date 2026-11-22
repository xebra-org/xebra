import type { Connection, SignatureStatus } from "@solana/web3.js";

/** Map of known SPL Token and Circle CCTP program Custom error codes. */
const CUSTOM_ERROR_MAP: Record<number, string> = {
  // SPL Token Program errors
  0: "Token account is not rent-exempt",
  1: "Insufficient funds",
  2: "Invalid token mint",
  3: "Token mint mismatch",
  4: "Token account owner mismatch",
  17: "Token account is frozen",

  // Circle CCTP (TokenMessengerMinter / MessageTransmitter) Anchor errors
  6000: "Invalid destination domain",
  6001: "Invalid destination caller",
  6002: "Invalid burn token",
  6003: "Invalid remote token messenger",
  6004: "Address is denylisted by Circle",
  6005: "Account not initialized",
  6006: "Invalid authority",
  6007: "Transfer fee is below Circle minimum",
  6008: "Transfer fee exceeds maximum allowed",
  6009: "Message already executed",
  6010: "Invalid message transmitter",
  6011: "Invalid hook data",
};

/** Extracts a Custom error code from a Solana status error, if present. */
export function extractCustomCode(err: unknown): number | null {
  if (typeof err === "number") return err;
  if (!err || typeof err !== "object") {
    if (typeof err === "string") {
      try {
        const parsed = JSON.parse(err);
        return extractCustomCode(parsed);
      } catch {
        const match = /Custom["':\s]+(\d+)/i.exec(err);
        return match ? Number(match[1]) : null;
      }
    }
    return null;
  }
  if ("InstructionError" in err) {
    const detail = (err as Record<string, unknown>).InstructionError;
    if (Array.isArray(detail)) {
      const sub = detail[1];
      if (typeof sub === "number") return sub;
      if (
        sub &&
        typeof sub === "object" &&
        "Custom" in sub &&
        typeof (sub as Record<string, unknown>).Custom === "number"
      ) {
        return (sub as Record<string, unknown>).Custom as number;
      }
    }
  }
  if ("Custom" in err && typeof (err as Record<string, unknown>).Custom === "number") {
    return (err as Record<string, unknown>).Custom as number;
  }
  return null;
}

/**
 * Humanizes a Solana on-chain transaction failure reason for display.
 */
export function humanizeSolanaError(err: unknown): string {
  const customCode = extractCustomCode(err);
  if (customCode !== null) {
    const known = CUSTOM_ERROR_MAP[customCode];
    if (known) {
      return known;
    }
    return `Program error (Custom: ${customCode})`;
  }

  const json = typeof err === "string" ? err : JSON.stringify(err ?? "");

  if (/InsufficientFundsForFee/i.test(json)) {
    return "Insufficient funds for transaction fee";
  }
  if (/InsufficientFundsForRent/i.test(json)) {
    return "Insufficient funds for rent";
  }
  if (/BlockhashNotFound|InvalidBlockhash|BlockhashExpired/i.test(json)) {
    return "Blockhash expired or not found";
  }

  return "Transaction rejected on-chain";
}

/**
 * Thrown when a transaction lands on-chain but fails.
 * Retains the humanized message, explorer link, and the raw JSON for logs.
 */
export class SolanaTransactionError extends Error {
  readonly signature: string;
  readonly raw: string;
  readonly err: unknown;

  constructor(signature: string, err: unknown) {
    const reason = humanizeSolanaError(err);
    super(
      `Solana rejected transaction ${signature}: ${reason}. No USDC moved (on-chain failures revert). See https://solscan.io/tx/${signature}`,
    );
    this.name = "SolanaTransactionError";
    this.signature = signature;
    this.err = err;
    this.raw = JSON.stringify(err);
    this.cause = err;
  }
}

/**
 * Waits for a Solana transaction by polling its status.
 *
 * `connection.confirmTransaction(sig, commitment)` waits on a websocket subscription, and the
 * browser reaches Solana through `/api/solana-rpc`, a plain HTTP route that cannot serve one, so
 * the wait can run out with an error for a transaction that landed. It also resolves, rather than
 * throws, for a transaction that landed and failed. `getSignatureStatuses` is on the proxy's
 * allow-list and reports both.
 *
 * A timeout does not mean the transaction failed, only that it was not seen in time, so the error
 * says to look it up before trying again.
 */
export async function waitForSignature(
  connection: Connection,
  signature: string,
  { timeoutMs = 90_000, intervalMs = 1_500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let status: SignatureStatus | null = null;
    try {
      status = (await connection.getSignatureStatuses([signature])).value[0] ?? null;
    } catch {
      // A dropped poll is not a verdict on the transaction; the next one decides.
    }
    if (status?.err) {
      throw new SolanaTransactionError(signature, status.err);
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Transaction ${signature} was not confirmed within ${Math.round(timeoutMs / 1000)} seconds. It may still land: look it up on Solscan before trying again.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
