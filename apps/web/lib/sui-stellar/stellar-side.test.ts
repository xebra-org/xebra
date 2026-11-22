import { Account, Keypair, Networks, StrKey, nativeToScVal } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The relayer, and the person receiving the mint. Both are throwaway keys.
const relayer = Keypair.random();
const recipient = Keypair.random().publicKey();

const getAccount = vi.fn();
const simulateTransaction = vi.fn();
const prepareTransaction = vi.fn();
const sendTransaction = vi.fn();

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  class Server {
    getAccount = getAccount;
    simulateTransaction = simulateTransaction;
    prepareTransaction = prepareTransaction;
    sendTransaction = sendTransaction;
  }
  return {
    ...sdk,
    rpc: {
      ...sdk.rpc,
      Server,
      assembleTransaction: () => ({ build: () => ({ sign: vi.fn() }) }),
    },
  };
});

vi.mock("../env", () => ({
  env: {
    sorobanRpcUrl: "http://soroban.test",
    horizonUrl: "http://horizon.test",
    stellarNetworkPassphrase: Networks.TESTNET,
    usdcSacAddress: StrKey.encodeContract(Buffer.alloc(32, 1)),
    cctpTokenMessengerId: "messenger",
  },
}));

vi.mock("../aptos/config", () => ({
  APTOS_CCTP_DOMAIN: 9,
  aptosDestinations: () => [],
}));

vi.mock("./attestation", () => ({
  readAttestation: async () => ({ state: "complete", message: "0x00", attestation: "0x00" }),
}));

vi.mock("@xebra/sdk/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@xebra/sdk/core")>();
  return { ...core, verifyMessage: () => ({ recipient, amount: 5_000_000n }) };
});

const { completeBurn } = await import("./stellar-side");

const DIGEST = "8JD7n6LKxQWj3sR5gYVd4XcFz2pNhT9mUeAbCqKoLiPs";
const HASH = "ab".repeat(32);

/** The recipient holds a USDC trustline. */
const balanceSim = { result: { retval: nativeToScVal(0n, { type: "i128" }) } };
/** Circle's transmitter refuses a message whose nonce is already used: the mint has happened. */
const alreadyMinted = { error: "HostError: Error(Contract, #6908)" };
/** The mint would still go through: nobody has completed it. */
const stillOpen = { result: { retval: nativeToScVal(null) } };

function horizonSays(successful: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ successful, ledger: 4242 }) })),
  );
}

beforeEach(() => {
  getAccount.mockReset().mockImplementation(async (id: string) => new Account(id, "1"));
  simulateTransaction.mockReset();
  prepareTransaction.mockReset().mockResolvedValue({ sign: vi.fn() });
  sendTransaction.mockReset().mockResolvedValue({ status: "PENDING", hash: HASH });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("completeBurn when the transaction fails on chain", () => {
  it("reports delivered when another instance already completed the same mint", async () => {
    horizonSays(false);
    // Recipient trustline check, pre-send mint simulation, then post-failure mint state check.
    simulateTransaction
      .mockResolvedValueOnce(balanceSim)
      .mockResolvedValueOnce(stillOpen)
      .mockResolvedValueOnce(alreadyMinted);

    const result = await completeBurn(DIGEST, relayer.secret());

    expect(result).toEqual({ status: "delivered" });
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(simulateTransaction).toHaveBeenCalledTimes(3);
  });

  it("still reports failed when the mint has not happened", async () => {
    horizonSays(false);
    simulateTransaction
      .mockResolvedValueOnce(balanceSim)
      .mockResolvedValueOnce(stillOpen)
      .mockResolvedValueOnce(stillOpen);

    expect(await completeBurn(DIGEST, relayer.secret())).toEqual({
      status: "failed",
      hash: HASH,
      ledger: 4242,
    });
  });

  it("still reports failed when the mint state cannot be read", async () => {
    horizonSays(false);
    simulateTransaction
      .mockResolvedValueOnce(balanceSim)
      .mockResolvedValueOnce(stillOpen)
      .mockRejectedValueOnce(new Error("rpc down"));

    expect(await completeBurn(DIGEST, relayer.secret())).toMatchObject({ status: "failed" });
  });
});

describe("completeBurn when the transaction succeeds", () => {
  it("reports submitted and does not re-check the mint state", async () => {
    horizonSays(true);
    simulateTransaction.mockResolvedValueOnce(balanceSim).mockResolvedValueOnce(stillOpen);

    expect(await completeBurn(DIGEST, relayer.secret())).toEqual({
      status: "submitted",
      hash: HASH,
      ledger: 4242,
    });
    expect(simulateTransaction).toHaveBeenCalledTimes(2);
  });
});
