import { createHash } from "node:crypto";
import { FORWARD_HOOK, ZERO_BYTES32, forwardHookWithAccount } from "@xebra/cctp-evm";
import { describe, expect, it } from "vitest";
import {
  STELLAR_CCTP_FORWARDER,
  forwarderAsSuiAddress,
  parseMessage,
  stellarBurnRecipient,
  stellarForwardHook,
  verifyMessage,
} from "../core/cctp/sui-stellar.js";
import {
  APTOS_BURN_SCRIPT,
  APTOS_CCTP,
  APTOS_DOMAIN,
  AptosBcsSerializer,
  type AptosBurnArgs,
  type BcsWriter,
  aptosBurnArgs,
  aptosBurnArgsFromJson,
  aptosBurnArgsToJson,
  aptosBurnPayload,
  aptosBurnPayloadBytes,
  aptosBurnTransaction,
  aptosBytesToHex,
  aptosHexToBytes,
  aptosRawTransactionBytes,
  aptosSimulationBytes,
  normaliseAptosAddress,
} from "./aptos.js";

const EVM_RECIPIENT = "0x1111111111111111111111111111111111111111";
const STELLAR_G = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const STELLAR_TOKEN_MESSENGER = "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL";
const ATA = `0x${"ab".repeat(32)}` as const;
const OWNER = `0x${"cd".repeat(32)}` as const;
const SENDER = "0x744bf58c5562a9ebc71ef07743e8e3385eec8e5743fde745d937ba22d37e9eb1";

/**
 * CCTP messages Aptos mainnet emitted (`message_transmitter::MessageSent`) when the burns these
 * arguments build were simulated against the mainnet fullnode on 2026-11-13, from the account
 * above: 1 USDC to Base with a 0.06 fee, 2 USDC to a Solana token account Circle must open, and
 * 1 USDC to Stellar. Simulation only; nothing was submitted. Real bytes, so a mistake in the
 * encoder cannot hide behind the same mistake in a hand-built fixture.
 */
const SIMULATED = {
  base: "AAAAAQAAAAkAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABS9HMrHLUs4o9ZXimXhFATJ3L4gncYLhK8Qx+qZ3vmAwAAAAAAAAAAAAAAACi1oOnGIaW62qU2IZs6IoyBaM9dAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfQAAAAAAAAAAG64gdlnbiL6gy+rW2g7QCqwS7c3aFp5ZHNQclBgLRvOwAAAAAAAAAAAAAAABERERERERERERERERERERERERERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPQkB0S/WMVWKp68ce8HdD6OM4XuyOV0P950XZN7oi036esQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOpgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGNjdHAtZm9yd2FyZAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  solanaOpen:
    "AAAAAQAAAAkAAAAFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABS9HMrHLUs4o9ZXimXhFATJ3L4gncYLhK8Qx+qZ3vmA6ZfyB0P76iGDLO4PwibAiS+imaHt65J9ZTAubTX6TiTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfQAAAAAAAAAAG64gdlnbiL6gy+rW2g7QCqwS7c3aFp5ZHNQclBgLRvO6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAehIB0S/WMVWKp68ce8HdD6OM4XuyOV0P950XZN7oi036esQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABhqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGNjdHAtZm9yd2FyZAAAAAAAAAAAAAAAAAAAAAAAAAAhAc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3N",
  stellar:
    "AAAAAQAAAAkAAAAbAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABS9HMrHLUs4o9ZXimXhFATJ3L4gncYLhK8Qx+qZ3vmAwmjdz/9H/Nh+DFdYprfF9Pkcw/QCmkAcVQx7UsUKt7Scr0g/y+CgYAbsFt8KReQJpMyVvq6/rE+lO/Y3bz88pEAAAfQAAAAAAAAAAG64gdlnbiL6gy+rW2g7QCqwS7c3aFp5ZHNQclBgLRvO3K9IP8vgoGAG7BbfCkXkCaTMlb6uv6xPpTv2N28/PKRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPQkB0S/WMVWKp68ce8HdD6OM4XuyOV0P950XZN7oi036esQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4R0JaWE43UElSWkdOTUhHQTdNVVVVRjRHV1BZNUFZUFY2TFk0VVYyR0w2VkpHSVFSWEZETk1BREk=",
};
const real = (k: keyof typeof SIMULATED) => Buffer.from(SIMULATED[k], "base64");

/** `maxFee` sits at bytes 132..164 of the burn body, which starts at 148. */
const maxFeeOf = (m: Buffer) => BigInt(`0x${m.subarray(148 + 132, 148 + 164).toString("hex")}`);

const hex = (b: Buffer | Uint8Array) => Buffer.from(b).toString("hex");

describe("APTOS_BURN_SCRIPT", () => {
  const bytes = Buffer.from(aptosHexToBytes(APTOS_BURN_SCRIPT));

  it("is Circle's mainnet V2 deposit_for_burn_with_hook.mv, byte for byte", () => {
    expect(bytes.length).toBe(639);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "a06ef2513f2406f72c396e76ac7825791a9b229567b14ae56be8e04ccbc697c3",
    );
    expect(hex(bytes.subarray(0, 4))).toBe("a11ceb0b"); // Move bytecode magic
  });

  it("calls the mainnet token messenger and handler, and no testnet package", () => {
    const all = hex(bytes);
    expect(all).toContain(APTOS_CCTP.tokenMessengerMinterV2.slice(2));
    expect(all).toContain(APTOS_CCTP.stablecoinHandler.slice(2));
    // Testnet's TokenMessengerMinterV2 and StablecoinHandler.
    expect(all).not.toContain("c601d3f7b89b77b552726d5d84cbf2a6d3e8a73adbbee3f09fad169a3286bb59");
    expect(all).not.toContain("e5d19c4eb6e1e42c5435901fc6153fd19f6615651be0e6cefe0f07226d4a6846");
    expect(bytes.includes(Buffer.from("deposit_for_burn_with_hook"))).toBe(true);
  });
});

describe("normaliseAptosAddress", () => {
  it("pads short forms and lower-cases", () => {
    expect(normaliseAptosAddress("0x1")).toBe(`0x${"0".repeat(63)}1`);
    expect(normaliseAptosAddress(` ${SENDER.toUpperCase().replace("0X", "0x")} `)).toBe(SENDER);
  });
  it("refuses anything that is not 0x and up to 64 hex digits", () => {
    expect(normaliseAptosAddress(SENDER.slice(2))).toBeNull();
    expect(normaliseAptosAddress(`${SENDER}0`)).toBeNull();
    expect(normaliseAptosAddress("0x")).toBeNull();
    expect(normaliseAptosAddress("0xzz")).toBeNull();
  });
});

describe("aptosBurnArgs", () => {
  it("forwards to an EVM chain: padded address, Circle's hook, open caller, USDC, Standard", () => {
    const a = aptosBurnArgs({
      amount: 1_000_000n,
      destinationDomain: 6,
      recipient: EVM_RECIPIENT,
      maxFee: 60_000n,
    });
    expect(a).toEqual({
      amount: 1_000_000n,
      destinationDomain: 6,
      mintRecipient: `0x${"00".repeat(12)}${EVM_RECIPIENT.slice(2)}`,
      destinationCaller: ZERO_BYTES32,
      burnToken: APTOS_CCTP.usdc,
      maxFee: 60_000n,
      minFinalityThreshold: 2000,
      hookData: FORWARD_HOOK,
    });
  });

  it("mints to the Solana token account, with the 65-byte hook when Circle opens it", () => {
    const plain = aptosBurnArgs({
      amount: 1_000_000n,
      destinationDomain: 5,
      recipient: { kind: "solana", tokenAccount: ATA },
      maxFee: 200_000n,
    });
    expect(plain.mintRecipient).toBe(ATA);
    expect(plain.hookData).toBe(FORWARD_HOOK);
    expect(plain.destinationCaller).toBe(ZERO_BYTES32);
    const open = aptosBurnArgs({
      amount: 2_000_000n,
      destinationDomain: 5,
      recipient: { kind: "solana", tokenAccount: ATA, createAccountFor: OWNER },
      maxFee: 400_000n,
    });
    expect(open.mintRecipient).toBe(ATA);
    expect(open.hookData).toBe(forwardHookWithAccount(OWNER));
    expect(aptosHexToBytes(open.hookData).length).toBe(65);
  });

  it("sends Stellar burns to the CctpForwarder as recipient AND caller, hook naming the account", () => {
    const a = aptosBurnArgs({
      amount: 1_000_000n,
      destinationDomain: 27,
      recipient: stellarBurnRecipient(STELLAR_G),
      maxFee: 0n,
    });
    const forwarder = forwarderAsSuiAddress(STELLAR_CCTP_FORWARDER);
    expect(a.mintRecipient).toBe(forwarder);
    expect(a.destinationCaller).toBe(forwarder);
    expect(a.destinationCaller).not.toBe(ZERO_BYTES32);
    expect(a.hookData).toBe(aptosBytesToHex(stellarForwardHook(STELLAR_G)));
    expect(a.maxFee).toBe(0n);
  });

  it("refuses every combination that would strand the USDC or cannot succeed", () => {
    const ok = { amount: 1_000_000n, destinationDomain: 6, recipient: EVM_RECIPIENT, maxFee: 1n };
    // An EVM address to Solana is a valid-looking account nobody owns.
    expect(() => aptosBurnArgs({ ...ok, destinationDomain: 5 })).toThrow("token account");
    // A Solana token account anywhere but Solana.
    expect(() =>
      aptosBurnArgs({ ...ok, recipient: { kind: "solana", tokenAccount: ATA } }),
    ).toThrow();
    // A Stellar recipient anywhere but Stellar, and anything but the forwarder to Stellar.
    expect(() => aptosBurnArgs({ ...ok, recipient: stellarBurnRecipient(STELLAR_G) })).toThrow(
      "Stellar",
    );
    expect(() => aptosBurnArgs({ ...ok, destinationDomain: 27, maxFee: 0n })).toThrow("forwarder");
    // Fees: forwarding must pay, Stellar must not, and never the whole amount.
    expect(() => aptosBurnArgs({ ...ok, maxFee: 0n })).toThrow("above zero");
    expect(() =>
      aptosBurnArgs({
        ...ok,
        destinationDomain: 27,
        recipient: stellarBurnRecipient(STELLAR_G),
        maxFee: 1n,
      }),
    ).toThrow("zero");
    expect(() => aptosBurnArgs({ ...ok, maxFee: 1_000_000n })).toThrow("below the amount");
    expect(() => aptosBurnArgs({ ...ok, maxFee: -1n })).toThrow();
    expect(() => aptosBurnArgs({ ...ok, amount: 0n })).toThrow("positive");
    expect(() => aptosBurnArgs({ ...ok, amount: 1n << 64n, maxFee: 1n })).toThrow("u64");
    expect(() => aptosBurnArgs({ ...ok, destinationDomain: APTOS_DOMAIN })).toThrow("Aptos");
    expect(() =>
      aptosBurnArgs({ ...ok, recipient: "0x0000000000000000000000000000000000000000" }),
    ).toThrow("zero address");
  });
});

describe("the messages Aptos mainnet emitted for these arguments", () => {
  it("to Base: the recipient, Circle's hook, an open caller and the fee", () => {
    const m = parseMessage(real("base"));
    expect(m.sourceDomain).toBe(9);
    expect(m.destinationDomain).toBe(6);
    expect(m.amount).toBe(1_000_000n);
    expect(hex(m.mintRecipient)).toBe(`${"00".repeat(12)}${EVM_RECIPIENT.slice(2)}`);
    expect(hex(m.destinationCaller)).toBe("00".repeat(32));
    expect(`0x${hex(m.hookData)}`).toBe(FORWARD_HOOK);
    expect(maxFeeOf(real("base"))).toBe(60_000n);
  });

  it("to Solana: the token account, and the hook that has Circle open it for the owner", () => {
    const m = parseMessage(real("solanaOpen"));
    expect(m.destinationDomain).toBe(5);
    expect(`0x${hex(m.mintRecipient)}`).toBe(ATA);
    expect(`0x${hex(m.hookData)}`).toBe(forwardHookWithAccount(OWNER));
    expect(hex(m.destinationCaller)).toBe("00".repeat(32));
  });

  it("to Stellar: passes the relayer's checks for an Aptos source and pays the right account", () => {
    const burn = verifyMessage(real("stellar"), {
      tokenMessenger: STELLAR_TOKEN_MESSENGER,
      sources: [APTOS_DOMAIN],
    });
    expect(burn).toEqual({ amount: 1_000_000n, recipient: STELLAR_G, sourceDomain: 9 });
    const m = parseMessage(real("stellar"));
    const forwarder = forwarderAsSuiAddress(STELLAR_CCTP_FORWARDER).slice(2);
    expect(hex(m.mintRecipient)).toBe(forwarder);
    expect(hex(m.destinationCaller)).toBe(forwarder);
    expect(maxFeeOf(real("stellar"))).toBe(0n);
    // Only accepted when Aptos is an allowed source.
    expect(() =>
      verifyMessage(real("stellar"), { tokenMessenger: STELLAR_TOKEN_MESSENGER }),
    ).toThrow("Sui");
  });
});

const BASE_ARGS: AptosBurnArgs = aptosBurnArgs({
  amount: 1_000_000n,
  destinationDomain: 6,
  recipient: EVM_RECIPIENT,
  maxFee: 60_000n,
});

const le = (v: bigint, n: number) => {
  const out = Buffer.alloc(n);
  let x = v;
  for (let i = 0; i < n; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
};

/** The script payload written out by hand from the BCS rules, independent of the encoder. */
function expectedPayload(a: AptosBurnArgs): Buffer {
  const code = Buffer.from(aptosHexToBytes(APTOS_BURN_SCRIPT));
  const hook = Buffer.from(aptosHexToBytes(a.hookData));
  const addr = (h: string) => Buffer.concat([Buffer.from([3]), Buffer.from(h.slice(2), "hex")]);
  return Buffer.concat([
    Buffer.from([0x00]), // TransactionPayload::Script
    Buffer.from([0xff, 0x04]), // uleb128(639)
    code,
    Buffer.from([0x00]), // no type arguments
    Buffer.from([0x08]), // eight arguments
    Buffer.from([1]),
    le(a.amount, 8),
    Buffer.from([7]),
    le(BigInt(a.destinationDomain), 4),
    addr(a.mintRecipient),
    addr(a.destinationCaller),
    addr(a.burnToken),
    Buffer.from([1]),
    le(a.maxFee, 8),
    Buffer.from([7]),
    le(BigInt(a.minFinalityThreshold), 4),
    Buffer.from([4, hook.length]),
    hook,
  ]);
}

describe("BCS", () => {
  it("writes the script payload exactly as the rules say", () => {
    expect(hex(aptosBurnPayloadBytes(BASE_ARGS))).toBe(hex(expectedPayload(BASE_ARGS)));
    const stellar = aptosBurnArgs({
      amount: 1_000_000n,
      destinationDomain: 27,
      recipient: stellarBurnRecipient(STELLAR_G),
      maxFee: 0n,
    });
    expect(hex(aptosBurnPayloadBytes(stellar))).toBe(hex(expectedPayload(stellar)));
  });

  it("writes uleb128 lengths past one byte", () => {
    const s = new AptosBcsSerializer();
    s.serializeU32AsUleb128(127);
    s.serializeU32AsUleb128(128);
    s.serializeU32AsUleb128(16384);
    expect(hex(s.toUint8Array())).toBe("7f" + "8001" + "808001");
  });

  /**
   * A wallet serializes what the page hands it with its own copy of the Aptos SDK. This stands in
   * for that serializer: a different object with only the method names, so the arguments must
   * write themselves through it and arrive at the same bytes.
   */
  it("serializes through a wallet's own serializer to the same bytes", () => {
    const parts: number[] = [];
    const push = (b: Iterable<number>) => {
      for (const x of b) parts.push(x);
    };
    const uleb = (v: number) => {
      let x = v;
      while (x >= 0x80) {
        parts.push((x & 0x7f) | 0x80);
        x >>>= 7;
      }
      parts.push(x);
    };
    const foreign: BcsWriter = {
      serializeU8: (v) => parts.push(v),
      serializeBool: (v) => parts.push(v ? 1 : 0),
      serializeU32: (v) => push(le(BigInt(v), 4)),
      serializeU64: (v) => push(le(BigInt(v), 8)),
      serializeU32AsUleb128: uleb,
      serializeFixedBytes: (b) => push(b),
      serializeBytes: (b) => {
        uleb(b.length);
        push(b);
      },
      serialize: (v) => v.serialize(foreign),
    };
    const payload = aptosBurnPayload(BASE_ARGS);
    // What the Aptos SDK's `Script.serialize` does with an `InputScriptData`.
    foreign.serializeU32AsUleb128(0);
    foreign.serializeBytes(payload.bytecode);
    foreign.serializeU32AsUleb128(payload.typeArguments.length);
    foreign.serializeU32AsUleb128(payload.functionArguments.length);
    for (const arg of payload.functionArguments) arg.serializeForScriptFunction(foreign);
    expect(Buffer.from(parts).toString("hex")).toBe(hex(expectedPayload(BASE_ARGS)));
  });

  it("gives the SDK's field shapes to each argument", () => {
    const [amount, domain, recipient, , , , , hook] = aptosBurnPayload(BASE_ARGS).functionArguments;
    expect(amount).toMatchObject({ value: 1_000_000n });
    expect(domain).toMatchObject({ value: 6 });
    expect(recipient && "data" in recipient && hex(recipient.data)).toBe(
      BASE_ARGS.mintRecipient.slice(2),
    );
    expect(hook && "values" in hook && hook.values.length).toBe(32);
  });

  const envelope = {
    sender: SENDER as `0x${string}`,
    sequenceNumber: 330n,
    maxGasAmount: 20_000n,
    gasUnitPrice: 100n,
    expirationTimestampSecs: 1_800_000_000n,
    chainId: 1,
  };

  it("lays out a raw transaction: sender, sequence, payload, gas, expiry, chain", () => {
    const raw = Buffer.from(aptosRawTransactionBytes(BASE_ARGS, envelope));
    const payload = expectedPayload(BASE_ARGS);
    expect(hex(raw)).toBe(
      hex(
        Buffer.concat([
          Buffer.from(SENDER.slice(2), "hex"),
          le(330n, 8),
          payload,
          le(20_000n, 8),
          le(100n, 8),
          le(1_800_000_000n, 8),
          Buffer.from([1]),
        ]),
      ),
    );
    // The SimpleTransaction a 1.0 wallet takes: the raw transaction, then "no fee payer".
    const simple = aptosBurnTransaction(BASE_ARGS, envelope);
    expect(hex(simple.bcsToBytes())).toBe(`${hex(raw)}00`);
    expect(simple.rawTransaction.sequence_number).toBe(330n);
    expect(simple.rawTransaction.chain_id.chainId).toBe(1);
  });

  it("simulates without a key: SingleSender(NoAccountAuthenticator)", () => {
    const sim = Buffer.from(aptosSimulationBytes(BASE_ARGS, envelope));
    expect(hex(sim)).toBe(`${hex(aptosRawTransactionBytes(BASE_ARGS, envelope))}0404`);
  });
});

describe("JSON", () => {
  it("round-trips, and refuses a burn token other than native USDC", () => {
    const j = aptosBurnArgsToJson(BASE_ARGS);
    expect(JSON.parse(JSON.stringify(j))).toEqual(j);
    expect(aptosBurnArgsFromJson(j)).toEqual(BASE_ARGS);
    expect(() => aptosBurnArgsFromJson({ ...j, burnToken: `0x${"11".repeat(32)}` })).toThrow(
      "USDC",
    );
    expect(() => aptosBurnArgsFromJson({ ...j, maxFee: j.amount })).toThrow();
    expect(() => aptosBurnArgsFromJson({ ...j, amount: "1.5" })).toThrow();
    expect(() => aptosBurnArgsFromJson({ ...j, mintRecipient: "0x11" })).toThrow();
    expect(() => aptosBurnArgsFromJson({ ...j, hookData: "0x1" })).toThrow();
  });
});
