import { describe, expect, it } from "vitest";
import { classifyWalletError } from "./wallet-error";

describe("classifyWalletError", () => {
  it("classifies Android UnknownHostException as network with maybeSent: true", () => {
    const err =
      'fetch failed: java.net.UnknownHostException: Unable to resolve host "mysten-rpc.mainnet.sui.io": No address associated with hostname';
    const result = classifyWalletError(err);
    expect(result.kind).toBe("network");
    expect(result.maybeSent).toBe(true);
    expect(result.message).not.toContain("nothing was sent");
    expect(result.message.toLowerCase()).toContain("check your wallet");
  });

  it("classifies 'Connection closed' as network and NOT declined", () => {
    const result = classifyWalletError("Connection closed");
    expect(result.kind).toBe("network");
    expect(result.maybeSent).toBe(true);
  });

  it("classifies user rejections as declined", () => {
    const result = classifyWalletError("User rejected the request");
    expect(result.kind).toBe("declined");
    expect(result.maybeSent).toBe(false);
    expect(result.message).toBe("You cancelled in your wallet. Nothing was sent.");
  });

  it("classifies EIP-1193 code 4001 as declined", () => {
    const result = classifyWalletError({ code: 4001, message: "User rejected" });
    expect(result.kind).toBe("declined");
    expect(result.maybeSent).toBe(false);
  });

  it("classifies WalletConnect code 5000 as declined", () => {
    const result = classifyWalletError({ code: 5000, message: "User disconnected" });
    expect(result.kind).toBe("declined");
    expect(result.maybeSent).toBe(false);
  });

  it("classifies EIP-1193 code -32002 as pending", () => {
    const result = classifyWalletError({ code: -32002 });
    expect(result.kind).toBe("pending");
    expect(result.maybeSent).toBe(false);
  });

  it("classifies EIP-1193 code 4902 as wrong_network", () => {
    const result = classifyWalletError({ code: 4902 });
    expect(result.kind).toBe("wrong_network");
    expect(result.maybeSent).toBe(false);
  });

  it("classifies insufficient funds as funds", () => {
    const result = classifyWalletError("insufficient funds for gas * price + value");
    expect(result.kind).toBe("funds");
    expect(result.maybeSent).toBe(false);
  });

  it("classifies onchain simulation/revert errors as onchain", () => {
    expect(classifyWalletError("execution reverted: TRANSFER_FAILED").kind).toBe("onchain");
    expect(classifyWalletError("Move abort 0x1::coin").kind).toBe("onchain");
    expect(classifyWalletError("Transaction simulation failed: InstructionError").kind).toBe(
      "onchain",
    );
  });

  it("classifies timeout errors as timeout with maybeSent: true", () => {
    const result = classifyWalletError("Request timed out after 30000ms");
    expect(result.kind).toBe("timeout");
    expect(result.maybeSent).toBe(true);
    expect(result.message).not.toContain("nothing was sent");
  });

  it("classifies popup closed or blocked as popup", () => {
    const result = classifyWalletError("The wallet popup was blocked by browser");
    expect(result.kind).toBe("popup");
    expect(result.maybeSent).toBe(false);
  });

  it("falls back to unknown for unclassified error", () => {
    const result = classifyWalletError("Something completely unexpected");
    expect(result.kind).toBe("unknown");
    expect(result.maybeSent).toBe(false);
  });
});
