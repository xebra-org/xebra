// Imported by apps/web's server routes and, potentially, a browser bundle: the bundler resolves
// bare "buffer" to the npm shim and resolves the node: specifier to nothing.
// biome-ignore lint/style/useNodejsImportProtocol: "node:buffer" would break the browser build.
import { Buffer } from "buffer";
import {
  type AccountMeta,
  ComputeBudgetProgram,
  type Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  MESSAGE_TRANSMITTER_V2,
  TOKEN_MESSENGER_MINTER_V2,
  TOKEN_PROGRAM,
  associatedTokenAddress,
} from "./receive-message.js";

/**
 * CCTP V2's `deposit_for_burn_with_hook` on Solana: the burn half of a transfer that starts on
 * Solana.
 *
 * # Where the layout comes from, and how it was checked
 *
 * Circle's published IDL (`circlefin/solana-cctp-contracts`, `examples/target/idl/
 * token_messenger_minter_v2.json`) and the program source (`deposit_for_burn.rs`,
 * `deposit_for_burn_with_hook.rs`). Then, because an IDL is a description and not the program,
 * against two real mainnet transactions read over RPC on 2026-11-13: every account below was found at
 * the same index, with the same signer and writable flags, and the instruction data was rebuilt
 * byte for byte from its parameters (`deposit-for-burn.test.ts` keeps both as fixtures).
 *
 * # The event account
 *
 * The program writes the outgoing CCTP message into `message_sent_event_data`, an account it
 * creates in the same instruction, so that account's key must sign. It is any fresh keypair: it has
 * no authority over anything once created, and its rent (paid by `event_rent_payer`, here the
 * sender) can be reclaimed by the payer through `reclaim_event_account` after Circle attests.
 */

/** Anchor's discriminator: the first 8 bytes of sha256("global:deposit_for_burn_with_hook"). */
export const DEPOSIT_FOR_BURN_WITH_HOOK_DISCRIMINATOR = Buffer.from("6ff53e83cc6cdf9b", "hex");

/** Solana's CCTP domain. */
export const SOLANA_CCTP_DOMAIN = 5;
/** Native USDC on Solana mainnet. */
export const SOLANA_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = 0xffff_ffff;

const pda = (seeds: Buffer[], programId: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];
const utf8 = (s: string) => Buffer.from(s, "utf8");

export interface DepositForBurnWithHookParams {
  /** USDC base units (6 decimals). */
  amount: bigint;
  destinationDomain: number;
  /** 32 bytes: the account the destination mints to. Never zero (the program refuses it). */
  mintRecipient: Uint8Array;
  /** 32 bytes: who alone may call `receiveMessage` on the destination; all zero means anyone. */
  destinationCaller: Uint8Array;
  /** The most Circle may keep, in base units. Must be below `amount`. */
  maxFee: bigint;
  /** 1000 (Fast) or 2000 (Standard). */
  minFinalityThreshold: number;
  /** Non-empty: the program refuses an empty hook on this instruction. */
  hookData: Uint8Array;
}

function u64(v: bigint, what: string): Buffer {
  if (v < 0n || v > U64_MAX) throw new Error(`${what} does not fit in a u64`);
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

function u32(v: number, what: string): Buffer {
  if (!Number.isInteger(v) || v < 0 || v > U32_MAX)
    throw new Error(`${what} does not fit in a u32`);
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}

function bytes32(v: Uint8Array, what: string): Buffer {
  if (v.length !== 32) throw new Error(`${what} must be 32 bytes, not ${v.length}`);
  return Buffer.from(v);
}

/**
 * The instruction data: discriminator, then the Borsh-encoded `DepositForBurnWithHookParams`
 * (`amount: u64, destination_domain: u32, mint_recipient: Pubkey, destination_caller: Pubkey,
 * max_fee: u64, min_finality_threshold: u32, hook_data: Vec<u8>`), all little-endian.
 *
 * Refuses, before anything is signed, every input the program would refuse after taking a fee:
 * a zero amount or recipient, a fee that is not below the amount, an empty hook.
 */
export function encodeDepositForBurnWithHook(p: DepositForBurnWithHookParams): Buffer {
  if (p.amount <= 0n) throw new Error("amount must be above zero");
  if (p.maxFee < 0n || p.maxFee >= p.amount) throw new Error("maxFee must be below the amount");
  const recipient = bytes32(p.mintRecipient, "mintRecipient");
  if (recipient.every((b) => b === 0)) throw new Error("mintRecipient must not be zero");
  if (p.hookData.length === 0) throw new Error("hookData must not be empty");
  return Buffer.concat([
    DEPOSIT_FOR_BURN_WITH_HOOK_DISCRIMINATOR,
    u64(p.amount, "amount"),
    u32(p.destinationDomain, "destinationDomain"),
    recipient,
    bytes32(p.destinationCaller, "destinationCaller"),
    u64(p.maxFee, "maxFee"),
    u32(p.minFinalityThreshold, "minFinalityThreshold"),
    u32(p.hookData.length, "hookData length"),
    Buffer.from(p.hookData),
  ]);
}

export interface DepositForBurnAccounts {
  /** The wallet whose USDC is burned. Signs. */
  owner: PublicKey;
  /** Pays the event account's rent. Signs. The owner, unless someone sponsors it. */
  eventRentPayer?: PublicKey;
  /** The owner's USDC token account. Its associated token account when omitted. */
  burnTokenAccount?: PublicKey;
  usdcMint?: PublicKey;
  destinationDomain: number;
  /** A fresh keypair's public key; that keypair must sign too. */
  messageSentEventData: PublicKey;
}

/** The 18 accounts, in IDL order, with the flags the program requires. */
export function depositForBurnAccounts(a: DepositForBurnAccounts): AccountMeta[] {
  const mint = a.usdcMint ?? SOLANA_USDC_MINT;
  const payer = a.eventRentPayer ?? a.owner;
  const burnTokenAccount = a.burnTokenAccount ?? associatedTokenAddress(a.owner, mint);
  const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
  const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
  return [
    { pubkey: a.owner, isSigner: true, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
    ro(pda([utf8("sender_authority")], TOKEN_MESSENGER_MINTER_V2)),
    rw(burnTokenAccount),
    ro(pda([utf8("denylist_account"), a.owner.toBuffer()], TOKEN_MESSENGER_MINTER_V2)),
    rw(pda([utf8("message_transmitter")], MESSAGE_TRANSMITTER_V2)),
    ro(pda([utf8("token_messenger")], TOKEN_MESSENGER_MINTER_V2)),
    // Seeded with the domain as decimal text, as receiveMessage's remote accounts are.
    ro(
      pda(
        [utf8("remote_token_messenger"), utf8(String(a.destinationDomain))],
        TOKEN_MESSENGER_MINTER_V2,
      ),
    ),
    ro(pda([utf8("token_minter")], TOKEN_MESSENGER_MINTER_V2)),
    rw(pda([utf8("local_token"), mint.toBuffer()], TOKEN_MESSENGER_MINTER_V2)),
    rw(mint),
    { pubkey: a.messageSentEventData, isSigner: true, isWritable: true },
    ro(MESSAGE_TRANSMITTER_V2),
    ro(TOKEN_MESSENGER_MINTER_V2),
    ro(TOKEN_PROGRAM),
    ro(SystemProgram.programId),
    ro(pda([utf8("__event_authority")], TOKEN_MESSENGER_MINTER_V2)),
    ro(TOKEN_MESSENGER_MINTER_V2),
  ];
}

export function buildDepositForBurnWithHookInstruction(
  accounts: Omit<DepositForBurnAccounts, "destinationDomain">,
  params: DepositForBurnWithHookParams,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_MESSENGER_MINTER_V2,
    keys: depositForBurnAccounts({ ...accounts, destinationDomain: params.destinationDomain }),
    data: encodeDepositForBurnWithHook(params),
  });
}

/**
 * The compute the burn is given. Two mainnet burns used 44,798 and 44,948 units; a quarter more
 * leaves room for the hook's length and the program changing, without paying for headroom the
 * priority fee would multiply.
 */
export const BURN_COMPUTE_UNITS = 60_000;
/** Micro-lamports per compute unit: 60,000 units at this price is 6,000 lamports (0.000006 SOL). */
export const BURN_PRIORITY_MICRO_LAMPORTS = 100_000;

export class SolanaBurnRefused extends Error {
  constructor(
    message: string,
    readonly logs: string[] = [],
  ) {
    super(message);
  }
}

export class InsufficientSolanaUsdcError extends Error {
  constructor(
    readonly have: bigint,
    readonly need: bigint,
  ) {
    super("This Solana wallet does not hold enough USDC.");
  }
}

export interface BuiltSolanaBurn {
  /** Base64 legacy transaction, co-signed by the event account; the owner's signature is empty. */
  transaction: string;
  /** The account the message is written to, which the sender can later reclaim the rent of. */
  eventAccount: string;
  /** After this block height the transaction can no longer land; build it again. */
  lastValidBlockHeight: number;
}

/** A token account's balance: the u64 at bytes [64,72) of the SPL layout. */
function tokenBalance(data: Uint8Array): bigint {
  return Buffer.from(data).readBigUInt64LE(64);
}

/**
 * The whole burn transaction for the owner's wallet to sign, built and simulated against `connection`.
 *
 * The owner pays the network fee and the event account's rent and is the only signature missing;
 * the fresh event keypair has signed and is then dropped. Before returning, the transaction is
 * simulated with signature checks off, so a burn the program would refuse (no USDC account, too
 * little USDC or SOL, a domain Circle does not serve) is refused here instead of costing a fee.
 */
export async function buildSolanaBurnTransaction(
  connection: Connection,
  p: {
    owner: PublicKey;
    params: DepositForBurnWithHookParams;
    usdcMint?: PublicKey;
    /** Skip the simulation. Tests only. */
    simulate?: boolean;
  },
): Promise<BuiltSolanaBurn> {
  const mint = p.usdcMint ?? SOLANA_USDC_MINT;
  const source = associatedTokenAddress(p.owner, mint);
  const info = await connection.getAccountInfo(source);
  const have = info?.owner.equals(TOKEN_PROGRAM) ? tokenBalance(info.data) : 0n;
  if (have < p.params.amount) throw new InsufficientSolanaUsdcError(have, p.params.amount);

  const event = Keypair.generate();
  const burn = buildDepositForBurnWithHookInstruction(
    {
      owner: p.owner,
      burnTokenAccount: source,
      usdcMint: mint,
      messageSentEventData: event.publicKey,
    },
    p.params,
  );
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: p.owner, blockhash, lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: BURN_COMPUTE_UNITS }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BURN_PRIORITY_MICRO_LAMPORTS }),
    burn,
  );

  if (p.simulate !== false) {
    const sim = await connection.simulateTransaction(
      new VersionedTransaction(tx.compileMessage()),
      {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
      },
    );
    if (sim.value.err) {
      throw new SolanaBurnRefused(describeSimulationError(sim.value.err, sim.value.logs ?? []), [
        ...(sim.value.logs ?? []),
      ]);
    }
  }

  tx.partialSign(event);
  return {
    transaction: Buffer.from(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
    ).toString("base64"),
    eventAccount: event.publicKey.toBase58(),
    lastValidBlockHeight,
  };
}

/** A person-readable reason from a failed simulation; the raw logs travel with the error. */
export function describeSimulationError(err: unknown, logs: readonly string[]): string {
  const text = logs.join("\n");
  if (/insufficient lamports|InsufficientFundsForRent|insufficient funds for rent/i.test(text)) {
    return "The wallet does not hold enough SOL for the network fee and the burn's message account (about 0.0035 SOL).";
  }
  if (JSON.stringify(err ?? "").includes("InsufficientFundsForFee")) {
    return "The wallet does not hold enough SOL for the network fee.";
  }
  if (/insufficient funds/i.test(text)) return "The wallet does not hold enough USDC.";
  if (/DenylistedAccount/.test(text)) return "Circle does not accept burns from this wallet.";
  if (/AccountNotInitialized|account.*not.*initialized/i.test(text)) {
    return "The wallet has no USDC account on Solana.";
  }
  const anchor = /Error Message: ([^.\n]+)/.exec(text)?.[1];
  return anchor ? `Solana would refuse this burn: ${anchor}.` : "Solana would refuse this burn.";
}
