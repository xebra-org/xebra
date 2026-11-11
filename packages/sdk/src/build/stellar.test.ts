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
import { APPROVAL_TTL_LEDGERS, type StellarBuildRpc, buildStellarBridge } from "./stellar.js";

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
    const rpc = fakeRpc({
      prepareTransaction: async () => {
        throw new Error("HostError: Error(Contract, #19)");
      },
    });
    await expect(
      buildStellarBridge(
        rpc,
        { wrapperContractId: WRAPPER, networkPassphrase: Networks.PUBLIC },
        INPUT,
      ),
    ).rejects.toThrow("#19");
  });
});
