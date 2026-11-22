import { Keypair, nativeToScVal, type rpc } from "@stellar/stellar-sdk";
import { verifyMessage } from "@xebra/sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttestation } from "./attestation";
import { completeBurn, confirmViaHorizon } from "./stellar-side";

const { mockServer } = vi.hoisted(() => ({
  mockServer: {
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
    prepareTransaction: vi.fn(),
    sendTransaction: vi.fn(),
  },
}));

vi.mock("@stellar/stellar-sdk", async (orig) => {
  const actual = await orig<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: vi.fn(() => mockServer),
      // completeBurn simulates the mint and assembles it itself (#163); the fake simulation has no
      // real transactionData, so hand back a transaction that only needs signing.
      assembleTransaction: vi.fn(() => ({ build: () => ({ sign: vi.fn() }) })),
    },
  };
});

vi.mock("./attestation", () => ({
  readAttestation: vi.fn(),
}));

vi.mock("@xebra/sdk/core", async (orig) => {
  const actual = await orig<typeof import("@xebra/sdk/core")>();
  return {
    ...actual,
    verifyMessage: vi.fn(),
  };
});

vi.mock("../env", () => ({
  env: {
    sorobanRpcUrl: "https://rpc.example.test",
    stellarNetworkPassphrase: "Public Global Stellar Network ; September 2015",
    usdcSacAddress: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    cctpTokenMessengerId: "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL",
    horizonUrl: "https://horizon.example.test",
  },
}));

const DIGEST = "37cRcRxVbwscXJAjLfqmXh19CDdKeHMBVJ1GMSqJKEE7";
const RECIPIENT = Keypair.random().publicKey();
const RELAYER_SECRET = Keypair.random().secret();
const TX_HASH = "a".repeat(64);

const balanceSimSuccess = (): rpc.Api.SimulateTransactionSuccessResponse =>
  ({
    id: "sim-bal",
    latestLedger: 65_400_000,
    result: { retval: nativeToScVal(10_000_000n, { type: "i128" }), auth: [] },
    events: [],
    transactionData: {} as never,
    minResourceFee: "100",
    _parsed: true,
  }) as unknown as rpc.Api.SimulateTransactionSuccessResponse;

beforeEach(() => {
  vi.mocked(readAttestation).mockResolvedValue({
    state: "complete",
    message: "0x01",
    attestation: "0x02",
  });
  vi.mocked(verifyMessage).mockReturnValue({
    recipient: RECIPIENT,
    amount: 5_000_000n,
  } as never);
  mockServer.getAccount.mockImplementation(async (address: string) => ({
    accountId: () => address,
    sequenceNumber: () => "100",
    incrementSequenceNumber: () => {},
  }));
  mockServer.simulateTransaction.mockResolvedValue(balanceSimSuccess());
  mockServer.prepareTransaction.mockImplementation(async (tx) => tx);
  mockServer.sendTransaction.mockResolvedValue({
    status: "PENDING",
    hash: TX_HASH,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("confirmViaHorizon and completeBurn confirmation handling", () => {
  it("aborts a hanging Horizon request with a 5s AbortSignal.timeout and still returns submitted + hash", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const origTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBe(5_000);
      return origTimeout(10);
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return;
            if (signal.aborted) return reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ),
    );

    const res = await completeBurn(DIGEST, RELAYER_SECRET, undefined, {
      confirmTimeoutMs: 35,
      confirmPollMs: 5,
    });
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    expect(res).toEqual({ status: "submitted", hash: TX_HASH });
  });

  it("handles Horizon 503 responses inside the loop and returns submitted + hash", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Service Unavailable", { status: 503 })),
    );

    const res = await completeBurn(DIGEST, RELAYER_SECRET, undefined, {
      confirmTimeoutMs: 25,
      confirmPollMs: 5,
    });
    expect(res).toEqual({ status: "submitted", hash: TX_HASH });
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Horizon confirmation returned 503 for ${TX_HASH}`),
    );
  });

  it("returns ledger and successful flag when Horizon responds 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ successful: true, ledger: 65_400_123 })),
    );

    const confirmed = await confirmViaHorizon(TX_HASH, 100, 5);
    expect(confirmed).toEqual({ successful: true, ledger: 65_400_123 });
  });
});
