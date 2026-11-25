import { Account, Keypair, StrKey, type rpc } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BridgeChainConfig,
  BridgeSubmitError,
  classifyStellarSubmitError,
  quoteBridge,
} from "./cctp-bridge";

const { mockServer } = vi.hoisted(() => ({
  mockServer: {
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
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

const SOURCE = Keypair.random().publicKey();
const WRAPPER = StrKey.encodeContract(Buffer.alloc(32, 7));

const config: BridgeChainConfig = {
  horizonUrl: "https://horizon.example.test",
  wrapperContractId: WRAPPER,
  cctpTokenMessengerId: StrKey.encodeContract(Buffer.alloc(32, 8)),
  usdcSacAddress: StrKey.encodeContract(Buffer.alloc(32, 9)),
  sorobanRpcUrl: "https://rpc.example.test",
  networkPassphrase: "Public Global Stellar Network ; September 2015",
  destinationDomain: 5,
};

const simError = (error: string): rpc.Api.SimulateTransactionErrorResponse => ({
  id: "sim-err",
  latestLedger: 65_400_000,
  error,
  events: [],
  _parsed: true,
});

async function quoteError(): Promise<unknown> {
  return quoteBridge(config, SOURCE, 10_000_000n, false, 0n).catch((e: unknown) => e);
}

describe("quoteBridge refusals", () => {
  beforeEach(() => {
    mockServer.getAccount.mockResolvedValue(new Account(SOURCE, "1"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("throws a raw simulation log as BridgeSubmitError, kept whole and never read as a decline", async () => {
    // What the re-quote hands back when humanizeContractError has no match: the raw diagnostics.
    const raw = [
      "HostError: Error(Auth, InvalidAction)",
      "Event log (newest first):",
      '  0: [Diagnostic Event] topics:[fn_return, quote], data:"request denied by user policy"',
      "simulation failed",
    ].join("\n");
    mockServer.simulateTransaction.mockResolvedValue(simError(raw));

    const caught = await quoteError();
    expect(caught).toBeInstanceOf(BridgeSubmitError);
    expect(classifyStellarSubmitError(caught)).toEqual({
      kind: "unknown",
      message: raw,
      maybeSent: false,
      raw,
    });
  });

  it("throws a missing quote as BridgeSubmitError with its own message", async () => {
    mockServer.simulateTransaction.mockResolvedValue({
      id: "sim-ok",
      latestLedger: 65_400_000,
      events: [],
      _parsed: true,
    });

    const caught = await quoteError();
    expect(caught).toBeInstanceOf(BridgeSubmitError);
    expect(classifyStellarSubmitError(caught)).toMatchObject({
      kind: "unknown",
      message: "The bridge did not return a quote.",
      maybeSent: false,
    });
  });

  it("throws an unconfigured wrapper as BridgeSubmitError before calling the network", async () => {
    const caught = await quoteBridge(
      { ...config, wrapperContractId: null },
      SOURCE,
      10_000_000n,
      false,
      0n,
    ).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(BridgeSubmitError);
    expect((caught as Error).message).toBe("The bridge contract is not configured.");
    expect(mockServer.getAccount).not.toHaveBeenCalled();
  });
});
