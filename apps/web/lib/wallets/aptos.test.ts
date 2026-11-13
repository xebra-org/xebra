import type { Wallet } from "@wallet-standard/base";
import { FORWARD_HOOK, ZERO_BYTES32 } from "@xebra/cctp-evm";
import { APTOS_CCTP, type AptosBurnArgs } from "@xebra/sdk/build";
import { describe, expect, it, vi } from "vitest";
import {
  approved,
  aptosEntries,
  aptosWalletOnMainnet,
  connectAptos,
  isAptosWallet,
  readAptosAddress,
  signAndSubmitAptos,
  takesPayload,
} from "./aptos";

const ADDR = "0x744bf58c5562a9ebc71ef07743e8e3385eec8e5743fde745d937ba22d37e9eb1";
const HASH = `0x${"ab".repeat(32)}`;

function wallet(
  name: string,
  chains: string[],
  features: Record<string, unknown>,
  icon = "data:image/png;base64,AA",
): Wallet {
  return { name, chains, icon, features, accounts: [], version: "1.0.0" } as unknown as Wallet;
}
const both = { "aptos:connect": {}, "aptos:signAndSubmitTransaction": {} };

const ARGS: AptosBurnArgs = {
  amount: 1_000_000n,
  destinationDomain: 6,
  mintRecipient: `0x${"00".repeat(12)}${"11".repeat(20)}`,
  destinationCaller: ZERO_BYTES32,
  burnToken: APTOS_CCTP.usdc,
  maxFee: 54_802n,
  minFinalityThreshold: 2000,
  hookData: FORWARD_HOOK,
};
const ENVELOPE = {
  sender: ADDR as `0x${string}`,
  sequenceNumber: 330n,
  maxGasAmount: 2_000n,
  gasUnitPrice: 100n,
  expirationTimestampSecs: 1_800_000_000n,
  chainId: 1,
};

describe("isAptosWallet", () => {
  it("wants an aptos chain, connect, and sign-and-submit", () => {
    expect(isAptosWallet(wallet("Petra", ["aptos:mainnet"], both))).toBe(true);
    expect(isAptosWallet(wallet("P", ["solana:mainnet"], both))).toBe(false);
    expect(isAptosWallet(wallet("P", ["aptos:mainnet"], { "aptos:connect": {} }))).toBe(false);
    expect(isAptosWallet(wallet("Sui", ["sui:mainnet"], { "standard:connect": {} }))).toBe(false);
  });

  it("lists them sorted, keyed by family, without unsafe icons", () => {
    const list = aptosEntries([
      wallet("Petra", ["aptos:mainnet"], both, "javascript:alert(1)"),
      wallet("Nightly", ["aptos:mainnet"], both),
      wallet("Phantom", ["solana:mainnet"], { "standard:connect": {} }),
    ]);
    expect(list.map((e) => e.key)).toEqual(["aptos:Nightly", "aptos:Petra"]);
    expect(list.every((e) => e.family === "aptos" && e.installed)).toBe(true);
    expect(list[1]?.icon).toBeNull();
  });
});

describe("readAptosAddress", () => {
  it("reads strings, the SDK's AccountAddress, and its bytes", () => {
    expect(readAptosAddress(ADDR.toUpperCase().replace("0X", "0x"))).toBe(ADDR);
    expect(readAptosAddress({ toString: () => ADDR })).toBe(ADDR);
    const data = Uint8Array.from(Buffer.from(ADDR.slice(2), "hex"));
    expect(readAptosAddress({ data })).toBe(ADDR);
    expect(readAptosAddress("0x1")).toBe(`0x${"0".repeat(63)}1`);
  });
  it("refuses anything else", () => {
    for (const bad of [null, undefined, 42, "", "abc", {}, { data: new Uint8Array(31) }]) {
      expect(readAptosAddress(bad)).toBeNull();
    }
  });
});

describe("approved", () => {
  it("unwraps an approval, throws a recognisable decline, and passes bare answers through", () => {
    expect(approved({ status: "Approved", args: 7 }, "x")).toBe(7);
    expect(() => approved({ status: "Rejected" }, "transaction")).toThrow(/declined/);
    expect(approved({ hash: HASH }, "x")).toEqual({ hash: HASH });
  });
});

describe("connectAptos", () => {
  it("takes the account the wallet approved", async () => {
    const w = wallet("Petra", ["aptos:mainnet"], {
      ...both,
      "aptos:connect": {
        connect: async () => ({ status: "Approved", args: { address: { toString: () => ADDR } } }),
      },
    });
    const entry = aptosEntries([w])[0];
    if (!entry) throw new Error("no entry");
    expect(await connectAptos(entry, w)).toEqual({
      family: "aptos",
      walletKey: "aptos:Petra",
      walletName: "Petra",
      address: ADDR,
    });
  });
});

describe("aptosWalletOnMainnet", () => {
  const withNetwork = (n: unknown) =>
    wallet("W", ["aptos:mainnet"], { ...both, "aptos:network": { network: async () => n } });
  it("reads the chain id or the name, and says null when it cannot tell", async () => {
    expect(await aptosWalletOnMainnet(withNetwork({ name: "mainnet", chainId: 1 }))).toBe(true);
    expect(await aptosWalletOnMainnet(withNetwork({ name: "testnet", chainId: 2 }))).toBe(false);
    expect(await aptosWalletOnMainnet(withNetwork({ name: "Mainnet" }))).toBe(true);
    expect(await aptosWalletOnMainnet(withNetwork({}))).toBeNull();
    expect(await aptosWalletOnMainnet(wallet("W", ["aptos:mainnet"], both))).toBeNull();
  });
});

describe("signAndSubmitAptos", () => {
  it("knows which interface takes a payload", () => {
    expect(takesPayload("1.1.0")).toBe(true);
    expect(takesPayload("1.2.3")).toBe(true);
    expect(takesPayload("2.0.0")).toBe(true);
    expect(takesPayload("1.0.0")).toBe(false);
    expect(takesPayload(undefined)).toBe(false);
  });

  it("hands a 1.1 wallet the script payload with the simulated gas", async () => {
    const sign = vi.fn(async () => ({ status: "Approved", args: { hash: HASH } }));
    const w = wallet("W", ["aptos:mainnet"], {
      ...both,
      "aptos:signAndSubmitTransaction": { version: "1.1.0", signAndSubmitTransaction: sign },
    });
    expect(await signAndSubmitAptos(w, ARGS, ENVELOPE)).toBe(HASH);
    const input = (sign.mock.calls[0] as unknown[])[0] as {
      payload: { bytecode: Uint8Array; functionArguments: unknown[] };
      maxGasAmount: number;
    };
    expect(input.maxGasAmount).toBe(2_000);
    expect(input.payload.bytecode.length).toBe(639);
    expect(input.payload.functionArguments).toHaveLength(8);
  });

  it("hands a 1.0 wallet a whole transaction, and accepts a hash without 0x", async () => {
    const sign = vi.fn(async () => ({ status: "Approved", args: { hash: HASH.slice(2) } }));
    const w = wallet("W", ["aptos:mainnet"], {
      ...both,
      "aptos:signAndSubmitTransaction": { version: "1.0.0", signAndSubmitTransaction: sign },
    });
    expect(await signAndSubmitAptos(w, ARGS, ENVELOPE)).toBe(HASH);
    const tx = (sign.mock.calls[0] as unknown[])[0] as {
      rawTransaction: { sequence_number: bigint };
      bcsToBytes(): Uint8Array;
    };
    expect(tx.rawTransaction.sequence_number).toBe(330n);
    expect(tx.bcsToBytes().length).toBeGreaterThan(700);
  });

  it("throws when declined, and when no hash comes back", async () => {
    const declined = wallet("W", ["aptos:mainnet"], {
      ...both,
      "aptos:signAndSubmitTransaction": {
        version: "1.1.0",
        signAndSubmitTransaction: async () => ({ status: "Rejected" }),
      },
    });
    await expect(signAndSubmitAptos(declined, ARGS, ENVELOPE)).rejects.toThrow(/declined/);
    const silent = wallet("W", ["aptos:mainnet"], {
      ...both,
      "aptos:signAndSubmitTransaction": {
        version: "1.1.0",
        signAndSubmitTransaction: async () => ({ status: "Approved", args: {} }),
      },
    });
    await expect(signAndSubmitAptos(silent, ARGS, ENVELOPE)).rejects.toThrow(/hash/);
  });
});
