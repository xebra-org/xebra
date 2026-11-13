import { recipientAndHook } from "@xebra/cctp-evm";
import type { BurnRecipient } from "./evm.js";
import type { TransferStep } from "./types.js";

/**
 * The Aptos side of a transfer: Circle's CCTP V2 burn, as the Move script Circle ships for it.
 *
 * On Aptos a CCTP burn is not an entry function. `token_messenger_minter::deposit_for_burn` returns
 * a `BurnReceipt` hot potato that `stablecoin_handler::handler::burn` must consume in the same
 * transaction, and only a script can chain the two. Circle publishes that script precompiled
 * against the mainnet package addresses; its bytecode is pinned here byte for byte (a test checks
 * its SHA-256 and the addresses it calls), so nothing is compiled at build time and nothing a
 * request sends can change what runs.
 *
 *   - Packages: developers.circle.com/cctp/references/aptos-packages, read 2026-11-13; the module
 *     ABIs were read from the mainnet fullnode the same day (`deposit_for_burn(&signer,
 *     FungibleAsset, u32, address, address, u64, u32, vector<u8>)`, `handler::burn(BurnReceipt,
 *     FungibleAsset)`), and `remote_token_messenger` answers for every domain this file sends to.
 *   - Script: circlefin/aptos-cctp `typescript/example/precompiled-move-scripts/mainnet/v2/
 *     deposit_for_burn_with_hook.mv` at commit 440599d2 (2026-08-04). Its source asserts the hook is
 *     not empty, withdraws `amount` of `burn_token` from the signer's primary store, calls
 *     `deposit_for_burn`, then `handler::burn`.
 *
 * The recipient, the hook and `destinationCaller` come from `recipientAndHook` in
 * `@xebra/cctp-evm`, the one encoder every EVM burn already goes through, so an Aptos burn to Base,
 * to Solana or to Stellar names exactly what an EVM burn to the same place would.
 *
 * Nothing here signs or sends. The BCS below is the small subset a script transaction needs; it is
 * written out because the Aptos SDK could not be installed, and every byte is pinned by a test.
 */

type Hex = `0x${string}`;

/** Aptos's CCTP domain. */
export const APTOS_DOMAIN = 9;
/** Aptos mainnet's chain id, which every transaction carries. */
export const APTOS_CHAIN_ID = 1;

/** Circle's CCTP V2 on Aptos mainnet. */
export const APTOS_CCTP = {
  tokenMessengerMinterV2: "0x551e32781793c30bf1580d11e4f5171e8d068c3d45c3a5b20ae240bfdad99af8",
  messageTransmitterV2: "0x1b3f6d749cb835451202f9a1932e49014266f7e3d51611a9a763d156cb4bdaf6",
  stablecoinHandler: "0x2b963f8aa28b815d2e875bd85a1a01d5f2d346f08f5b9fcf8953c77680735af2",
  /** Native USDC's fungible-asset metadata object (symbol USDC, 6 decimals), the `burn_token`. */
  usdc: "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b",
} as const;

/** `deposit_for_burn_with_hook.mv`, Circle's mainnet V2 build (639 bytes). */
export const APTOS_BURN_SCRIPT: Hex = `0x${[
  "a11ceb0b0900000a0801000c020c12031e2a044804054c43078f01e20108f102800110f1031f01030104010702",
  "0a030d010f00020b0001060701000100090000030c0000010504050108010101020806070108010101030b0809",
  "00010101040e09010001010105100a0a000101010003010309060c030e050505030e0a02000102010800010501",
  "0b0101090003060c0b010109000301080208060c08020e0505030e0a0202080308020103030b01010800080208",
  "03083c53454c463e5f311a6465706f7369745f666f725f6275726e5f776974685f686f6f6b084d657461646174",
  "610e66756e6769626c655f6173736574066f626a65637411616464726573735f746f5f6f626a656374064f626a",
  "656374167072696d6172795f66756e6769626c655f73746f72650877697468647261770d46756e6769626c6541",
  "7373657416746f6b656e5f6d657373656e6765725f6d696e746572106465706f7369745f666f725f6275726e0b",
  "4275726e526563656970740768616e646c6572046275726e056572726f7210696e76616c69645f617267756d65",
  "6e74ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000000000000000000000",
  "000000000000000000000000000000000000000001551e32781793c30bf1580d11e4f5171e8d068c3d45c3a5b2",
  "0ae240bfdad99af82b963f8aa28b815d2e875bd85a1a01d5f2d346f08f5b9fcf8953c77680735af214636f6d70",
  "696c6174696f6e5f6d65746164617461090003322e3003322e330000010b1d0e08410206000000000000000024",
  "04180b0538000c090a000b090b0138010c0a0b000b0a0b020b030b040b060b070b0811021103020b0001060100",
  "000000000000110427",
].join("")}`;

/**
 * Standard finality on every route from Aptos. Circle quotes no transfer fee for it, and Aptos
 * finalises in about a second, so Fast would buy nothing.
 */
export const APTOS_STANDARD_FINALITY = 2000;

const U64_MAX = (1n << 64n) - 1n;
const STELLAR_DOMAIN = 27;

/**
 * An Aptos account address in its long form, `0x` and 64 lower-case hex digits, or null. Wallets
 * print special addresses short (`0x1`), so a shorter one is left-padded; anything else is refused.
 */
export function normaliseAptosAddress(input: string): Hex | null {
  const m = /^0x([0-9a-fA-F]{1,64})$/.exec(input.trim());
  if (!m?.[1]) return null;
  return `0x${m[1].toLowerCase().padStart(64, "0")}`;
}

/** The eight arguments of the burn script after the signer, in its order. */
export interface AptosBurnArgs {
  /** 6-decimal units. */
  amount: bigint;
  destinationDomain: number;
  /** 32 bytes, as an Aptos `address` argument. */
  mintRecipient: Hex;
  destinationCaller: Hex;
  burnToken: Hex;
  /** What Circle may keep. */
  maxFee: bigint;
  minFinalityThreshold: number;
  hookData: Hex;
}

/** `AptosBurnArgs` with the integers as strings, for JSON. */
export interface AptosBurnArgsJson {
  amount: string;
  destinationDomain: number;
  mintRecipient: Hex;
  destinationCaller: Hex;
  burnToken: Hex;
  maxFee: string;
  minFinalityThreshold: number;
  hookData: Hex;
}

/**
 * The arguments of a burn from Aptos to `destinationDomain`, after every check that keeps funds
 * from being stranded:
 *
 *   - **EVM chain or Arc**: the address left-padded, Circle's `cctp-forward` hook, an open
 *     `destinationCaller` (Circle's forwarder requires it, and it keeps a failed delivery claimable),
 *     and a `maxFee` above zero to pay Circle for the delivery.
 *   - **Solana**: the recipient's USDC *token account* (never the wallet), with the 65-byte hook
 *     when Circle must open it.
 *   - **Stellar**: Circle's `CctpForwarder` as both the mint recipient and the only caller, the
 *     forwarder's hook naming the account, and no fee: nothing forwards into Stellar, so Circle
 *     has nothing to be paid for. Build the recipient with `stellarBurnRecipient("G...")`.
 *
 * Throws on anything else, so no wallet is ever asked to sign it.
 */
export function aptosBurnArgs(p: {
  amount: bigint;
  destinationDomain: number;
  recipient: BurnRecipient;
  maxFee: bigint;
}): AptosBurnArgs {
  if (p.amount <= 0n || p.amount > U64_MAX) throw new Error("amount must be a positive u64");
  if (p.destinationDomain === APTOS_DOMAIN) throw new Error("a burn cannot stay on Aptos");
  // Circle's `deposit_for_burn` asserts `max_fee < amount`; refusing here spends no gas.
  if (p.maxFee < 0n || p.maxFee >= p.amount) {
    throw new Error("maxFee must be at least zero and below the amount");
  }
  const toStellar = p.destinationDomain === STELLAR_DOMAIN;
  if (toStellar && p.maxFee !== 0n) {
    throw new Error("a burn to Stellar pays Circle nothing: maxFee must be zero");
  }
  if (!toStellar && p.maxFee === 0n) {
    throw new Error("a forwarded burn must pay Circle's delivery fee: maxFee must be above zero");
  }
  const { mintRecipient, hookData, destinationCaller } = recipientAndHook(
    p.recipient,
    p.destinationDomain,
  );
  // Circle's script refuses an empty hook; every recipient kind above carries one.
  if (hookData.length <= 2) throw new Error("the burn needs a hook");
  return {
    amount: p.amount,
    destinationDomain: p.destinationDomain,
    mintRecipient,
    destinationCaller,
    burnToken: APTOS_CCTP.usdc,
    maxFee: p.maxFee,
    minFinalityThreshold: APTOS_STANDARD_FINALITY,
    hookData,
  };
}

export function aptosBurnArgsToJson(a: AptosBurnArgs): AptosBurnArgsJson {
  return { ...a, amount: a.amount.toString(), maxFee: a.maxFee.toString() };
}

const HEX32 = /^0x[0-9a-f]{64}$/;

/**
 * Reads arguments back from JSON, checking each one's shape, and refuses a burn token other than
 * native USDC. The browser runs this on what the server built before a wallet sees it.
 */
export function aptosBurnArgsFromJson(j: AptosBurnArgsJson): AptosBurnArgs {
  if (!/^\d{1,20}$/.test(j.amount) || !/^\d{1,20}$/.test(j.maxFee)) {
    throw new Error("amounts must be integers");
  }
  for (const v of [j.mintRecipient, j.destinationCaller, j.burnToken]) {
    if (!HEX32.test(v)) throw new Error("addresses must be 32 bytes of lower-case hex");
  }
  if (j.burnToken !== APTOS_CCTP.usdc) throw new Error("the burn token must be native USDC");
  if (!/^0x([0-9a-f]{2})+$/.test(j.hookData)) throw new Error("the hook must be hex bytes");
  const ints = [j.destinationDomain, j.minFinalityThreshold];
  if (!ints.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)) {
    throw new Error("domains and finality must be u32");
  }
  const amount = BigInt(j.amount);
  const maxFee = BigInt(j.maxFee);
  if (amount <= 0n || amount > U64_MAX || maxFee >= amount) throw new Error("bad amount or fee");
  return { ...j, amount, maxFee };
}

// ---------------------------------------------------------------------------------------------
// BCS
// ---------------------------------------------------------------------------------------------

/**
 * Anything that writes itself as BCS. The method names are the Aptos TypeScript SDK's, because a
 * wallet serializes the arguments a page hands it by calling them on its own serializer.
 */
export interface BcsWriter {
  serializeU8(v: number): void;
  serializeBool(v: boolean): void;
  serializeU32(v: number): void;
  serializeU64(v: bigint | number): void;
  serializeU32AsUleb128(v: number): void;
  serializeFixedBytes(b: Uint8Array): void;
  serializeBytes(b: Uint8Array): void;
  serialize(v: { serialize(s: BcsWriter): void }): void;
}

export class AptosBcsSerializer implements BcsWriter {
  private buf = new Uint8Array(256);
  private len = 0;

  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  private le(v: bigint, bytes: number) {
    if (v < 0n || v >= 1n << BigInt(bytes * 8)) throw new Error(`out of range for u${bytes * 8}`);
    this.ensure(bytes);
    let x = v;
    for (let i = 0; i < bytes; i++) {
      this.buf[this.len++] = Number(x & 0xffn);
      x >>= 8n;
    }
  }

  serializeU8(v: number) {
    this.le(BigInt(v), 1);
  }
  serializeBool(v: boolean) {
    this.serializeU8(v ? 1 : 0);
  }
  serializeU32(v: number) {
    this.le(BigInt(v), 4);
  }
  serializeU64(v: bigint | number) {
    this.le(BigInt(v), 8);
  }
  serializeU32AsUleb128(v: number) {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff)
      throw new Error("out of range for uleb128");
    let x = v;
    while (x >= 0x80) {
      this.serializeU8((x & 0x7f) | 0x80);
      x >>>= 7;
    }
    this.serializeU8(x);
  }
  serializeFixedBytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  serializeBytes(b: Uint8Array) {
    this.serializeU32AsUleb128(b.length);
    this.serializeFixedBytes(b);
  }
  serialize(v: { serialize(s: BcsWriter): void }) {
    v.serialize(this);
  }
  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export function aptosHexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("not hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function aptosBytesToHex(b: Uint8Array): Hex {
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** `TransactionArgument` variants, as Aptos numbers them. */
const ARG = { U64: 1, Address: 3, U8Vector: 4, U32: 7 } as const;

/**
 * The shapes the Aptos SDK gives these values (`U64.value`, `U32.value`, `AccountAddress.data`,
 * `MoveVector<U8>.values`), with the methods a wallet calls on them. A wallet cannot tell these from
 * the SDK's own: it only ever duck-types what a page passes in, since the page's copy of the SDK is
 * never the wallet's.
 */
abstract class Bcs {
  abstract serialize(s: BcsWriter): void;
  bcsToBytes(): Uint8Array {
    const s = new AptosBcsSerializer();
    this.serialize(s);
    return s.toUint8Array();
  }
  bcsToHex(): { toString(): string; toStringWithoutPrefix(): string; toUint8Array(): Uint8Array } {
    const bytes = this.bcsToBytes();
    const hex = aptosBytesToHex(bytes);
    return {
      toString: () => hex,
      toStringWithoutPrefix: () => hex.slice(2),
      toUint8Array: () => bytes,
    };
  }
  serializeForEntryFunction(s: BcsWriter) {
    s.serializeBytes(this.bcsToBytes());
  }
}

class MoveU64 extends Bcs {
  constructor(readonly value: bigint) {
    super();
  }
  serialize(s: BcsWriter) {
    s.serializeU64(this.value);
  }
  serializeForScriptFunction(s: BcsWriter) {
    s.serializeU32AsUleb128(ARG.U64);
    s.serialize(this);
  }
}

class MoveU32 extends Bcs {
  constructor(readonly value: number) {
    super();
  }
  serialize(s: BcsWriter) {
    s.serializeU32(this.value);
  }
  serializeForScriptFunction(s: BcsWriter) {
    s.serializeU32AsUleb128(ARG.U32);
    s.serialize(this);
  }
}

class MoveU8 extends Bcs {
  constructor(readonly value: number) {
    super();
  }
  serialize(s: BcsWriter) {
    s.serializeU8(this.value);
  }
}

class MoveAddress extends Bcs {
  readonly data: Uint8Array;
  constructor(hex: Hex) {
    super();
    const bytes = aptosHexToBytes(hex);
    if (bytes.length !== 32) throw new Error("an address is 32 bytes");
    this.data = bytes;
  }
  serialize(s: BcsWriter) {
    s.serializeFixedBytes(this.data);
  }
  serializeForScriptFunction(s: BcsWriter) {
    s.serializeU32AsUleb128(ARG.Address);
    s.serialize(this);
  }
  toString(): string {
    return aptosBytesToHex(this.data);
  }
  toStringLong(): string {
    return aptosBytesToHex(this.data);
  }
}

class MoveBytes extends Bcs {
  readonly values: MoveU8[];
  constructor(bytes: Uint8Array) {
    super();
    this.values = Array.from(bytes, (b) => new MoveU8(b));
  }
  serialize(s: BcsWriter) {
    s.serializeU32AsUleb128(this.values.length);
    for (const v of this.values) s.serialize(v);
  }
  serializeForScriptFunction(s: BcsWriter) {
    s.serializeU32AsUleb128(ARG.U8Vector);
    s.serialize(this);
  }
}

type ScriptArg = MoveU64 | MoveU32 | MoveAddress | MoveBytes;

/** The script's arguments in its order, as objects a wallet can serialize. */
export function aptosScriptArguments(a: AptosBurnArgs): ScriptArg[] {
  return [
    new MoveU64(a.amount),
    new MoveU32(a.destinationDomain),
    new MoveAddress(a.mintRecipient),
    new MoveAddress(a.destinationCaller),
    new MoveAddress(a.burnToken),
    new MoveU64(a.maxFee),
    new MoveU32(a.minFinalityThreshold),
    new MoveBytes(aptosHexToBytes(a.hookData)),
  ];
}

/**
 * What `aptos:signAndSubmitTransaction` 1.1 takes as `payload`: the Aptos SDK's
 * `InputScriptData`, the bytecode and the arguments. The wallet adds the sender, sequence number,
 * gas and expiry.
 */
export function aptosBurnPayload(a: AptosBurnArgs): {
  bytecode: Uint8Array;
  typeArguments: [];
  functionArguments: ScriptArg[];
} {
  return {
    bytecode: aptosHexToBytes(APTOS_BURN_SCRIPT),
    typeArguments: [],
    functionArguments: aptosScriptArguments(a),
  };
}

class ScriptPayload extends Bcs {
  readonly script: {
    bytecode: Uint8Array;
    type_args: [];
    args: ScriptArg[];
    serialize(s: BcsWriter): void;
  };
  constructor(a: AptosBurnArgs) {
    super();
    const args = aptosScriptArguments(a);
    this.script = {
      bytecode: aptosHexToBytes(APTOS_BURN_SCRIPT),
      type_args: [],
      args,
      serialize(s: BcsWriter) {
        s.serializeBytes(this.bytecode);
        s.serializeU32AsUleb128(0); // no type arguments
        s.serializeU32AsUleb128(this.args.length);
        for (const arg of this.args) arg.serializeForScriptFunction(s);
      },
    };
  }
  serialize(s: BcsWriter) {
    s.serializeU32AsUleb128(0); // TransactionPayload::Script
    this.script.serialize(s);
  }
}

/** `TransactionPayload::Script` for the burn, as bytes. */
export function aptosBurnPayloadBytes(a: AptosBurnArgs): Uint8Array {
  return new ScriptPayload(a).bcsToBytes();
}

/** Everything a transaction carries besides its payload. */
export interface AptosTxEnvelope {
  sender: Hex;
  sequenceNumber: bigint;
  maxGasAmount: bigint;
  gasUnitPrice: bigint;
  /** Unix seconds. */
  expirationTimestampSecs: bigint;
  chainId: number;
}

class ChainIdValue extends Bcs {
  constructor(readonly chainId: number) {
    super();
  }
  serialize(s: BcsWriter) {
    s.serializeU8(this.chainId);
  }
}

class RawTransaction extends Bcs {
  readonly sender: MoveAddress;
  readonly sequence_number: bigint;
  readonly payload: ScriptPayload;
  readonly max_gas_amount: bigint;
  readonly gas_unit_price: bigint;
  readonly expiration_timestamp_secs: bigint;
  readonly chain_id: ChainIdValue;
  constructor(a: AptosBurnArgs, e: AptosTxEnvelope) {
    super();
    const sender = normaliseAptosAddress(e.sender);
    if (!sender) throw new Error("not an Aptos address");
    this.sender = new MoveAddress(sender);
    this.sequence_number = e.sequenceNumber;
    this.payload = new ScriptPayload(a);
    this.max_gas_amount = e.maxGasAmount;
    this.gas_unit_price = e.gasUnitPrice;
    this.expiration_timestamp_secs = e.expirationTimestampSecs;
    this.chain_id = new ChainIdValue(e.chainId);
  }
  serialize(s: BcsWriter) {
    s.serialize(this.sender);
    s.serializeU64(this.sequence_number);
    s.serialize(this.payload);
    s.serializeU64(this.max_gas_amount);
    s.serializeU64(this.gas_unit_price);
    s.serializeU64(this.expiration_timestamp_secs);
    s.serialize(this.chain_id);
  }
}

class SimpleTransaction extends Bcs {
  readonly feePayerAddress = undefined;
  readonly secondarySignerAddresses = undefined;
  constructor(readonly rawTransaction: RawTransaction) {
    super();
  }
  serialize(s: BcsWriter) {
    s.serialize(this.rawTransaction);
    s.serializeBool(false); // no fee payer
  }
}

/**
 * The whole unsigned transaction in the Aptos SDK's `SimpleTransaction` shape, for wallets on
 * `aptos:signAndSubmitTransaction` 1.0, which take a built transaction rather than a payload.
 */
export function aptosBurnTransaction(a: AptosBurnArgs, e: AptosTxEnvelope): SimpleTransaction {
  return new SimpleTransaction(new RawTransaction(a, e));
}

/** `RawTransaction` as bytes. */
export function aptosRawTransactionBytes(a: AptosBurnArgs, e: AptosTxEnvelope): Uint8Array {
  return new RawTransaction(a, e).bcsToBytes();
}

/**
 * The body of `POST /v1/transactions/simulate` (`application/x.aptos.signed_transaction+bcs`):
 * the raw transaction with `SingleSender(NoAccountAuthenticator)`, which a fullnode simulates
 * without the sender's public key. It cannot be submitted: it carries no signature.
 */
export function aptosSimulationBytes(a: AptosBurnArgs, e: AptosTxEnvelope): Uint8Array {
  const s = new AptosBcsSerializer();
  s.serialize(new RawTransaction(a, e));
  s.serializeU32AsUleb128(4); // TransactionAuthenticator::SingleSender
  s.serializeU32AsUleb128(4); // AccountAuthenticator::NoAccountAuthenticator
  return s.toUint8Array();
}

/** A burn as an API step: the script and its arguments, for an Aptos wallet. */
export function buildAptosBurnStep(a: AptosBurnArgs, description: string): TransferStep {
  return {
    id: "burn",
    chain: "aptos",
    description,
    tx: {
      kind: "aptos",
      chainId: APTOS_CHAIN_ID,
      bytecode: APTOS_BURN_SCRIPT,
      arguments: aptosBurnArgsToJson(a),
    },
    expiresAt: null,
  };
}
