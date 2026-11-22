import {
  Account,
  Keypair,
  Networks,
  type Transaction,
  TransactionBuilder,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { XebraError } from "../errors.js";
import {
  APPROVAL_TTL_LEDGERS,
  type StellarBuildRpc,
  StellarSimulationError,
  buildStellarBridge,
} from "./stellar.js";

const WRAPPER = "CCPVTWII2TW6VVSVA4JQ2KFHICGBG4QVAHPIGUPSIW3E4VNPUI4Y2WQR";
const USER = Keypair.random().publicKey();
const LATEST = 65_400_000;

function fakeRpc(
  over: Partial<StellarBuildRpc> = {},
): StellarBuildRpc & { prepared: Transaction[] } {
  const prepared: Transaction[] = [];
  return {
    prepared,
    getAccount: async (id) => new Account(id, "100"),
    getLatestLedger: async () => ({ sequence: LATEST }),
    prepareTransaction: async (tx) => {
      prepared.push(tx);
      return tx;
    },
    ...over,
  };
}

const INPUT = {
  user: USER,
  amount: 100_000_000n,
  destinationDomain: 6,
  mintRecipient: new Uint8Array(32).fill(7),
  maxFee: 2_500_000n,
  maxWrapperFee: 6_000_000n,
  minFinalityThreshold: 2000,
  recipientNeedsAccount: false,
  recipientOwner: null,
  ttlSeconds: 600,
};

function bridgeArgs(xdrB64: string) {
  const tx = TransactionBuilder.fromXDR(xdrB64, Networks.PUBLIC) as Transaction;
  const op = tx.operations[0];
  if (op?.type !== "invokeHostFunction") throw new Error("not an invocation");
  const call = op.func.invokeContract();
  return {
    tx,
    fn: call.functionName().toString(),
    request: scValToNative(call.args()[0] as xdr.ScVal) as Record<string, unknown>,
  };
}

describe("buildStellarBridge", () => {
  it("returns the prepared bridge() call, sourced from the user, for the wallet to sign", async () => {
    const rpc = fakeRpc();
    const step = await buildStellarBridge(
      rpc,
      { wrapperContractId: WRAPPER, networkPassphrase: Networks.PUBLIC },
      INPUT,
    );
    expect(rpc.prepared).toHaveLength(1);
    expect(step).toMatchObject({ id: "burn", chain: "stellar" });
    if (step.tx.kind !== "stellar") throw new Error("wrong kind");
    expect(step.tx.networkPassphrase).toBe(Networks.PUBLIC);
    const { tx, fn, request } = bridgeArgs(step.tx.xdr);
    expect(tx.source).toBe(USER);
    expect(fn).toBe("bridge");
    expect(request.amount).toBe(INPUT.amount);
    expect(request.destination_domain).toBe(6);
    expect(request.approval_expiration_ledger).toBe(LATEST + APPROVAL_TTL_LEDGERS);
  });

  it("expires when the transaction's own time bound does", async () => {
    const now = 1_800_000_000_000;
    const step = await buildStellarBridge(
      fakeRpc(),
      { wrapperContractId: WRAPPER, networkPassphrase: Networks.PUBLIC },
      INPUT,
      now,
    );
    if (step.tx.kind !== "stellar") throw new Error("wrong kind");
    const maxTime = Number(bridgeArgs(step.tx.xdr).tx.timeBounds?.maxTime);
    expect(step.expiresAt).toBe(new Date(maxTime * 1000).toISOString());
    expect(maxTime).toBeGreaterThan(now / 1000);
  });

  it("lets a simulation failure through untouched, so nobody is asked to sign it", async () => {
    const original = new Error("HostError: Error(Contract, #19)");
    const rpc = fakeRpc({
      prepareTransaction: async () => {
        throw original;
      },
    });
    const err = await buildStellarBridge(
      rpc,
      { wrapperContractId: WRAPPER, networkPassphrase: Networks.PUBLIC },
      INPUT,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StellarSimulationError);
    if (!(err instanceof StellarSimulationError)) throw new Error("not a StellarSimulationError");
    expect(err.contractCode).toBe(19);
    expect(err.contractError).toBe("WrapperFeeAboveUserCap");
    expect(err.cause).toBe(original);
  });

  it("handles a simulation error without a contract code", async () => {
    const original = new Error("simulation failed: out of gas");
    const rpc = fakeRpc({
      prepareTransaction: async () => {
        throw original;
      },
    });
    const err = await buildStellarBridge(
      rpc,
      { wrapperContractId: WRAPPER, networkPassphrase: Networks.PUBLIC },
      INPUT,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StellarSimulationError);
    if (!(err instanceof StellarSimulationError)) throw new Error("not a StellarSimulationError");
    expect(err.contractCode).toBeUndefined();
    expect(err.contractError).toBeUndefined();
    expect(err.cause).toBe(original);
  });

  it("does not call an unreachable RPC a rejection", async () => {
    const rpc = fakeRpc({
      prepareTransaction: async () => {
        throw new Error("fetch failed: ECONNRESET");
      },
    });
    const err = await buildStellarBridge(
      rpc,
      { wrapperContractId: WRAPPER, networkPassphrase: Networks.PUBLIC },
      INPUT,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(StellarSimulationError);
  });

  it("rejects non-positive amount with invalid_amount", async () => {
    for (const badAmount of [0n, -1n]) {
      const err = await buildStellarBridge(
        fakeRpc(),
        { wrapperContractId: WRAPPER, networkPassphrase: Networks.PUBLIC },
        { ...INPUT, amount: badAmount },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(XebraError);
      expect(err).toMatchObject({ code: "invalid_amount", field: "amount" });
      expect((err as Error).message).toContain("amount");
    }
  });

  it("rejects ttlSeconds <= 0 or > 3600 with invalid_request", async () => {
    for (const badTtl of [0, -10, 3601, 7200]) {
      const err = await buildStellarBridge(
        fakeRpc(),
        { wrapperContractId: WRAPPER, networkPassphrase: Networks.PUBLIC },
        { ...INPUT, ttlSeconds: badTtl },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(XebraError);
      expect(err).toMatchObject({ code: "invalid_request", field: "ttlSeconds" });
      expect((err as Error).message).toContain("ttlSeconds");
    }
  });

  it("rejects mintRecipient when not 32 bytes", async () => {
    for (const badRecipient of [new Uint8Array(0), new Uint8Array(31), new Uint8Array(33)]) {
      const err = await buildStellarBridge(
        fakeRpc(),
        { wrapperContractId: WRAPPER, networkPassphrase: Networks.PUBLIC },
        { ...INPUT, mintRecipient: badRecipient },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(XebraError);
      expect(err).toMatchObject({ code: "invalid_request", field: "mintRecipient" });
      expect((err as Error).message).toContain("mintRecipient");
    }
  });

  it("rejects recipientOwner when defined and not 32 bytes", async () => {
    for (const badOwner of [new Uint8Array(16), new Uint8Array(33)]) {
      const err = await buildStellarBridge(
        fakeRpc(),
        { wrapperContractId: WRAPPER, networkPassphrase: Networks.PUBLIC },
        { ...INPUT, recipientOwner: badOwner },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(XebraError);
      expect(err).toMatchObject({ code: "invalid_request", field: "recipientOwner" });
      expect((err as Error).message).toContain("recipientOwner");
    }
  });

  it("accepts recipientOwner when null or exactly 32 bytes", async () => {
    const rpc = fakeRpc();
    await expect(
      buildStellarBridge(
        rpc,
        { wrapperContractId: WRAPPER, networkPassphrase: Networks.PUBLIC },
        { ...INPUT, recipientOwner: null },
      ),
    ).resolves.toBeDefined();
    await expect(
      buildStellarBridge(
        rpc,
        { wrapperContractId: WRAPPER, networkPassphrase: Networks.PUBLIC },
        { ...INPUT, recipientOwner: new Uint8Array(32) },
      ),
    ).resolves.toBeDefined();
  });

  it("wraps unfunded account error as XebraError with account_not_found", async () => {
    const rpc = fakeRpc({
      getAccount: async () => {
        throw new Error("Account not found");
      },
    });
    const err = await buildStellarBridge(
      rpc,
      { wrapperContractId: WRAPPER, networkPassphrase: Networks.PUBLIC },
      INPUT,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XebraError);
    expect(err).toMatchObject({
      code: "account_not_found",
      message: "This Stellar account does not exist yet. Fund it with XLM first.",
    });
  });

  it("passes other getAccount errors through untouched", async () => {
    const rpc = fakeRpc({
      getAccount: async () => {
        throw new Error("connection timeout");
      },
    });
    const err = await buildStellarBridge(
      rpc,
      { wrapperContractId: WRAPPER, networkPassphrase: Networks.PUBLIC },
      INPUT,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(XebraError);
    expect((err as Error).message).toBe("connection timeout");
  });
});
