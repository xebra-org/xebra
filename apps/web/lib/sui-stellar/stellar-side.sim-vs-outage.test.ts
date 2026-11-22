import { Keypair, nativeToScVal, type rpc } from "@stellar/stellar-sdk";
import { verifyMessage } from "@xebra/sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttestation } from "./attestation";
import { completeBurn, planClaim } from "./stellar-side";

const { mockServer } = vi.hoisted(() => ({
  mockServer: {
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
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
const PAYER = Keypair.random().publicKey();
const RECIPIENT = Keypair.random().publicKey();
const RELAYER_SECRET = Keypair.random().secret();

const simError = (error: string): rpc.Api.SimulateTransactionErrorResponse => ({
  id: "sim-err",
  latestLedger: 65_400_000,
  error,
  events: [],
  _parsed: true,
});

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
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("stellar-side simulation refusal vs RPC outage", () => {
  it("planClaim returns a fixed refusal without raw SDK text and logs raw text server-side", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rawError = "HostError: Error(WasmVm, InvalidAction) internal diagnostic trace xyz";
    mockServer.simulateTransaction
      .mockResolvedValueOnce(balanceSimSuccess())
      .mockResolvedValueOnce(simError(rawError));

    const res = await planClaim(DIGEST, PAYER);
    expect(res).toEqual({
      ok: false,
      reason: "Stellar would not accept this mint.",
    });
    expect(errSpy).toHaveBeenCalledWith("[stellar-side] planClaim simulation refused", rawError);
  });

  it("planClaim includes decoded contract error code without raw trace", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockServer.simulateTransaction
      .mockResolvedValueOnce(balanceSimSuccess())
      .mockResolvedValueOnce(
        simError("HostError: Error(Contract, #7001)\nEvent log: sensitive-internal-trace"),
      );

    const res = await planClaim(DIGEST, PAYER);
    expect(res).toEqual({
      ok: false,
      reason: "Stellar would not accept this mint (contract error #7001).",
    });
    expect((res as { reason: string }).reason).not.toContain("sensitive-internal-trace");
  });

  it("planClaim marks nonce-already-used as delivered", async () => {
    mockServer.simulateTransaction
      .mockResolvedValueOnce(balanceSimSuccess())
      .mockResolvedValueOnce(simError("HostError: Error(Contract, #6908)"));

    expect(await planClaim(DIGEST, PAYER)).toEqual({
      ok: false,
      reason: "This transfer was already completed.",
      delivered: true,
    });
  });

  it("planClaim rethrows RPC transport outages instead of returning refused", async () => {
    mockServer.simulateTransaction
      .mockResolvedValueOnce(balanceSimSuccess())
      .mockRejectedValueOnce(new Error("connect ETIMEDOUT 10.0.0.1:443"));

    await expect(planClaim(DIGEST, PAYER)).rejects.toThrow("connect ETIMEDOUT");
  });

  it("completeBurn returns fixed refusal on simulation error and rethrows RPC outages", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockServer.simulateTransaction
      .mockResolvedValueOnce(balanceSimSuccess())
      .mockResolvedValueOnce(simError("HostError: Error(Contract, #42) raw-stack"));

    const refused = await completeBurn(DIGEST, RELAYER_SECRET);
    expect(refused).toEqual({
      status: "refused",
      reason:
        "Stellar would not accept this mint (contract error #42). If the USDC has already arrived, it was completed earlier.",
    });
    expect(errSpy).toHaveBeenCalled();

    mockServer.simulateTransaction
      .mockResolvedValueOnce(balanceSimSuccess())
      .mockRejectedValueOnce(new Error("AxiosError: timeout of 5000ms exceeded"));

    await expect(completeBurn(DIGEST, RELAYER_SECRET)).rejects.toThrow("timeout of 5000ms");
  });
});
