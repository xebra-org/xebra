import { formatError } from "../../lib/format-error";
import { SolanaConfirmTimeoutError, SolanaTransactionError } from "../../lib/solana-confirm";
import { type ClassifiedError, classifyWalletError } from "../../lib/wallet-error";

/**
 * Classifies errors caught during `/claim` actions (`claim-client.tsx` and `evm-claim.tsx`).
 *
 * Pre-send errors (`handedToWallet = false`: wallet connect, network switch, `isAlreadyMinted`,
 * `checkClaim`, `prepareClaim`, `buildMintTransaction`) have not broadcast anything on-chain:
 * declines still render as a calm cancelled notice, while network or pre-check errors preserve
 * their own message with `maybeSent: false`.
 *
 * Once a transaction is handed to the wallet (`sendClaim` / `submit`), `handedToWallet = true`
 * delegates to `classifyWalletError` so ambiguous transport/timeout failures warn `maybeSent: true`.
 *
 * Two errors the app throws itself after broadcasting are answered before the classifier sees
 * them, because its patterns read them wrongly: a `SolanaTransactionError` ("Solana rejected
 * transaction …") is an on-chain failure, not a decline, and a `SolanaConfirmTimeoutError` is
 * longer than the classifier's length limit, but the mint may still land, so it keeps the
 * signature in its message and `maybeSent: true`.
 */
export function classifyClaimError(err: unknown, handedToWallet: boolean): ClassifiedError {
  if (err instanceof SolanaTransactionError) {
    return { kind: "onchain", message: err.message, maybeSent: false, raw: err.raw };
  }
  if (err instanceof SolanaConfirmTimeoutError) {
    return { kind: "timeout", message: err.message, maybeSent: true, raw: err.message };
  }
  if (handedToWallet) {
    return classifyWalletError(err);
  }
  const classified = classifyWalletError(err);
  if (classified.kind === "declined" || classified.kind === "popup") {
    return classified;
  }
  const message = formatError(err);
  return {
    kind: "unknown",
    message,
    maybeSent: false,
    raw: message,
  };
}
