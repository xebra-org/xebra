import { describe, expect, it } from "vitest";
import {
  type EvmClaimTarget,
  checkClaim,
  ensureClaimNetwork,
  isAlreadyMinted,
  sendClaim,
  waitForClaim,
} from "./evm-claim";

/**
 * What the claim helpers send to a wallet. These were first written against the Arc-only helpers
 * and passed unchanged before and after those were rebuilt on `lib/evm-rpc.ts` and generalised to
 * every EVM chain. A hand claim is the only way a transfer is recovered when Circle's forwarding
 * does not land, so its wire behaviour must not move by accident.
 */

const TARGET: EvmClaimTarget = {
  chainId: 5042,
  name: "Arc",
  messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  rpcUrl: "https://rpc.mainnet.arc.io",
  explorerUrl: "https://explorer.arc.io",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  claimCost: "well under a cent, paid in USDC",
};
const ARC_HEX = "0x13b2";
const NONCE = "903db3847105114c62d6f4d69f3780523dd557eb4fccfa1c95662eb4d214eef8";
/** version | source 27 | destination 26 | nonce | padding. */
const MESSAGE = `0x000000010000001b0000001a${NONCE}${"00".repeat(104)}` as const;
const HASH = `0x${"ab".repeat(32)}`;

type Call = { method: string; params?: unknown[] };

/** A wallet that answers from a script and records what it was asked. */
function wallet(answer: (call: Call, calls: Call[]) => unknown) {
  const calls: Call[] = [];
  return {
    calls,
    of: (method: string) => calls.filter((c) => c.method === method),
    request: async (call: Call) => {
      calls.push(call);
      return answer(call, calls);
    },
  };
}

describe("ensureClaimNetwork", () => {
  it("asks the wallet to switch to Arc's chain id", async () => {
    let chain = "0x1";
    const w = wallet(({ method }) => {
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") chain = ARC_HEX;
      return null;
    });
    await ensureClaimNetwork(w, TARGET);
    expect(w.of("wallet_switchEthereumChain")[0]?.params).toEqual([{ chainId: ARC_HEX }]);
    expect(w.of("wallet_addEthereumChain")).toHaveLength(0);
  });

  it("adds Arc, with USDC as its 18-decimal gas token, when the wallet has never seen it", async () => {
    let chain = "0x1";
    const w = wallet(({ method }) => {
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") throw { code: 4902, message: "unknown chain" };
      if (method === "wallet_addEthereumChain") chain = ARC_HEX;
      return null;
    });
    await ensureClaimNetwork(w, TARGET);
    expect(w.of("wallet_addEthereumChain")[0]?.params).toEqual([
      {
        chainId: ARC_HEX,
        chainName: "Arc",
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        rpcUrls: ["https://rpc.mainnet.arc.io"],
        blockExplorerUrls: ["https://explorer.arc.io"],
      },
    ]);
  });

  it("does not offer to add the chain when the switch failed for another reason", async () => {
    const w = wallet(({ method }) => {
      if (method === "eth_chainId") return "0x1";
      if (method === "wallet_switchEthereumChain") throw { code: -32603, message: "internal" };
      return null;
    });
    await expect(ensureClaimNetwork(w, TARGET)).rejects.toMatchObject({ code: -32603 });
    expect(w.of("wallet_addEthereumChain")).toHaveLength(0);
  });
});

describe("isAlreadyMinted", () => {
  const ask = (result: string) => wallet(({ method }) => (method === "eth_call" ? result : null));

  it("asks Circle's transmitter whether the message's nonce is used", async () => {
    const w = ask(`0x${"00".repeat(32)}`);
    expect(await isAlreadyMinted(w, TARGET, MESSAGE)).toBe(false);
    // usedNonces(bytes32) with the nonce from bytes 12..44 of the message.
    expect(w.of("eth_call")[0]?.params).toEqual([
      { to: TARGET.messageTransmitter, data: `0xfeb61724${NONCE}` },
      "latest",
    ]);
  });

  it("says minted for any non-zero answer", async () => {
    expect(await isAlreadyMinted(ask(`0x${"00".repeat(31)}01`), TARGET, MESSAGE)).toBe(true);
  });
});

describe("sendClaim", () => {
  it("sends receiveMessage to the transmitter from the connected wallet, and returns the hash", async () => {
    const w = wallet(({ method }) => (method === "eth_sendTransaction" ? HASH : null));
    const from = "0x1111111111111111111111111111111111111111";
    expect(await sendClaim(w, TARGET, from, MESSAGE, "0xcafe")).toBe(HASH);
    const [tx] = w.of("eth_sendTransaction")[0]?.params as [Record<string, string>];
    expect(tx.from).toBe(from);
    expect(tx.to).toBe(TARGET.messageTransmitter);
    // Named, so a wallet that has drifted off the destination refuses to sign.
    expect(tx.chainId).toBe(ARC_HEX);
    // receiveMessage(bytes,bytes)
    expect(tx.data?.startsWith("0x57ecfd28")).toBe(true);
    expect(tx.data).toContain(NONCE);
  });
});

describe("waitForClaim", () => {
  it("polls until a receipt appears and reads its status", async () => {
    let asked = 0;
    const w = wallet(({ method }) => {
      if (method !== "eth_getTransactionReceipt") return null;
      asked += 1;
      return asked < 2 ? null : { status: "0x1" };
    });
    expect(await waitForClaim(w, HASH, 5_000)).toBe("success");
    expect(w.of("eth_getTransactionReceipt")[0]?.params).toEqual([HASH]);
  });

  it("reports a revert as a revert", async () => {
    const w = wallet(() => ({ status: "0x0" }));
    expect(await waitForClaim(w, HASH, 5_000)).toBe("reverted");
  });

  it("gives up, naming the hash, when no receipt ever comes", async () => {
    const w = wallet(() => null);
    await expect(waitForClaim(w, HASH, 1)).rejects.toThrow(`no receipt for ${HASH}`);
  });
});

describe("checkClaim", () => {
  const FROM = "0x1111111111111111111111111111111111111111";

  it("runs the mint as the paying wallet, without sending it", async () => {
    const w = wallet(({ method }) => (method === "eth_call" ? "0x" : null));
    expect(await checkClaim(w, TARGET, FROM, MESSAGE, "0xcafe")).toEqual({ ok: true });
    const [call] = w.of("eth_call")[0]?.params as [Record<string, string>];
    expect(call.from).toBe(FROM);
    expect(call.to).toBe(TARGET.messageTransmitter);
    expect(call.data?.startsWith("0x57ecfd28")).toBe(true);
    expect(w.of("eth_sendTransaction")).toHaveLength(0);
  });

  it("recognises an expired Fast attestation from what the chain says", async () => {
    const w = wallet(() => {
      throw { code: 3, message: "execution reverted: Message expired and must be re-signed" };
    });
    expect(await checkClaim(w, TARGET, FROM, MESSAGE, "0xcafe")).toEqual({
      ok: false,
      expired: true,
    });
  });

  it("passes any other refusal on in the chain's own words", async () => {
    const w = wallet(() => {
      throw { code: 3, message: "execution reverted: Invalid attestation length" };
    });
    expect(await checkClaim(w, TARGET, FROM, MESSAGE, "0xcafe")).toEqual({
      ok: false,
      expired: false,
      reason: "execution reverted: Invalid attestation length",
    });
  });

  it("does not call a revert that merely mentions expiry an expired attestation", async () => {
    const w = wallet(() => {
      throw { code: 3, message: "execution reverted: Permit expired" };
    });
    expect(await checkClaim(w, TARGET, FROM, MESSAGE, "0xcafe")).toEqual({
      ok: false,
      expired: false,
      reason: "execution reverted: Permit expired",
    });
  });

  it("says it could not check, not expired, when the wallet's session expired", async () => {
    const w = wallet(() => {
      throw { code: -32603, message: "session expired" };
    });
    await expect(checkClaim(w, TARGET, FROM, MESSAGE, "0xcafe")).rejects.toThrow(
      "Could not check the mint: session expired. Nothing was sent; try again.",
    );
  });

  it("says it could not check, not would fail, when the network is down", async () => {
    const w = wallet(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(checkClaim(w, TARGET, FROM, MESSAGE, "0xcafe")).rejects.toThrow(
      "Could not check the mint: Failed to fetch.",
    );
  });
});
