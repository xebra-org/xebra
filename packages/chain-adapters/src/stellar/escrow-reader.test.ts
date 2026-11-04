import { Address, Keypair, Networks, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { EscrowReadError, type EscrowSimulator, parseEscrow, readEscrow } from "./escrow-reader.js";

const CONTRACT = "CBMFZNZ4BUU2FLQW6ELGR6BGFO5T7C2LA5JA4TR5HY7UZN5FD3ZJP4OW";
const HASH = `0x${"ab".repeat(32)}`;
const USER = Keypair.random().publicKey();
const SOLVER = Keypair.random().publicKey();

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const addr = (a: string) => new Address(a).toScVal();

function entry(over: Record<string, xdr.ScVal> = {}): xdr.ScVal {
  const fields: Record<string, xdr.ScVal> = {
    challenger: xdr.ScVal.scvVoid(),
    challenger_bond: nativeToScVal(0n, { type: "i128" }),
    claimed_at: nativeToScVal(0n, { type: "u64" }),
    delivered_amount: nativeToScVal(0n, { type: "i128" }),
    dest_chain: nativeToScVal(3, { type: "u32" }),
    dest_tx_ref: xdr.ScVal.scvVoid(),
    expiry: nativeToScVal(2_000_000_000n, { type: "u64" }),
    solver: xdr.ScVal.scvVoid(),
    solver_bond: nativeToScVal(0n, { type: "i128" }),
    source_amount: nativeToScVal(500_000_000n, { type: "i128" }),
    source_token: addr(USER),
    status: xdr.ScVal.scvVec([sym("Open")]),
    user: addr(USER),
    ...over,
  };
  // Soroban requires map keys in sorted order; the literal above already is.
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: sym(k), val: fields[k] as xdr.ScVal })),
  );
}

function simulator(response: unknown): EscrowSimulator {
  return { simulateTransaction: vi.fn(async () => response as never) };
}

const ok = (retval: xdr.ScVal) => simulator({ result: { retval, auth: [] } });

describe("readEscrow", () => {
  it("reads an open escrow", async () => {
    const view = await readEscrow(ok(entry()), Networks.TESTNET, CONTRACT, HASH);
    expect(view).toMatchObject({
      status: "Open",
      expiry: 2_000_000_000n,
      sourceAmount: 500_000_000n,
      destChain: 3,
      user: USER,
      solver: null,
      destTxRef: null,
    });
  });

  it("reads a claimed escrow with the solver's posted reference", async () => {
    const ref = Buffer.from("5Gy3solanasignature");
    const view = await readEscrow(
      ok(
        entry({
          status: xdr.ScVal.scvVec([sym("Claimed")]),
          solver: addr(SOLVER),
          dest_tx_ref: nativeToScVal(ref, { type: "bytes" }),
          delivered_amount: nativeToScVal(900_000_000n, { type: "i128" }),
          solver_bond: nativeToScVal(250_000_000n, { type: "i128" }),
          claimed_at: nativeToScVal(1_900_000_000n, { type: "u64" }),
        }),
      ),
      Networks.TESTNET,
      CONTRACT,
      HASH,
    );
    expect(view?.status).toBe("Claimed");
    expect(view?.solver).toBe(SOLVER);
    expect(Buffer.from(view?.destTxRef ?? []).toString()).toBe("5Gy3solanasignature");
    expect(view?.solverBond).toBe(250_000_000n);
  });

  it("returns null when the contract has no such escrow", async () => {
    const view = await readEscrow(
      simulator({ error: "HostError: Error(Contract, #7)\n\nEvent log (newest first):" }),
      Networks.TESTNET,
      CONTRACT,
      HASH,
    );
    expect(view).toBeNull();
  });

  it("throws, not null, for any other simulation failure", async () => {
    await expect(
      readEscrow(
        simulator({ error: "HostError: Error(Storage, ExceededLimit)" }),
        Networks.TESTNET,
        CONTRACT,
        HASH,
      ),
    ).rejects.toBeInstanceOf(EscrowReadError);
  });

  it("names the undecodable-extension case instead of crashing on an XDR error", async () => {
    const sim: EscrowSimulator = {
      simulateTransaction: async () => {
        throw new TypeError("Bad union switch: 1");
      },
    };
    await expect(readEscrow(sim, Networks.TESTNET, CONTRACT, HASH)).rejects.toThrow(/expired/);
  });

  it("rejects a hash that is not 32 bytes before any network call", async () => {
    const sim = ok(entry());
    await expect(readEscrow(sim, Networks.TESTNET, CONTRACT, "0x1234")).rejects.toThrow(/32 bytes/);
    expect(sim.simulateTransaction).not.toHaveBeenCalled();
  });
});

describe("parseEscrow", () => {
  it("rejects a status it does not know", () => {
    expect(() => parseEscrow({ status: ["Mystery"] })).toThrow(EscrowReadError);
  });
});
