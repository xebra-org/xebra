import { describe, expect, it } from "vitest";
import { humanizeContractError } from "./cctp-bridge";

/** Wrapper v1 (retired): the traces below are real mainnet traces from it. v2 reports errors the same way. */
const WRAPPER = "CCNWLGFMILJU476RZHDA2PSUH2WH3LIPERHS6BYPCRVDDYYNNUIKZMTJ";
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

/**
 * The real trace from a live mainnet attempt: an empty wallet, so USDC refused the fee transfer.
 * Both contracts report `Error(Contract, #10)` — the wrapper because the call it made failed, and
 * USDC because it was the one that refused. Newest-first, so the origin is last.
 */
const EMPTY_WALLET = `HostError: Error(Contract, #10)

Event log (newest first):
   0: [Diagnostic Event] contract:${WRAPPER}, topics:[error, Error(Contract, #10)], data:"escalating error to VM trap from failed host function call: call"
   1: [Diagnostic Event] contract:${WRAPPER}, topics:[error, Error(Contract, #10)], data:["contract call failed", transfer, [GBFI4X5E, ${WRAPPER}, 3000000]]
   2: [Failed Diagnostic Event (not emitted)] contract:${USDC}, topics:[error, Error(Contract, #10)], data:["resulting balance is not within the allowed range", 0, -3000000, 9223372036854775807]`;

const WRAPPER_REJECTED = `HostError: Error(Contract, #12)

Event log (newest first):
   0: [Diagnostic Event] contract:${WRAPPER}, topics:[error, Error(Contract, #12)], data:"escalating error to VM trap"`;

describe("humanizeContractError", () => {
  it("blames the wallet, not the bridge, when USDC refuses for balance", () => {
    // This exact trace was shown to a user as "The bridge rejected this transfer (code 10)".
    // The bridge rejected nothing — their wallet was empty. #10 happens to be
    // BadFinalityThreshold in our contract, which is why the wrong table produced a confident
    // and completely wrong answer.
    const msg = humanizeContractError(EMPTY_WALLET, WRAPPER);
    expect(msg).toMatch(/balance is too low/i);
    expect(msg).not.toMatch(/bridge rejected/i);
    expect(msg).not.toMatch(/delivery speed/i);
  });

  it("still maps our own codes when our contract threw", () => {
    expect(humanizeContractError(WRAPPER_REJECTED, WRAPPER)).toMatch(/below the minimum/i);
  });

  it("does not translate another contract's code with our table", () => {
    // Error numbers are per-contract. Circle's #12 is not our #12.
    const circle = "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL";
    const raw = `HostError: Error(Contract, #12)\n   0: [Diagnostic Event] contract:${circle}, topics:[error, Error(Contract, #12)], data:"failed"`;
    const msg = humanizeContractError(raw, WRAPPER);
    expect(msg).not.toMatch(/below the minimum/i);
    expect(msg).toMatch(/CAE2G5Z7/);
  });

  it("recognises a missing allowance", () => {
    const raw = `HostError: Error(Contract, #9)\n   0: contract:${USDC}, data:["not enough allowance to spend"]`;
    expect(humanizeContractError(raw, WRAPPER)).toMatch(/approval was not in place/i);
  });

  it("recognises a missing trustline", () => {
    expect(humanizeContractError("trustline entry is missing", WRAPPER)).toMatch(/trustline/i);
  });

  it("covers every code the contract can return on the bridge path", () => {
    // An unmapped code falls back to a number, which tells the user nothing. These are the
    // variants reachable from v2's `bridge()`, the forwarding checks (39-41) and the account
    // owner checks (43-45) included.
    for (const code of [
      2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 36, 37, 39, 40, 41, 43, 44, 45,
    ]) {
      const raw = `HostError: Error(Contract, #${code})\n   0: [Diagnostic Event] contract:${WRAPPER}, topics:[error, Error(Contract, #${code})]`;
      expect(humanizeContractError(raw, WRAPPER), `code ${code}`).not.toMatch(/code \d+/);
    }
  });

  it("degrades to the raw error rather than inventing one", () => {
    expect(humanizeContractError("something entirely unexpected", WRAPPER)).toBe(
      "something entirely unexpected",
    );
  });

  it("works without a wrapper id, for callers that do not have one", () => {
    expect(humanizeContractError(EMPTY_WALLET)).toMatch(/balance is too low/i);
  });
});

describe("describeRejectedTransaction", () => {
  const failure = (name: string) => ({
    errorResult: { result: () => ({ switch: () => ({ name }) }) },
  });

  it("explains txTooLate in plain words", async () => {
    const { describeRejectedTransaction } = await import("./cctp-bridge");
    const msg = describeRejectedTransaction(failure("txTooLate"), "bridge transaction");
    expect(msg).toMatch(/expired/i);
    expect(msg).not.toMatch(/_switch|_attributes|txTooLate/);
  });

  it("tells the person to switch back when the wallet signed with another account", async () => {
    const { describeRejectedTransaction } = await import("./cctp-bridge");
    const account = "GBFI4X5EXAMPLEACCOUNTADDRESSFORTESTINGONLYAAAAAAAAAAWXYZ";
    const msg = describeRejectedTransaction(failure("txBadAuth"), "bridge transaction", account);
    expect(msg).toBe(
      "Your wallet signed with a different account than the one connected here. Switch back to GBFI…WXYZ in your wallet, or reconnect.",
    );
    // Retrying cannot fix a wrong account, so the message must not tell them to.
    expect(msg).not.toMatch(/try again/i);
    expect(msg).not.toMatch(/\{account\}/);
  });

  it("still gives a usable txBadAuth message when no account is known", async () => {
    const { describeRejectedTransaction } = await import("./cctp-bridge");
    const msg = describeRejectedTransaction(failure("txBadAuth"), "mint");
    expect(msg).toMatch(/different account/i);
    expect(msg).toMatch(/switch back to your connected account/i);
    expect(msg).not.toMatch(/\{account\}/);
  });

  it("never dumps raw objects for unknown codes", async () => {
    const { describeRejectedTransaction } = await import("./cctp-bridge");
    expect(describeRejectedTransaction({}, "bridge transaction")).not.toMatch(/[{}]/);
  });
});
