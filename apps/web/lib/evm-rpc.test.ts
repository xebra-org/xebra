import { describe, expect, it } from "vitest";
import {
  type ChainTarget,
  ensureChain,
  ethCall,
  readBlockNumber,
  readChainId,
  sendTransaction,
  waitForReceipt,
} from "./evm-rpc";

const BASE: ChainTarget = {
  chainId: 8453,
  name: "Base",
  rpcUrl: "https://mainnet.base.org",
  explorerUrl: "https://basescan.org",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
};
const HASH = `0x${"ab".repeat(32)}`;

type Call = { method: string; params?: unknown[] };

function wallet(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  return {
    calls,
    of: (method: string) => calls.filter((c) => c.method === method),
    request: async (call: Call) => {
      calls.push(call);
      return answer(call);
    },
  };
}

describe("readChainId", () => {
  it("reads the wallet's hex chain id as a number", async () => {
    expect(await readChainId(wallet(() => "0x2105"))).toBe(8453);
  });

  it("refuses an answer that is not a chain", async () => {
    await expect(readChainId(wallet(() => null))).rejects.toThrow("which network");
    await expect(readChainId(wallet(() => "0x0"))).rejects.toThrow("which network");
  });
});

describe("ensureChain", () => {
  it("switches, then confirms the wallet really is there", async () => {
    let chain = "0x1";
    const w = wallet(({ method }) => {
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") chain = "0x2105";
      return null;
    });
    await ensureChain(w, BASE);
    expect(w.calls.map((c) => c.method)).toEqual(["wallet_switchEthereumChain", "eth_chainId"]);
  });

  it("refuses when the switch did not throw but the wallet is still elsewhere", async () => {
    // Every Circle address exists on every chain, so carrying on here would read and send on the
    // wrong one without a single error.
    const w = wallet(({ method }) => (method === "eth_chainId" ? "0x1" : null));
    await expect(ensureChain(w, BASE)).rejects.toThrow("Your wallet is not on Base");
  });

  it("adds a chain the wallet has never seen, then confirms", async () => {
    let chain = "0x1";
    const w = wallet(({ method }) => {
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") throw { code: 4902 };
      if (method === "wallet_addEthereumChain") chain = "0x2105";
      return null;
    });
    await ensureChain(w, BASE);
    expect(w.of("wallet_addEthereumChain")[0]?.params).toEqual([
      {
        chainId: "0x2105",
        chainName: "Base",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: ["https://mainnet.base.org"],
        blockExplorerUrls: ["https://basescan.org"],
      },
    ]);
  });

  it("refuses when the chain was added but the wallet stayed where it was", async () => {
    const w = wallet(({ method }) => {
      if (method === "eth_chainId") return "0x1";
      if (method === "wallet_switchEthereumChain") throw { code: 4902 };
      return null;
    });
    await expect(ensureChain(w, BASE)).rejects.toThrow("Your wallet is not on Base");
  });

  it("says so in a sentence when the person declines", async () => {
    const w = wallet(({ method }) => {
      if (method === "wallet_switchEthereumChain") throw { code: 4001, message: "User rejected" };
      return "0x1";
    });
    await expect(ensureChain(w, BASE)).rejects.toThrow("You declined the request in your wallet.");
    expect(w.of("wallet_addEthereumChain")).toHaveLength(0);
  });
});

describe("ethCall", () => {
  it("passes an empty result through for the decoder to refuse, and never invents a value", async () => {
    expect(
      await ethCall(
        wallet(() => "0x"),
        "0xabc",
        "0x01",
      ),
    ).toBe("0x");
  });

  it("refuses an answer that is not hex at all", async () => {
    await expect(
      ethCall(
        wallet(() => null),
        "0xabc",
        "0x01",
      ),
    ).rejects.toThrow("unreadable");
  });
});

describe("sendTransaction", () => {
  const tx = { from: "0x11", to: "0x22", data: "0x33" as const };

  it("returns the hash and names the chain it is meant for", async () => {
    const w = wallet(() => HASH);
    expect(await sendTransaction(w, { ...tx, chainId: 8453 })).toBe(HASH);
    expect(w.calls[0]?.params).toEqual([{ ...tx, chainId: "0x2105" }]);
  });

  it("leaves the chain out when it was not given", async () => {
    const w = wallet(() => HASH);
    await sendTransaction(w, tx);
    expect(w.calls[0]?.params).toEqual([tx]);
  });

  it("refuses something that is not a transaction hash", async () => {
    await expect(
      sendTransaction(
        wallet(() => null),
        tx,
      ),
    ).rejects.toThrow("transaction hash");
    await expect(
      sendTransaction(
        wallet(() => "0x1234"),
        tx,
      ),
    ).rejects.toThrow("transaction hash");
  });

  it("turns a declined signature into a sentence and keeps the original as the cause", async () => {
    const raw = { code: 4001, message: "MetaMask Tx Signature: User denied" };
    const w = wallet(() => {
      throw raw;
    });
    const err = await sendTransaction(w, tx).catch((e) => e);
    expect(err.message).toBe("You declined the request in your wallet.");
    expect(err.cause).toBe(raw);
  });

  it("turns a 4900 disconnect into a sentence", async () => {
    const raw = { code: 4900, message: "Disconnected" };
    const w = wallet(() => {
      throw raw;
    });
    const err = await sendTransaction(w, tx).catch((e) => e);
    expect(err.message).toBe("Your wallet is disconnected from all chains.");
    expect(err.cause).toBe(raw);
  });

  it("turns a 4901 chain disconnect into a sentence", async () => {
    const raw = { code: 4901, message: "Chain disconnected" };
    const w = wallet(() => {
      throw raw;
    });
    const err = await sendTransaction(w, tx).catch((e) => e);
    expect(err.message).toBe("Your wallet is disconnected from this chain.");
    expect(err.cause).toBe(raw);
  });

  it("turns a WalletConnect 5000 rejection into a sentence", async () => {
    const raw = { code: 5000, message: "User rejected methods" };
    const w = wallet(() => {
      throw raw;
    });
    const err = await sendTransaction(w, tx).catch((e) => e);
    expect(err.message).toBe("You declined the request in your wallet.");
    expect(err.cause).toBe(raw);
  });

  it("turns an error that says User denied with no code into a sentence", async () => {
    const raw = { message: "User denied transaction signature" };
    const w = wallet(() => {
      throw raw;
    });
    const err = await sendTransaction(w, tx).catch((e) => e);
    expect(err.message).toBe("You declined the request in your wallet.");
    expect(err.cause).toBe(raw);
  });

  it("turns an Error instance with User denied and no code into a sentence", async () => {
    const raw = new Error("User denied message signature");
    const w = wallet(() => {
      throw raw;
    });
    const err = await sendTransaction(w, tx).catch((e) => e);
    expect(err.message).toBe("You declined the request in your wallet.");
    expect(err.cause).toBe(raw);
  });

  it("unwraps a -32603 error with a nested reason in data.message", async () => {
    const raw = {
      code: -32603,
      message: "Internal JSON-RPC error.",
      data: { message: "execution reverted: transfer amount exceeds balance" },
    };
    const w = wallet(() => {
      throw raw;
    });
    const err = await sendTransaction(w, tx).catch((e) => e);
    expect(err.message).toBe("execution reverted: transfer amount exceeds balance");
    expect(err.cause).toBe(raw);
  });

  it("unwraps a -32603 error with a nested reason in data.originalError", async () => {
    const raw = {
      code: -32603,
      message: "Internal JSON-RPC error.",
      data: {
        originalError: { message: "execution reverted: TransferHelper: TRANSFER_FAILED" },
      },
    };
    const w = wallet(() => {
      throw raw;
    });
    const err = await sendTransaction(w, tx).catch((e) => e);
    expect(err.message).toBe("execution reverted: TransferHelper: TRANSFER_FAILED");
    expect(err.cause).toBe(raw);
  });

  it("unwraps a -32603 error with a string in data.originalError", async () => {
    const raw = {
      code: -32603,
      message: "Internal JSON-RPC error.",
      data: { originalError: "execution reverted: gas required exceeds allowance" },
    };
    const w = wallet(() => {
      throw raw;
    });
    const err = await sendTransaction(w, tx).catch((e) => e);
    expect(err.message).toBe("execution reverted: gas required exceeds allowance");
    expect(err.cause).toBe(raw);
  });

  it("turns a -32603 error with nested User denied into the user declined sentence", async () => {
    const raw = {
      code: -32603,
      message: "Internal JSON-RPC error.",
      data: { message: "User denied transaction signature" },
    };
    const w = wallet(() => {
      throw raw;
    });
    const err = await sendTransaction(w, tx).catch((e) => e);
    expect(err.message).toBe("You declined the request in your wallet.");
    expect(err.cause).toBe(raw);
  });

  it("passes on a -32603 error with no nested reason in data untouched", async () => {
    const raw = { code: -32603, message: "Internal JSON-RPC error." };
    const w = wallet(() => {
      throw raw;
    });
    await expect(sendTransaction(w, tx)).rejects.toBe(raw);
  });

  it("passes on an error it has no sentence for, untouched", async () => {
    const raw = { code: -32000, message: "insufficient funds for gas" };
    const w = wallet(() => {
      throw raw;
    });
    await expect(sendTransaction(w, tx)).rejects.toBe(raw);
  });
});

describe("waitForReceipt", () => {
  const fast = { pollMs: 1, sleep: async () => {} };

  it("keeps asking through a node that drops requests", async () => {
    let asked = 0;
    const w = wallet(() => {
      asked += 1;
      if (asked === 1) throw new Error("network error");
      if (asked === 2) return null;
      return { status: "0x1" };
    });
    expect(await waitForReceipt(w, HASH, fast)).toBe("success");
    expect(asked).toBe(3);
  });

  it("reads a revert", async () => {
    expect(
      await waitForReceipt(
        wallet(() => ({ status: "0x0" })),
        HASH,
        fast,
      ),
    ).toBe("reverted");
  });

  it("gives up at the deadline, naming the hash", async () => {
    let t = 0;
    const now = () => {
      t += 10_000;
      return t;
    };
    const clock = { ...fast, timeoutMs: 30_000, now };
    await expect(
      waitForReceipt(
        wallet(() => null),
        HASH,
        clock,
      ),
    ).rejects.toThrow(`no receipt for ${HASH} after 30s`);
  });
});

describe("readBlockNumber", () => {
  it("reads the latest block as a bigint", async () => {
    expect(await readBlockNumber(wallet(() => "0x10"))).toBe(16n);
    await expect(readBlockNumber(wallet(() => "latest"))).rejects.toThrow("block number");
  });
});
