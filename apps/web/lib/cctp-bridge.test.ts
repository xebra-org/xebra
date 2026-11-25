import type { rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BridgeSubmitError,
  UncertainSubmitError,
  classifyStellarSubmitError,
  describeRejectedTransaction,
  humanizeContractError,
  submitSigned,
} from "./cctp-bridge";

const HASH_HEX = "b".repeat(64);
const HORIZON_URL = "https://horizon.example.test";

type SignedTxArg = Parameters<rpc.Server["sendTransaction"]>[0];

function fakeSignedTx(): SignedTxArg {
  return {
    hash: () => Buffer.from(HASH_HEX, "hex"),
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  } as unknown as SignedTxArg;
}

function fakeServerThatThrows(err: Error): rpc.Server {
  return {
    sendTransaction: vi.fn().mockRejectedValue(err),
  } as unknown as rpc.Server;
}

describe("submitSigned", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("recovers and returns the precomputed hash when sendTransaction throws but Horizon finds the tx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ successful: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const server = fakeServerThatThrows(new Error("network socket closed"));
    const result = await submitSigned(server, fakeSignedTx(), "bridge transaction", undefined, {
      horizonUrl: HORIZON_URL,
      recoveryTimeoutMs: 50,
      recoveryIntervalMs: 5,
    });

    expect(result).toEqual({ txHash: HASH_HEX });
    expect(fetchMock).toHaveBeenCalledWith(
      `${HORIZON_URL}/transactions/${HASH_HEX}`,
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("throws an error carrying the hash and safe retry guidance when Horizon never sees the tx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });
    vi.stubGlobal("fetch", fetchMock);

    const server = fakeServerThatThrows(new Error("timeout sending tx"));

    let caught: unknown;
    try {
      await submitSigned(server, fakeSignedTx(), "bridge transaction", undefined, {
        horizonUrl: HORIZON_URL,
        recoveryTimeoutMs: 25,
        recoveryIntervalMs: 5,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(UncertainSubmitError);
    const uncertain = caught as UncertainSubmitError;
    expect(uncertain.txHash).toBe(HASH_HEX);
    expect(uncertain.message).toContain(HASH_HEX);
    expect(uncertain.message).toMatch(/may have gone out/i);
    expect(uncertain.message).toMatch(/before retrying/i);
  });

  it("throws an error carrying the hash when polling Horizon fails during recovery", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Horizon offline"));
    vi.stubGlobal("fetch", fetchMock);

    const server = fakeServerThatThrows(new Error("RPC unreachable"));

    await expect(
      submitSigned(server, fakeSignedTx(), "bridge transaction", undefined, {
        horizonUrl: HORIZON_URL,
        recoveryTimeoutMs: 25,
        recoveryIntervalMs: 5,
      }),
    ).rejects.toMatchObject({
      name: "UncertainSubmitError",
      txHash: HASH_HEX,
      message: expect.stringContaining("may have gone out"),
    });
  });
});

describe("classifyStellarSubmitError", () => {
  const WRAPPER = "CCNWLGFMILJU476RZHDA2PSUH2WH3LIPERHS6BYPCRVDDYYNNUIKZMTJ";
  const OTHER_CONTRACT = "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL";

  const failure = (name: string) => ({
    errorResult: { result: () => ({ switch: () => ({ name }) }) },
  });

  it("keeps UncertainSubmitError hash-bearing message and marks maybeSent=true", () => {
    const hash = "a".repeat(64);
    const err = new UncertainSubmitError(hash, "burn", new Error("socket hang up"));
    const classified = classifyStellarSubmitError(err);

    expect(classified).toEqual({
      kind: "network",
      message: err.message,
      maybeSent: true,
      raw: err.message,
    });
    expect(classified.message).toContain(hash);
  });

  it("preserves Soroban TRY_AGAIN_LATER refusals instead of misclassifying them as wallet declines", () => {
    const msg =
      "The network declined to queue the burn right now (TRY_AGAIN_LATER). Nothing has moved. Wait a few seconds and try again.";
    const classified = classifyStellarSubmitError(new BridgeSubmitError(msg));

    expect(classified).toEqual({
      kind: "unknown",
      message: msg,
      maybeSent: false,
      raw: msg,
    });
  });

  it("passes describeRejectedTransaction fallback messages containing 'rejected' through unchanged", () => {
    const codedMsg = describeRejectedTransaction(failure("txInternalError"), "bridge transaction");
    expect(codedMsg).toContain("The network rejected the bridge transaction (txInternalError)");
    expect(classifyStellarSubmitError(new BridgeSubmitError(codedMsg))).toEqual({
      kind: "unknown",
      message: codedMsg,
      maybeSent: false,
      raw: codedMsg,
    });

    const uncodedMsg = describeRejectedTransaction({}, "bridge transaction");
    expect(uncodedMsg).toContain("The network rejected the bridge transaction.");
    expect(classifyStellarSubmitError(new BridgeSubmitError(uncodedMsg))).toEqual({
      kind: "unknown",
      message: uncodedMsg,
      maybeSent: false,
      raw: uncodedMsg,
    });
  });

  it("passes humanizeContractError refusal messages containing 'rejected' through unchanged", () => {
    const wrapperRejected = humanizeContractError(
      `HostError: Error(Contract, #99)\n   0: [Diagnostic Event] contract:${WRAPPER}, topics:[error, Error(Contract, #99)]`,
      WRAPPER,
    );
    expect(wrapperRejected).toBe(
      "The bridge rejected this transfer (code 99). No funds have moved.",
    );
    expect(classifyStellarSubmitError(new BridgeSubmitError(wrapperRejected))).toEqual({
      kind: "unknown",
      message: wrapperRejected,
      maybeSent: false,
      raw: wrapperRejected,
    });

    const foreignRejected = humanizeContractError(
      `HostError: Error(Contract, #12)\n   0: [Diagnostic Event] contract:${OTHER_CONTRACT}, topics:[error, Error(Contract, #12)]`,
      WRAPPER,
    );
    expect(foreignRejected).toBe(
      "The transfer was rejected by contract CAE2G5Z7… (code 12). No funds have moved.",
    );
    expect(classifyStellarSubmitError(new BridgeSubmitError(foreignRejected))).toEqual({
      kind: "unknown",
      message: foreignRejected,
      maybeSent: false,
      raw: foreignRejected,
    });
  });

  it("passes app messages longer than 150 characters (such as txTooLate) through unchanged", () => {
    const tooLateMsg = describeRejectedTransaction(failure("txTooLate"), "bridge transaction");
    expect(tooLateMsg.length).toBeGreaterThan(150);

    const classified = classifyStellarSubmitError(new BridgeSubmitError(tooLateMsg));
    expect(classified).toEqual({
      kind: "unknown",
      message: tooLateMsg,
      maybeSent: false,
      raw: tooLateMsg,
    });
  });

  it("passes mapped describeRejectedTransaction and humanizeContractError messages through unchanged", () => {
    const badAuthMsg = describeRejectedTransaction(
      failure("txBadAuth"),
      "bridge transaction",
      "GBFI4X5EXAMPLEACCOUNTADDRESSFORTESTINGONLYAAAAAAAAAAWXYZ",
    );
    expect(classifyStellarSubmitError(new BridgeSubmitError(badAuthMsg))).toEqual({
      kind: "unknown",
      message: badAuthMsg,
      maybeSent: false,
      raw: badAuthMsg,
    });

    const minAmountMsg = humanizeContractError(
      `HostError: Error(Contract, #12)\n   0: [Diagnostic Event] contract:${WRAPPER}, topics:[error, Error(Contract, #12)]`,
      WRAPPER,
    );
    expect(classifyStellarSubmitError(new BridgeSubmitError(minAmountMsg))).toEqual({
      kind: "unknown",
      message: minAmountMsg,
      maybeSent: false,
      raw: minAmountMsg,
    });
  });

  it("delegates wallet declines and network timeouts to classifyWalletError", () => {
    expect(classifyStellarSubmitError({ code: 4001, message: "User rejected" }).kind).toBe(
      "declined",
    );
    expect(classifyStellarSubmitError(new Error("User declined access")).kind).toBe("declined");
    const timedOut = classifyStellarSubmitError(new Error("Request timed out"));
    expect(timedOut.kind).toBe("timeout");
    expect(timedOut.maybeSent).toBe(true);
  });

  it("keeps a raw multi-line simulation error containing 'denied' whole, as an alarm", () => {
    // What humanizeContractError hands back when nothing matches: the raw Soroban diagnostics.
    const raw = [
      "HostError: Error(Auth, InvalidAction)",
      "Event log (newest first):",
      '  0: [Diagnostic Event] topics:[error, Error(Auth, InvalidAction)], data:"escalating error to panic"',
      '  1: [Diagnostic Event] topics:[fn_return, transfer], data:"auth denied for operation"',
      "simulation failed",
    ].join("\n");
    expect(humanizeContractError(raw, "CWRAPPER")).toBe(raw);

    const classified = classifyStellarSubmitError(
      new BridgeSubmitError(humanizeContractError(raw, "CWRAPPER")),
    );
    expect(classified).toEqual({ kind: "unknown", message: raw, maybeSent: false, raw });
    expect(classified.message.split("\n")).toHaveLength(5);
  });

  it("marks submitSigned's own refusals as BridgeSubmitError", async () => {
    const server = {
      sendTransaction: vi.fn().mockResolvedValue({ status: "TRY_AGAIN_LATER", hash: HASH_HEX }),
    } as unknown as rpc.Server;
    const caught = await submitSigned(server, fakeSignedTx(), "bridge transaction").catch(
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(BridgeSubmitError);
    expect(classifyStellarSubmitError(caught).message).toMatch(/TRY_AGAIN_LATER/);
  });
});
