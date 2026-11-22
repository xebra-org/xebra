import type { rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UncertainSubmitError, submitSigned } from "./cctp-bridge";

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
