import { checkSolanaAddress, formatUsdc6 } from "@xebra/sdk/core";
import { solanaMaxUsdcBase } from "./config";

/**
 * The refusals a Solana burn can meet before it is built, kept apart from `server.ts` so that reading
 * them loads no RPC client and no environment.
 */

/** A refusal with the HTTP status it maps to and, for a moved fee, the new one. */
export class SolanaSourceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 422 | 502 | 503,
    readonly code:
      | "invalid_request"
      | "invalid_recipient"
      | "amount_below_minimum"
      | "amount_above_maximum"
      | "insufficient_balance"
      | "fee_above_limit"
      | "transaction_rejected"
      | "upstream_unavailable",
    readonly extra: { maxFee?: bigint; have?: bigint; need?: bigint; minimum?: bigint } = {},
  ) {
    super(message);
  }
}

/** The checks every Solana burn gets, whatever its destination. */
export function checkSolanaSend(sender: string, amount: bigint): void {
  if (!checkSolanaAddress(sender).ok) {
    throw new SolanaSourceError("That is not a Solana address.", 400, "invalid_request");
  }
  if (amount <= 0n) {
    throw new SolanaSourceError(
      "Enter an amount of USDC, up to 6 decimals.",
      400,
      "invalid_request",
    );
  }
  const cap = solanaMaxUsdcBase();
  if (cap !== null && amount > cap) {
    throw new SolanaSourceError(
      `The limit is ${formatUsdc6(cap)} USDC per transfer.`,
      422,
      "amount_above_maximum",
    );
  }
}
