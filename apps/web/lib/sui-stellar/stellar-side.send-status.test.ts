import { Keypair, nativeToScVal, type rpc } from "@stellar/stellar-sdk";
import { verifyMessage } from "@xebra/sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttestation } from "./attestation";
import { completeBurn } from "./stellar-side";

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
      assembleTransaction: (tx: unknown) => ({ build: () => tx }),
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
const TX_HASH = "b".repeat(64);

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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("completeBurn sendTransaction statuses", () => {
  it("confirms via Horizon when sendTransaction returns PENDING", async () => {
    mockServer.sendTransaction.mockResolvedValue({ status: "PENDING", hash: TX_HASH });
    const fetchSpy = vi.fn(async () => Response.json({ successful: true, ledger: 65_400_500 }));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await completeBurn(DIGEST, RELAYER_SECRET);
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://horizon.example.test/transactions/${TX_HASH}`,
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(res).toEqual({ status: "submitted", hash: TX_HASH, ledger: 65_400_500 });
  });

  it("confirms via Horizon when sendTransaction returns DUPLICATE", async () => {
    mockServer.sendTransaction.mockResolvedValue({ status: "DUPLICATE", hash: TX_HASH });
    const fetchSpy = vi.fn(async () => Response.json({ successful: true, ledger: 65_400_501 }));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await completeBurn(DIGEST, RELAYER_SECRET);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ status: "submitted", hash: TX_HASH, ledger: 65_400_501 });
  });

  it("returns pending with retryAfterMs without polling Horizon on TRY_AGAIN_LATER", async () => {
    mockServer.sendTransaction.mockResolvedValue({ status: "TRY_AGAIN_LATER", hash: TX_HASH });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await completeBurn(DIGEST, RELAYER_SECRET);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: "pending", retryAfterMs: 5_000 });
  });

  it("returns failed with describeRejectedTransaction reason on ERROR without polling Horizon", async () => {
    mockServer.sendTransaction.mockResolvedValue({
      status: "ERROR",
      hash: TX_HASH,
      errorResult: { result: () => ({ switch: () => ({ name: "txBadSeq" }) }) },
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await completeBurn(DIGEST, RELAYER_SECRET);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res).toEqual({
      status: "failed",
      reason:
        "Your wallet sent another transaction in the meantime. No USDC has moved. Please try again.",
    });
  });
});
