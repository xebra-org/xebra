import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { FORWARD_HOOK, ZERO_BYTES32, forwardHookWithAccount } from "@xebra/cctp-evm";
import { describe, expect, it } from "vitest";
import { bytesToHex, solanaAddressToBytes32 } from "../core/addresses/solana.js";
import {
  InsufficientUsdcError,
  buildBurn,
  buildEvmBurn,
  buildForwardedBurn,
  burnMoveCalls,
  forwardBurnArgs,
} from "./sui.js";

/**
 * The owner whose 65-byte hook Circle accepted on mainnet (`PROVEN_OWNER` in cctp-evm's tests), and
 * its USDC associated token account, derived with `@solana/web3.js` `findProgramAddressSync`
 * (owner, Token program, USDC mint; Associated Token program).
 */
const OWNER = "BeTrgbfCgxsLWqACizZeiEsYMnGk948hjWvpCv15TZGG";
const OWNER_HEX = "0x9e2db9de8d008210502ee1851ddde821a3239b038243a951c4b64ed4df6f9805";
const ATA = "FpZKKHNFUZB6xESeycvXARXRvgFqRXDN9YNEKhqwHVYa";
const ATA_HEX = "0xdc32745e4b3e2fe8b12d1d8eaddb25d4bffeffdbb84ee41cbabcd33a558b3af7";
const SENDER = `0x${"5".repeat(64)}`;
const EVM = "0x5b38da6a701c568545dcfcb03fcb875f56beddc4";
const STELLAR_G = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

/** A Sui client whose USDC balance is `balance` base units, and nothing else. */
function clientWithBalance(balance: string): SuiGrpcClient {
  return {
    core: { getBalance: async () => ({ balance: { balance } }) },
  } as unknown as SuiGrpcClient;
}

const hex = (bytes: Uint8Array) => bytesToHex(bytes);

describe("forwardBurnArgs to Solana", () => {
  it("mints into the token account, not the wallet", () => {
    expect(bytesToHex(solanaAddressToBytes32(OWNER))).toBe(OWNER_HEX);
    expect(bytesToHex(solanaAddressToBytes32(ATA))).toBe(ATA_HEX);
    const args = forwardBurnArgs({ kind: "solana", tokenAccount: ATA_HEX }, 5);
    expect(args.mintRecipient).toBe(ATA_HEX);
    expect(args.mintRecipient).not.toBe(OWNER_HEX);
    expect(args.destinationCaller).toBe(ZERO_BYTES32);
    expect(hex(args.hookData)).toBe(FORWARD_HOOK);
  });

  it("asks Circle to open the account, for the wallet, when it does not exist", () => {
    const args = forwardBurnArgs(
      { kind: "solana", tokenAccount: ATA_HEX, createAccountFor: OWNER_HEX },
      5,
    );
    expect(args.mintRecipient).toBe(ATA_HEX);
    expect(hex(args.hookData)).toBe(forwardHookWithAccount(OWNER_HEX));
    expect(args.hookData.length).toBe(65);
  });

  it("refuses a bare address to Solana, and the wallet as its own token account", () => {
    expect(() => forwardBurnArgs(EVM, 5)).toThrow("token account");
    expect(() =>
      forwardBurnArgs({ kind: "solana", tokenAccount: ATA_HEX, createAccountFor: ATA_HEX }, 5),
    ).toThrow("must differ");
  });
});

describe("forwardBurnArgs to an EVM chain", () => {
  it("left-pads the address and asks for plain forwarding", () => {
    const args = forwardBurnArgs(EVM, 6);
    expect(args.mintRecipient).toBe(`0x${"00".repeat(12)}${EVM.slice(2)}`);
    expect(args.destinationCaller).toBe(ZERO_BYTES32);
    expect(hex(args.hookData)).toBe(FORWARD_HOOK);
  });

  it("refuses a Solana token account to an EVM chain, and Stellar or Sui as destinations", () => {
    expect(() => forwardBurnArgs({ kind: "solana", tokenAccount: ATA_HEX }, 6)).toThrow();
    expect(() => forwardBurnArgs(EVM, 27)).toThrow();
    expect(() => forwardBurnArgs(EVM, 8)).toThrow();
  });
});

describe("the Sui builders reject bad input", () => {
  const client = clientWithBalance("1000000");

  it("buildBurn rejects a mistyped sender with invalid_request", async () => {
    await expect(
      buildBurn(client, { sender: "0x123", amount: 1n, stellarRecipient: STELLAR_G }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("buildBurn rejects a zero amount with invalid_amount", async () => {
    await expect(
      buildBurn(client, { sender: SENDER, amount: 0n, stellarRecipient: STELLAR_G }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
  });

  it("buildForwardedBurn and buildEvmBurn reject bad input too", async () => {
    await expect(
      buildForwardedBurn(client, {
        sender: SENDER,
        amount: 0n,
        recipient: EVM,
        destinationDomain: 6,
        maxFee: 1n,
      }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(
      buildEvmBurn(client, {
        sender: "nope",
        amount: 1n,
        evmRecipient: EVM,
        destinationDomain: 6,
        maxFee: 1n,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("InsufficientUsdcError", () => {
  it("carries its name, code and both amounts", async () => {
    const client = clientWithBalance("100");
    let caught: unknown;
    try {
      await buildBurn(client, {
        sender: SENDER,
        amount: 5_000_000n,
        stellarRecipient: STELLAR_G,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InsufficientUsdcError);
    if (!(caught instanceof InsufficientUsdcError))
      throw new Error("expected InsufficientUsdcError");
    expect(caught.name).toBe("InsufficientUsdcError");
    expect(caught.code).toBe("insufficient_balance");
    expect(caught.have).toBe(100n);
    expect(caught.need).toBe(5_000_000n);
    expect(caught.message).toContain("100");
    expect(caught.message).toContain("5000000");
  });
});

describe("the Sui burn's Move call", () => {
  /** The pure bytes of `deposit_for_burn`'s argument at `index`. */
  function pureArg(tx: ReturnType<typeof burnMoveCalls>, index: number): Uint8Array {
    const data = tx.getData();
    const call = data.commands.find((c) => c.MoveCall?.function === "deposit_for_burn")?.MoveCall;
    const arg = call?.arguments[index];
    if (!arg || arg.$kind !== "Input") throw new Error(`argument ${index} is not an input`);
    const input = data.inputs[arg.Input];
    if (!input?.Pure) throw new Error(`argument ${index} is not a pure value`);
    return Uint8Array.from(Buffer.from(input.Pure.bytes, "base64"));
  }

  it("carries Solana's domain, the token account and the 65-byte hook, byte for byte", () => {
    const tx = burnMoveCalls({
      sender: SENDER,
      amount: 5_000_000n,
      destinationDomain: 5,
      maxFee: 249_659n,
      ...forwardBurnArgs({ kind: "solana", tokenAccount: ATA_HEX, createAccountFor: OWNER_HEX }, 5),
    });
    // u32 little-endian.
    expect(Array.from(pureArg(tx, 1))).toEqual([5, 0, 0, 0]);
    expect(hex(pureArg(tx, 2))).toBe(ATA_HEX);
    expect(hex(pureArg(tx, 3))).toBe(ZERO_BYTES32);
    // A vector<u8> is its ULEB128 length, then the bytes.
    const hook = pureArg(tx, 6);
    expect(hook[0]).toBe(65);
    expect(hex(hook.subarray(1))).toBe(forwardHookWithAccount(OWNER_HEX));
  });

  it("carries Monad's domain and the left-padded EVM recipient for a Sui to Monad burn (#9)", () => {
    const tx = burnMoveCalls({
      sender: SENDER,
      amount: 5_000_000n,
      destinationDomain: 15,
      maxFee: 54_785n,
      ...forwardBurnArgs(EVM, 15),
    });
    // u32 little-endian.
    expect(Array.from(pureArg(tx, 1))).toEqual([15, 0, 0, 0]);
    expect(hex(pureArg(tx, 2))).toBe(`0x${"00".repeat(12)}${EVM.slice(2)}`);
    expect(hex(pureArg(tx, 3))).toBe(ZERO_BYTES32);
    const hook = pureArg(tx, 6);
    expect(hex(hook.subarray(1))).toBe(FORWARD_HOOK);
  });
});
