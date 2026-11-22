import {
  Account,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WRAPPER = StrKey.encodeContract(Buffer.alloc(32, 7));
const submitSigned = vi.fn();
const serverOptions = vi.fn();

vi.mock("../../../../lib/env", () => ({
  env: {
    cctpWrapperContractId: WRAPPER,
    stellarNetworkPassphrase: Networks.TESTNET,
    sorobanRpcUrl: "https://rpc.example",
  },
}));
vi.mock("../../../../lib/cctp-bridge", () => {
  class UncertainSubmitError extends Error {
    constructor(
      readonly txHash: string,
      what: string,
    ) {
      super(`Submitting the ${what} failed. Check transaction ${txHash} before retrying.`);
    }
  }
  return {
    UncertainSubmitError,
    submitSigned: (...a: unknown[]) => submitSigned(...a),
  };
});
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  class Server {
    constructor(url: string, opts?: unknown) {
      serverOptions(url, opts);
    }
  }
  return { ...actual, rpc: { ...actual.rpc, Server } };
});

const { POST } = await import("./route");
const { UncertainSubmitError } = await import("../../../../lib/cctp-bridge");

const signedXdr = () => {
  const kp = Keypair.random();
  const tx = new TransactionBuilder(new Account(kp.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(WRAPPER).call("transfer"))
    .setTimeout(30)
    .build();
  tx.sign(kp);
  return tx.toXDR();
};

const post = async (body: unknown) => {
  const pending = POST(
    new Request("http://x/api/near-intents/submit", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  await vi.runAllTimersAsync();
  return pending;
};
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

describe("POST /api/near-intents/submit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    submitSigned.mockReset().mockResolvedValue({ txHash: "abc" });
    serverOptions.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("submits a signed transfer through the contract, with a 10s RPC timeout", async () => {
    const res = await post({ xdr: signedXdr() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ txHash: "abc" });
    expect(serverOptions).toHaveBeenCalledWith("https://rpc.example", { timeout: 10_000 });
  });

  it("refuses a body without an xdr, and one that is not a transaction", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ xdr: "not-xdr" })).status).toBe(400);
    expect(submitSigned).not.toHaveBeenCalled();
  });

  it.each([
    ["txBadSeq", "Your wallet sent another transaction in the meantime."],
    ["txInsufficientBalance", "Your wallet does not have enough XLM to cover the network fee."],
    ["txTooLate", "The signing window expired before the network accepted it."],
  ])("answers 422 with the worded reason for %s, without resending", async (_code, reason) => {
    submitSigned.mockRejectedValue(new Error(reason));
    const res = await post({ xdr: signedXdr() });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toBe(reason);
    expect(submitSigned).toHaveBeenCalledTimes(1);
  });

  it("answers 503 with Retry-After when the network keeps saying TRY_AGAIN_LATER", async () => {
    submitSigned.mockRejectedValue(
      new Error("The network declined to queue the transfer right now (TRY_AGAIN_LATER)."),
    );
    const res = await post({ xdr: signedXdr() });
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(submitSigned).toHaveBeenCalledTimes(3);
  });

  it("resends after TRY_AGAIN_LATER and returns the hash once it is queued", async () => {
    submitSigned
      .mockRejectedValueOnce(new Error("declined (TRY_AGAIN_LATER)"))
      .mockResolvedValueOnce({ txHash: "abc" });
    expect((await post({ xdr: signedXdr() })).status).toBe(200);
    expect(submitSigned).toHaveBeenCalledTimes(2);
  });

  it("answers 502 when Stellar's network cannot be reached", async () => {
    submitSigned.mockRejectedValue(new UncertainSubmitError("h", "transfer"));
    const res = await post({ xdr: signedXdr() });
    expect(res.status).toBe(502);
    expect(await errorOf(res)).toContain("Check transaction h");
    expect(submitSigned).toHaveBeenCalledTimes(3);
  });
});
