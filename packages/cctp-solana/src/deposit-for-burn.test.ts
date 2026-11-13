import { createHash } from "node:crypto";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  BURN_COMPUTE_UNITS,
  DEPOSIT_FOR_BURN_WITH_HOOK_DISCRIMINATOR,
  type DepositForBurnWithHookParams,
  buildDepositForBurnWithHookInstruction,
  buildSolanaBurnTransaction,
  depositForBurnAccounts,
  describeSimulationError,
  encodeDepositForBurnWithHook,
} from "./deposit-for-burn.js";
import { TOKEN_MESSENGER_MINTER_V2, TOKEN_PROGRAM } from "./receive-message.js";

/**
 * Two REAL mainnet `deposit_for_burn_with_hook` transactions, read over RPC on 2026-11-13 and both
 * attested by Circle. Rebuilding them byte for byte from their parameters is the proof that the
 * account order, the flags and the Borsh layout are what Circle's program accepts: a guessed layout
 * would only fail on chain, after the burn's fee was paid, or worse, succeed with the fields swapped.
 */
const HYPEREVM_BURN = {
  // 4tfePLoZRfjSdBSrarqeJNNNwG9G7Rqtfoqo3uKZpkjRfhE4tRrU5YfYfXVzJcg79mf32QSjwBZySRbqjxDwxzyT
  owner: "8brALi7qJDDkMJJPcBLUBXEcbRu6W1CekMifv2XFnuon",
  eventRentPayer: "7V8b38Df6VtC4ykmdqZq657o2KoA4zEEpAy5j3pGZYgw",
  burnTokenAccount: "2zGtDdadoYFvjWw7YCPft81QxkxiUD2hYjWFvqAkp4LX",
  event: "5McfVepkpZek8dBNjSnrV6aZ7KQbQAMuGG16GopNvtj6",
  accounts: [
    ["8brALi7qJDDkMJJPcBLUBXEcbRu6W1CekMifv2XFnuon", true, false],
    ["7V8b38Df6VtC4ykmdqZq657o2KoA4zEEpAy5j3pGZYgw", true, true],
    ["45hzrGLQ2EGo1Ln7QpXjDwb589GDQ9H2aEXXw6ds6BFE", false, false],
    ["2zGtDdadoYFvjWw7YCPft81QxkxiUD2hYjWFvqAkp4LX", false, true],
    ["Cw8uSkvLXfCsYKVjwkp4AEh6M3dJXYMh5PrbtuabYjWH", false, false],
    ["W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU", false, true],
    ["AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W", false, false],
    ["3WG7G3vPxz4a6bdBb9Xic2YL4QM84ru1YcVYskcweVHY", false, false],
    ["E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux", false, false],
    ["CRBBbuLCyrkQy4dCTHxqstSmDQv4ajBeUVb9qUdMVaP1", false, true],
    ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", false, true],
    ["5McfVepkpZek8dBNjSnrV6aZ7KQbQAMuGG16GopNvtj6", true, true],
    ["CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC", false, false],
    ["CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe", false, false],
    ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", false, false],
    ["11111111111111111111111111111111", false, false],
    ["6TCCnJ9R1m1RXFzyoH7GYH2J6NJDtZaUvfipPuLWxHNd", false, false],
    ["CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe", false, false],
  ] as const,
  params: {
    amount: 21_056_843n,
    destinationDomain: 19,
    mintRecipient: Buffer.from(`${"00".repeat(12)}b21d281dedb17ae5b501f6aa8256fe38c4e45757`, "hex"),
    destinationCaller: Buffer.from(
      `${"00".repeat(12)}b21d281dedb17ae5b501f6aa8256fe38c4e45757`,
      "hex",
    ),
    maxFee: 266_843n,
    minFinalityThreshold: 1000,
    hookData: Buffer.from(
      "636374702d666f72776172640000000000000000000000000000000000000018095fcfdb2cfa19ae4cd9dbe5d00dd77c2c36ac8500000000",
      "hex",
    ),
  } satisfies DepositForBurnWithHookParams,
  data: "6ff53e83cc6cdf9b4b4d41010000000013000000000000000000000000000000b21d281dedb17ae5b501f6aa8256fe38c4e45757000000000000000000000000b21d281dedb17ae5b501f6aa8256fe38c4e457575b12040000000000e803000038000000636374702d666f72776172640000000000000000000000000000000000000018095fcfdb2cfa19ae4cd9dbe5d00dd77c2c36ac8500000000",
};

/** Solana to Stellar, 974.6 USDC (2bDXTMyLLYac1jMjqxZSqkpkCvypk54TqGGzCQYQVRBUWKWGDDeuGbs1pCq4QnWCgkL2mh34678XKQ98fB48Z1UM). */
const STELLAR_BURN = {
  owner: "7GdPAYzsV6fcxDVUZENRmQMwJ23B8GAywWZMDnYozjr4",
  eventRentPayer: "5aDssL53qFByo7SKRSKiLcPepdbabmCunttZ1Crm8VH2",
  burnTokenAccount: "F6T8px6b5LeZpuPbkzdSACmzLSkRmVKrcSUJB7Sosiy7",
  event: "JBQzrPoKv2CjnAkf2wiJpLBapqGX5VPpccm5jxNF3KwY",
  remoteTokenMessenger: "7rFyL6KPFT6DtREZbbtQCYHinYtWCUS6WXqtw5EC3bQF",
  denylist: "A385CDQAWYeAKtyaX4kXkSUuyrMpin1gz6VVxeTTEN53",
  data: "6ff53e83cc6cdf9b4037173a000000001b00000072bd20ff2f8281801bb05b7c29179026933256fabafeb13e94efd8ddbcfcf29172bd20ff2f8281801bb05b7c29179026933256fabafeb13e94efd8ddbcfcf2910000000000000000d00700005800000000000000000000000000000000000000000000000000000000000000000000384742484333553652555555354e52583753485a325843354841354a49473336344c4f4d564a4c59574d37324a4642414e575357594a375a56",
};

const pk = (s: string) => new PublicKey(s);

describe("the Anchor discriminator", () => {
  it('matches sha256("global:deposit_for_burn_with_hook")', () => {
    const expected = createHash("sha256")
      .update("global:deposit_for_burn_with_hook")
      .digest()
      .subarray(0, 8);
    expect(DEPOSIT_FOR_BURN_WITH_HOOK_DISCRIMINATOR.toString("hex")).toBe(expected.toString("hex"));
  });
});

describe("a real mainnet burn to HyperEVM", () => {
  const ix = buildDepositForBurnWithHookInstruction(
    {
      owner: pk(HYPEREVM_BURN.owner),
      eventRentPayer: pk(HYPEREVM_BURN.eventRentPayer),
      burnTokenAccount: pk(HYPEREVM_BURN.burnTokenAccount),
      messageSentEventData: pk(HYPEREVM_BURN.event),
    },
    HYPEREVM_BURN.params,
  );

  it("is rebuilt byte for byte from its parameters", () => {
    expect(ix.data.toString("hex")).toBe(HYPEREVM_BURN.data);
    expect(ix.programId.equals(TOKEN_MESSENGER_MINTER_V2)).toBe(true);
  });

  it("names the same 18 accounts, in the same order, with the same flags", () => {
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(
      HYPEREVM_BURN.accounts.map((a) => [...a]),
    );
  });
});

describe("a real mainnet burn to Stellar", () => {
  // The Stellar recipient travels in the hook; mintRecipient and destinationCaller are both
  // Circle's CctpForwarder (72bd20ff…). The encoder itself is exercised here; the bytes the web
  // app derives from a G… address are checked against this same hex in apps/web.
  const data = Buffer.from(STELLAR_BURN.data, "hex");
  const forwarder = data.subarray(20, 52);
  const params: DepositForBurnWithHookParams = {
    amount: 974_600_000n,
    destinationDomain: 27,
    mintRecipient: forwarder,
    destinationCaller: forwarder,
    maxFee: 0n,
    minFinalityThreshold: 2000,
    hookData: data.subarray(100),
  };

  it("is rebuilt byte for byte", () => {
    const ix = buildDepositForBurnWithHookInstruction(
      {
        owner: pk(STELLAR_BURN.owner),
        eventRentPayer: pk(STELLAR_BURN.eventRentPayer),
        burnTokenAccount: pk(STELLAR_BURN.burnTokenAccount),
        messageSentEventData: pk(STELLAR_BURN.event),
      },
      params,
    );
    expect(ix.data.toString("hex")).toBe(STELLAR_BURN.data);
  });

  it("derives Stellar's remote token messenger and the owner's denylist entry as mainnet did", () => {
    const keys = depositForBurnAccounts({
      owner: pk(STELLAR_BURN.owner),
      destinationDomain: 27,
      messageSentEventData: pk(STELLAR_BURN.event),
    });
    expect(keys[7]?.pubkey.toBase58()).toBe(STELLAR_BURN.remoteTokenMessenger);
    expect(keys[4]?.pubkey.toBase58()).toBe(STELLAR_BURN.denylist);
  });
});

describe("encodeDepositForBurnWithHook refuses what the program would", () => {
  const ok: DepositForBurnWithHookParams = {
    amount: 5_000_000n,
    destinationDomain: 6,
    mintRecipient: new Uint8Array(32).fill(1),
    destinationCaller: new Uint8Array(32),
    maxFee: 60_000n,
    minFinalityThreshold: 2000,
    hookData: new Uint8Array(32).fill(2),
  };
  it("accepts a well-formed burn", () => {
    expect(encodeDepositForBurnWithHook(ok)).toHaveLength(8 + 8 + 4 + 32 + 32 + 8 + 4 + 4 + 32);
  });
  it.each([
    [{ amount: 0n }, "amount must be above zero"],
    [{ maxFee: 5_000_000n }, "maxFee must be below the amount"],
    [{ maxFee: -1n }, "maxFee must be below the amount"],
    [{ mintRecipient: new Uint8Array(32) }, "mintRecipient must not be zero"],
    [{ mintRecipient: new Uint8Array(20).fill(1) }, "mintRecipient must be 32 bytes"],
    [{ destinationCaller: new Uint8Array(31) }, "destinationCaller must be 32 bytes"],
    [{ hookData: new Uint8Array(0) }, "hookData must not be empty"],
    [{ amount: 1n << 64n, maxFee: 0n }, "amount does not fit in a u64"],
    [{ destinationDomain: -1 }, "destinationDomain does not fit in a u32"],
  ] as const)("%o", (change, error) => {
    expect(() => encodeDepositForBurnWithHook({ ...ok, ...change })).toThrow(error);
  });
});

describe("buildSolanaBurnTransaction", () => {
  const owner = Keypair.generate().publicKey;
  const balance = (units: bigint) => {
    const data = Buffer.alloc(165);
    data.writeBigUInt64LE(units, 64);
    return { owner: TOKEN_PROGRAM, data, lamports: 2_039_280, executable: false };
  };
  const connection = (units: bigint | null) =>
    ({
      getAccountInfo: async () => (units === null ? null : balance(units)),
      getLatestBlockhash: async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 123,
      }),
    }) as never;
  const params: DepositForBurnWithHookParams = {
    amount: 10_000_000n,
    destinationDomain: 27,
    mintRecipient: new Uint8Array(32).fill(7),
    destinationCaller: new Uint8Array(32).fill(7),
    maxFee: 0n,
    minFinalityThreshold: 2000,
    // A Stellar hook is the longest this app sends: 32 + 56 bytes.
    hookData: new Uint8Array(88).fill(3),
  };

  it("leaves only the owner's signature to add, and fits a Solana packet", async () => {
    const built = await buildSolanaBurnTransaction(connection(10_000_000n), {
      owner,
      params,
      simulate: false,
    });
    const raw = Buffer.from(built.transaction, "base64");
    expect(raw.length).toBeLessThanOrEqual(1232);
    const tx = Transaction.from(raw);
    expect(tx.feePayer?.equals(owner)).toBe(true);
    expect(built.lastValidBlockHeight).toBe(123);
    const sigs = new Map(tx.signatures.map((s) => [s.publicKey.toBase58(), s.signature]));
    expect(sigs.size).toBe(2);
    expect(sigs.get(owner.toBase58())).toBeNull();
    expect(sigs.get(built.eventAccount)).toHaveLength(64);
    // The event key's signature is genuine over the message the owner will sign.
    expect(tx.verifySignatures(false)).toBe(true);
    const burn = tx.instructions.at(-1);
    expect(burn?.programId.equals(TOKEN_MESSENGER_MINTER_V2)).toBe(true);
    expect(burn?.keys[11]?.pubkey.toBase58()).toBe(built.eventAccount);
    expect(burn?.data.subarray(8).equals(encodeDepositForBurnWithHook(params).subarray(8))).toBe(
      true,
    );
    // Compute limit first, priced second, burn last.
    expect(tx.instructions[0]?.data.readUInt32LE(1)).toBe(BURN_COMPUTE_UNITS);
  });

  it("uses a new event account every time", async () => {
    const a = await buildSolanaBurnTransaction(connection(10_000_000n), {
      owner,
      params,
      simulate: false,
    });
    const b = await buildSolanaBurnTransaction(connection(10_000_000n), {
      owner,
      params,
      simulate: false,
    });
    expect(a.eventAccount).not.toBe(b.eventAccount);
  });

  it("refuses a wallet without enough USDC before building anything", async () => {
    await expect(
      buildSolanaBurnTransaction(connection(9_999_999n), { owner, params, simulate: false }),
    ).rejects.toMatchObject({ have: 9_999_999n, need: 10_000_000n });
    await expect(
      buildSolanaBurnTransaction(connection(null), { owner, params, simulate: false }),
    ).rejects.toMatchObject({ have: 0n });
  });
});

describe("describeSimulationError", () => {
  it("says what a person can fix", () => {
    expect(
      describeSimulationError({ InstructionError: [2, { Custom: 1 }] }, [
        "Transfer: insufficient lamports 100, need 2000",
      ]),
    ).toMatch(/enough SOL/);
    expect(describeSimulationError("InsufficientFundsForFee", [])).toMatch(/network fee/);
    expect(describeSimulationError({}, ["Error Message: Invalid destination domain."])).toBe(
      "Solana would refuse this burn: Invalid destination domain.",
    );
  });
});
