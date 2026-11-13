import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import {
  FINALITY,
  FORWARD_HOOK,
  ZERO_BYTES32,
  addressToBytes32,
  encodeDepositForBurnWithHook,
  forwardHookWithAccount,
  tokenMessengerAbi,
} from "./token-messenger.js";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RECIPIENT = "0x1111111111111111111111111111111111111111";

const burn = (over: Partial<Parameters<typeof encodeDepositForBurnWithHook>[0]> = {}) =>
  encodeDepositForBurnWithHook({
    amount: 5_000_000n,
    destinationDomain: 26,
    recipient: RECIPIENT,
    burnToken: BASE_USDC,
    maxFee: 16_778n,
    minFinalityThreshold: FINALITY.standard,
    ...over,
  });

describe("FORWARD_HOOK", () => {
  it("is exactly the bytes the Soroban wrapper sends and mainnet has accepted", () => {
    // contracts/stellar-cctp-wrapper-v2/src/lib.rs FORWARD_HOOK, and the hex in
    // scripts/test-cctp-forwarding-mainnet.sh.
    expect(FORWARD_HOOK).toBe("0x636374702d666f72776172640000000000000000000000000000000000000000");
    const ascii = Buffer.from(FORWARD_HOOK.slice(2, 2 + 24), "hex").toString("ascii");
    expect(ascii).toBe("cctp-forward");
    expect(FORWARD_HOOK.slice(2 + 24)).toMatch(/^0{40}$/);
  });
});

describe("encodeDepositForBurnWithHook", () => {
  it("encodes TokenMessengerV2.depositForBurnWithHook", () => {
    // 0x779b432d is in the live implementation bytecode on every chain in EVM_CHAINS
    // (scripts/check-evm-cctp.sh).
    expect(burn().startsWith("0x779b432d")).toBe(true);
  });

  it("pins every argument, in the contract's order", () => {
    const decoded = decodeFunctionData({ abi: tokenMessengerAbi, data: burn() });
    expect(decoded.functionName).toBe("depositForBurnWithHook");
    expect(decoded.args).toEqual([
      5_000_000n,
      26,
      "0x0000000000000000000000001111111111111111111111111111111111111111",
      BASE_USDC,
      ZERO_BYTES32,
      16_778n,
      2000,
      FORWARD_HOOK,
    ]);
  });

  it("always leaves the mint open to anyone and always asks for forwarding", () => {
    for (const minFinalityThreshold of [FINALITY.fast, FINALITY.standard]) {
      const { args } = decodeFunctionData({
        abi: tokenMessengerAbi,
        data: burn({ minFinalityThreshold }),
      });
      expect(args[4]).toBe(ZERO_BYTES32);
      expect(args[7]).toBe(FORWARD_HOOK);
      expect(args[6]).toBe(minFinalityThreshold);
    }
  });

  it("refuses a fee the contract would revert on", () => {
    expect(() => burn({ maxFee: 5_000_000n })).toThrow("maxFee must be less than the amount");
    expect(() => burn({ maxFee: 5_000_001n })).toThrow("maxFee must be less than the amount");
    expect(() => burn({ maxFee: -1n })).toThrow("maxFee must be less than the amount");
    expect(() => burn({ maxFee: 4_999_999n })).not.toThrow();
  });

  it("refuses a zero amount, a zero recipient and a speed Circle does not have", () => {
    expect(() => burn({ amount: 0n })).toThrow("amount must be positive");
    expect(() => burn({ recipient: `0x${"00".repeat(20)}` })).toThrow("zero address");
    expect(() => burn({ minFinalityThreshold: 1500 as never })).toThrow("1000 (Fast) or 2000");
  });

  it("refuses something that is not an address", () => {
    expect(() => burn({ recipient: "0x1234" })).toThrow("not an EVM address");
    expect(() => burn({ burnToken: "USDC" })).toThrow("not an EVM address");
  });
});

describe("addressToBytes32", () => {
  it("left-pads to 32 bytes, whatever the address's case", () => {
    expect(addressToBytes32("0xAbCdEf0123456789aBcDeF0123456789AbCdEf01")).toBe(
      "0x000000000000000000000000abcdef0123456789abcdef0123456789abcdef01",
    );
  });
});

// PROVEN_ACCOUNT_HOOK and PROVEN_OWNER in contracts/stellar-cctp-wrapper-v2/src/test.rs: the 65
// bytes Circle's forwarder accepted on mainnet (burn 7dcf762a…ada79), and the owner they were for.
const PROVEN_OWNER: `0x${string}` =
  "0x9e2db9de8d008210502ee1851ddde821a3239b038243a951c4b64ed4df6f9805";
const PROVEN_ACCOUNT_HOOK =
  "0x636374702d666f72776172640000000000000000000000000000000000000021019e2db9de8d008210502ee1851ddde821a3239b038243a951c4b64ed4df6f9805";

describe("forwardHookWithAccount", () => {
  it("is exactly the 65 bytes mainnet accepted for that owner", () => {
    expect(forwardHookWithAccount(PROVEN_OWNER)).toBe(PROVEN_ACCOUNT_HOOK);
    expect((PROVEN_ACCOUNT_HOOK.length - 2) / 2).toBe(65);
  });

  it("refuses an owner that is not a 32-byte key, or is zero", () => {
    expect(() => forwardHookWithAccount("0x1234")).toThrow("32-byte");
    expect(() => forwardHookWithAccount(ZERO_BYTES32)).toThrow("32-byte");
  });
});

describe("a burn to Solana", () => {
  const ATA = `0x${"ab".repeat(32)}` as const;
  const toSolana = (recipient: Parameters<typeof encodeDepositForBurnWithHook>[0]["recipient"]) =>
    encodeDepositForBurnWithHook({
      amount: 5_000_000n,
      destinationDomain: 5,
      recipient,
      burnToken: "0x3600000000000000000000000000000000000000",
      maxFee: 151_856n,
      minFinalityThreshold: FINALITY.standard,
    });

  it("mints into the token account and asks for plain forwarding when the account exists", () => {
    const { args } = decodeFunctionData({
      abi: tokenMessengerAbi,
      data: toSolana({ kind: "solana", tokenAccount: ATA }),
    });
    expect(args[1]).toBe(5);
    expect(args[2]).toBe(ATA);
    expect(args[4]).toBe(ZERO_BYTES32);
    expect(args[7]).toBe(FORWARD_HOOK);
  });

  it("asks Circle to open the account, for the owner given, when it does not exist", () => {
    const { args } = decodeFunctionData({
      abi: tokenMessengerAbi,
      data: toSolana({ kind: "solana", tokenAccount: ATA, createAccountFor: PROVEN_OWNER }),
    });
    expect(args[2]).toBe(ATA);
    expect(args[7]).toBe(PROVEN_ACCOUNT_HOOK);
  });

  it("refuses an EVM address for Solana, and a token account for anywhere else", () => {
    expect(() => toSolana(RECIPIENT)).toThrow("needs the recipient's USDC token account");
    expect(() =>
      burn({ recipient: { kind: "solana", tokenAccount: ATA }, destinationDomain: 26 }),
    ).toThrow("only be the recipient of a burn to Solana");
  });

  it("refuses a zero token account, and an owner that is the token account itself", () => {
    expect(() => toSolana({ kind: "solana", tokenAccount: ZERO_BYTES32 })).toThrow("non-zero");
    expect(() => toSolana({ kind: "solana", tokenAccount: ATA, createAccountFor: ATA })).toThrow(
      "must differ",
    );
  });
});

describe("a burn to Stellar", () => {
  // Circle's CctpForwarder on Stellar, as 32 bytes, and our hook naming a G... recipient.
  const FORWARDER = `0x${"7c".repeat(32)}` as const;
  const G = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
  const body = Buffer.from(G, "utf8");
  const header = Buffer.alloc(32);
  header.writeUInt32BE(body.length, 28);
  const HOOK = `0x${Buffer.concat([header, body]).toString("hex")}` as const;
  const toStellar = { kind: "stellar", forwarder: FORWARDER, hookData: HOOK } as const;

  it("mints to the forwarder, names it as the only caller, and carries the hook", () => {
    const data = burn({ destinationDomain: 27, recipient: toStellar, maxFee: 0n });
    const { args } = decodeFunctionData({ abi: tokenMessengerAbi, data });
    expect(args[2]).toBe(FORWARDER);
    expect(args[4]).toBe(FORWARDER);
    expect(args[7]).toBe(HOOK);
  });

  it("refuses an EVM address or a Solana account as a Stellar recipient: the USDC would be stuck", () => {
    expect(() => burn({ destinationDomain: 27, recipient: RECIPIENT })).toThrow(/Stellar/);
    expect(() =>
      burn({
        destinationDomain: 27,
        recipient: { kind: "solana", tokenAccount: FORWARDER },
      }),
    ).toThrow();
  });

  it("refuses a Stellar recipient anywhere but Stellar, and a hook whose length is wrong", () => {
    expect(() => burn({ destinationDomain: 6, recipient: toStellar })).toThrow(/Stellar/);
    const bad = `${HOOK.slice(0, -2)}` as `0x${string}`;
    expect(() =>
      burn({ destinationDomain: 27, recipient: { ...toStellar, hookData: bad }, maxFee: 0n }),
    ).toThrow(/hook/);
    expect(() =>
      burn({
        destinationDomain: 27,
        recipient: { ...toStellar, forwarder: `0x${"00".repeat(32)}` },
        maxFee: 0n,
      }),
    ).toThrow(/forwarder/);
  });
});
