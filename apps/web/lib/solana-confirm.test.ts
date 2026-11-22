import type { Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { SolanaTransactionError, humanizeSolanaError, waitForSignature } from "./solana-confirm";

/** A Connection whose status polls return the given answers in order, then the last one forever. */
function polling(...answers: Array<unknown | Error>): Connection {
  let i = 0;
  return {
    getSignatureStatuses: async () => {
      const answer = answers[Math.min(i++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return { context: { slot: 1 }, value: [answer] };
    },
  } as unknown as Connection;
}

const fast = { intervalMs: 1, timeoutMs: 200 };

describe("waitForSignature", () => {
  it("returns once the transaction is confirmed", async () => {
    const connection = polling(
      null,
      { confirmationStatus: "processed", err: null },
      {
        confirmationStatus: "confirmed",
        err: null,
      },
    );
    await expect(waitForSignature(connection, "sig", fast)).resolves.toBeUndefined();
  });

  it("throws for a transaction that landed and failed", async () => {
    // confirmTransaction resolved for this, and the page reported a mint that never happened.
    const connection = polling({
      confirmationStatus: "confirmed",
      err: { InstructionError: [0, 1] },
    });
    await expect(waitForSignature(connection, "sig", fast)).rejects.toThrow(/rejected/);
  });

  it("rides out a dropped poll", async () => {
    const connection = polling(new Error("fetch failed"), {
      confirmationStatus: "finalized",
      err: null,
    });
    await expect(waitForSignature(connection, "sig", fast)).resolves.toBeUndefined();
  });

  it("gives up with a message that says the transaction may still land", async () => {
    await expect(waitForSignature(polling(null), "sig", fast)).rejects.toThrow(/may still land/);
  });

  describe("mapped on-chain error handling and humanization", () => {
    it("handles insufficient funds for fee", async () => {
      const connection = polling({
        confirmationStatus: "confirmed",
        err: "InsufficientFundsForFee",
      });

      let caught: unknown = null;
      try {
        await waitForSignature(connection, "sig_fee_123", fast);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(SolanaTransactionError);
      const err = caught as SolanaTransactionError;
      expect(err.message).toContain("Solana rejected transaction sig_fee_123");
      expect(err.message).toContain("Insufficient funds for transaction fee");
      expect(err.message).toContain("No USDC moved (on-chain failures revert)");
      expect(err.message).toContain("https://solscan.io/tx/sig_fee_123");
      expect(err.raw).toBe(JSON.stringify("InsufficientFundsForFee"));
    });

    it("handles insufficient funds for rent", async () => {
      const statusErr = { InsufficientFundsForRent: { account_index: 0 } };
      const connection = polling({
        confirmationStatus: "confirmed",
        err: statusErr,
      });

      let caught: unknown = null;
      try {
        await waitForSignature(connection, "sig_rent_456", fast);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(SolanaTransactionError);
      const err = caught as SolanaTransactionError;
      expect(err.message).toContain("Solana rejected transaction sig_rent_456");
      expect(err.message).toContain("Insufficient funds for rent");
      expect(err.message).toContain("No USDC moved (on-chain failures revert)");
      expect(err.message).toContain("https://solscan.io/tx/sig_rent_456");
      expect(err.raw).toBe(JSON.stringify(statusErr));
    });

    it("handles blockhash not found or expired", async () => {
      for (const errCase of ["BlockhashNotFound", "InvalidBlockhash"]) {
        const connection = polling({
          confirmationStatus: "confirmed",
          err: errCase,
        });

        let caught: unknown = null;
        try {
          await waitForSignature(connection, "sig_bh_789", fast);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(SolanaTransactionError);
        const err = caught as SolanaTransactionError;
        expect(err.message).toContain("Blockhash expired or not found");
        expect(err.message).toContain("No USDC moved (on-chain failures revert)");
        expect(err.message).toContain("https://solscan.io/tx/sig_bh_789");
        expect(err.raw).toBe(JSON.stringify(errCase));
      }
    });

    it("handles SPL Token program Custom codes (e.g. Custom: 1 = insufficient funds)", async () => {
      const statusErr = { InstructionError: [2, { Custom: 1 }] };
      const connection = polling({
        confirmationStatus: "confirmed",
        err: statusErr,
      });

      let caught: unknown = null;
      try {
        await waitForSignature(connection, "sig_spl_token", fast);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(SolanaTransactionError);
      const err = caught as SolanaTransactionError;
      expect(err.message).toContain("Solana rejected transaction sig_spl_token");
      expect(err.message).toContain("Insufficient funds");
      expect(err.message).toContain("No USDC moved (on-chain failures revert)");
      expect(err.message).toContain("https://solscan.io/tx/sig_spl_token");
      expect(err.raw).toBe(JSON.stringify(statusErr));
    });

    it("handles CCTP program Custom codes (e.g. denylisted address and domain)", async () => {
      // 6004: Denylisted account
      const denylistErr = { InstructionError: [1, { Custom: 6004 }] };
      const conn1 = polling({
        confirmationStatus: "confirmed",
        err: denylistErr,
      });

      let caught1: unknown = null;
      try {
        await waitForSignature(conn1, "sig_cctp_deny", fast);
      } catch (err) {
        caught1 = err;
      }

      expect(caught1).toBeInstanceOf(SolanaTransactionError);
      const err1 = caught1 as SolanaTransactionError;
      expect(err1.message).toContain("Address is denylisted by Circle");
      expect(err1.message).toContain("No USDC moved (on-chain failures revert)");
      expect(err1.message).toContain("https://solscan.io/tx/sig_cctp_deny");
      expect(err1.raw).toBe(JSON.stringify(denylistErr));

      // 6000: Invalid destination domain
      const domainErr = { InstructionError: [1, { Custom: 6000 }] };
      const conn2 = polling({
        confirmationStatus: "confirmed",
        err: domainErr,
      });

      let caught2: unknown = null;
      try {
        await waitForSignature(conn2, "sig_cctp_domain", fast);
      } catch (err) {
        caught2 = err;
      }

      const err2 = caught2 as SolanaTransactionError;
      expect(err2.message).toContain("Invalid destination domain");
      expect(err2.raw).toBe(JSON.stringify(domainErr));
    });

    it("handles an unknown on-chain error gracefully", async () => {
      const statusErr = { InstructionError: [0, "SomeUnknownInstructionFailure"] };
      const connection = polling({
        confirmationStatus: "confirmed",
        err: statusErr,
      });

      let caught: unknown = null;
      try {
        await waitForSignature(connection, "sig_unknown", fast);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(SolanaTransactionError);
      const err = caught as SolanaTransactionError;
      expect(err.message).toContain("Solana rejected transaction sig_unknown");
      expect(err.message).toContain("Transaction rejected on-chain");
      expect(err.message).toContain("No USDC moved (on-chain failures revert)");
      expect(err.message).toContain("https://solscan.io/tx/sig_unknown");
      expect(err.raw).toBe(JSON.stringify(statusErr));
    });

    it("handles an unmapped custom code", async () => {
      const statusErr = { InstructionError: [0, { Custom: 8888 }] };
      const connection = polling({
        confirmationStatus: "confirmed",
        err: statusErr,
      });

      let caught: unknown = null;
      try {
        await waitForSignature(connection, "sig_unmapped_custom", fast);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(SolanaTransactionError);
      const err = caught as SolanaTransactionError;
      expect(err.message).toContain("Program error (Custom: 8888)");
      expect(err.raw).toBe(JSON.stringify(statusErr));
    });
  });

  describe("humanizeSolanaError unit tests", () => {
    it("maps common error formats directly", () => {
      expect(humanizeSolanaError("InsufficientFundsForFee")).toBe(
        "Insufficient funds for transaction fee",
      );
      expect(humanizeSolanaError({ InsufficientFundsForRent: { account_index: 0 } })).toBe(
        "Insufficient funds for rent",
      );
      expect(humanizeSolanaError("BlockhashNotFound")).toBe("Blockhash expired or not found");
      expect(humanizeSolanaError({ InstructionError: [0, { Custom: 1 }] })).toBe(
        "Insufficient funds",
      );
      expect(humanizeSolanaError({ InstructionError: [0, { Custom: 6007 }] })).toBe(
        "Transfer fee is below Circle minimum",
      );
      expect(humanizeSolanaError({ InstructionError: [0, { Custom: 17 }] })).toBe(
        "Token account is frozen",
      );
      expect(humanizeSolanaError("SomeRandomError")).toBe("Transaction rejected on-chain");
    });
  });
});
