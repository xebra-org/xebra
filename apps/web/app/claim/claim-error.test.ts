import { describe, expect, it } from "vitest";
import { SolanaConfirmTimeoutError, SolanaTransactionError } from "../../lib/solana-confirm";
import { classifyClaimError } from "./claim-error";

describe("classifyClaimError", () => {
  it("keeps pre-send network/RPC errors as maybeSent=false with their own message", () => {
    const connectErr = classifyClaimError(new Error("fetch failed"), false);
    expect(connectErr).toEqual({
      kind: "unknown",
      message: "fetch failed",
      maybeSent: false,
      raw: "fetch failed",
    });

    const timeoutErr = classifyClaimError(new Error("Request timed out"), false);
    expect(timeoutErr.maybeSent).toBe(false);
    expect(timeoutErr.message).toBe("Request timed out");
  });

  it("preserves pre-check failure reasons verbatim with maybeSent=false", () => {
    const precheck = "Arbitrum says this mint would fail: message already received";
    const classified = classifyClaimError(new Error(precheck), false);
    expect(classified).toEqual({
      kind: "unknown",
      message: precheck,
      maybeSent: false,
      raw: precheck,
    });
  });

  it("still classifies pre-send wallet declines and popups as cancelled notices", () => {
    const declined = classifyClaimError({ code: 4001, message: "User rejected" }, false);
    expect(declined.kind).toBe("declined");
    expect(declined.maybeSent).toBe(false);
  });

  it("marks ambiguous network/timeout failures after sendClaim/submit as maybeSent=true", () => {
    const dropped = classifyClaimError(new Error("socket hang up"), true);
    expect(dropped.kind).toBe("network");
    expect(dropped.maybeSent).toBe(true);

    const timedOut = classifyClaimError(new Error("Request timed out"), true);
    expect(timedOut.kind).toBe("timeout");
    expect(timedOut.maybeSent).toBe(true);
  });

  it("keeps post-submit wallet declines and on-chain reverts accurate", () => {
    const declined = classifyClaimError({ code: 4001, message: "User rejected" }, true);
    expect(declined.kind).toBe("declined");
    expect(declined.maybeSent).toBe(false);

    const reverted = classifyClaimError(new Error("execution reverted"), true);
    expect(reverted.kind).toBe("onchain");
    expect(reverted.maybeSent).toBe(false);
  });

  it("reports a Solana mint that failed on chain as a failure, not a cancellation", () => {
    const sig = "5xFailedOnChainSig";
    const failed = new SolanaTransactionError(sig, { InstructionError: [0, { Custom: 1 }] });
    // The message says "Solana rejected transaction", which the wallet classifier reads as a decline.
    expect(failed.message).toMatch(/\brejected\b/);

    for (const handedToWallet of [true, false]) {
      const classified = classifyClaimError(failed, handedToWallet);
      expect(classified.kind).toBe("onchain");
      expect(classified.maybeSent).toBe(false);
      expect(classified.message).toBe(failed.message);
      expect(classified.message).toContain(sig);
    }
  });

  it("keeps the signature and maybeSent=true when a Solana mint is not confirmed in time", () => {
    // A real base58 signature is about 88 characters.
    const sig = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi".repeat(2);
    const timeout = new SolanaConfirmTimeoutError(sig, 90_000);
    // Longer than the wallet classifier's length limit, which would turn it into "unexpected".
    expect(timeout.message.length).toBeGreaterThan(150);

    const classified = classifyClaimError(timeout, true);
    expect(classified.kind).toBe("timeout");
    expect(classified.maybeSent).toBe(true);
    expect(classified.message).toContain(sig);
    expect(classified.message).toMatch(/may still land/);
  });
});
