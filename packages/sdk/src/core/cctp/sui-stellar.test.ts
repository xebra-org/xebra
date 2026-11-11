import { StrKey } from "@stellar/stellar-base";
import { describe, expect, it } from "vitest";
import {
  STELLAR_CCTP_FORWARDER,
  burnDestinationCaller,
  forwarderAsSuiAddress,
  parseMessage,
  stellarForwardHook,
  verifyMessage,
} from "./sui-stellar.js";

const TOKEN_MESSENGER = "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL";
const RECIPIENT = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

/**
 * The CCTP message Sui's mainnet contracts emitted when this exact burn was simulated on 2026-11-05
 * (1 USDC, destination domain 27, recipient above). Real bytes, not a hand-built imitation, so a
 * layout mistake in the parser cannot hide behind a matching mistake in the fixture.
 */
const REAL_MESSAGE = Buffer.from(
  "AAAAAQAAAAgAAAAbAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD0eEKitaxEg3MZJ6dQAXWpNU0uzNlDEqpZHsULnoZX5gmjdz/9H/Nh+DFdYprfF9Pkcw/QCmkAcVQx7UsUKt7SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfQAAAAAAAAAAE/LijRY+JQQqx8lUPBVnWvWqXTwn28ZWpn839Ck6P973K9IP8vgoGAG7BbfCkXkCaTMlb6uv6xPpTv2N28/PKRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPQkCfY0JXCQaTNv7BCL1LppqPPSPoqyNzEfPOWK4rsO1NfwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4R0JaWE43UElSWkdOTUhHQTdNVVVVRjRHV1BZNUFZUFY2TFk0VVYyR0w2VkpHSVFSWEZETk1BREk=",
  "base64",
);

function tampered(offset: number, value: number): Buffer {
  const copy = Buffer.from(REAL_MESSAGE);
  copy[offset] = value;
  return copy;
}

/** Header bytes 108..140 are the message's destinationCaller. */
function withCaller(caller: Buffer): Buffer {
  const copy = Buffer.from(REAL_MESSAGE);
  caller.copy(copy, 108);
  return copy;
}

function forwarderBytes(): Buffer {
  return Buffer.from(StrKey.decodeContract(STELLAR_CCTP_FORWARDER));
}

describe("burnDestinationCaller", () => {
  // Circle: on a burn to Stellar, BOTH mintRecipient and destinationCaller must be the
  // CctpForwarder. With a zero caller anyone can call receive_message directly, which mints into
  // the forwarder without paying the recipient, and the USDC is stuck for good.
  it("is the forwarder, never zero", () => {
    expect(burnDestinationCaller()).toBe(forwarderAsSuiAddress());
    expect(burnDestinationCaller()).toBe(`0x${forwarderBytes().toString("hex")}`);
    expect(BigInt(burnDestinationCaller())).not.toBe(0n);
  });
});

describe("stellarForwardHook", () => {
  it("is the 32-byte header plus the address text", () => {
    const hook = Buffer.from(stellarForwardHook(RECIPIENT));
    expect(hook.length).toBe(32 + 56);
    expect(hook.readUInt32BE(24)).toBe(0);
    expect(hook.readUInt32BE(28)).toBe(56);
    expect(hook.subarray(32).toString()).toBe(RECIPIENT);
  });

  it("rejects something that is not a Stellar address", () => {
    expect(() => stellarForwardHook("0xabc")).toThrow(/Invalid Stellar address/);
  });

  it("matches the hook inside a message Sui really emitted", () => {
    const parsed = parseMessage(REAL_MESSAGE);
    expect(Buffer.from(stellarForwardHook(RECIPIENT)).equals(parsed.hookData)).toBe(true);
  });
});

describe("parseMessage", () => {
  it("reads a real Sui to Stellar burn", () => {
    const p = parseMessage(REAL_MESSAGE);
    expect(p.sourceDomain).toBe(8);
    expect(p.destinationDomain).toBe(27);
    expect(p.amount).toBe(1_000_000n);
    expect(p.destinationCaller.equals(Buffer.alloc(32))).toBe(true);
    expect(`0x${p.mintRecipient.toString("hex")}`).toBe(forwarderAsSuiAddress());
  });

  it("refuses a message that is too short", () => {
    expect(() => parseMessage(REAL_MESSAGE.subarray(0, 100))).toThrow(/too short/);
  });
});

describe("verifyMessage", () => {
  it("accepts the real burn and returns the recipient from the hook", () => {
    const v = verifyMessage(REAL_MESSAGE, { tokenMessenger: TOKEN_MESSENGER });
    expect(v).toEqual({ amount: 1_000_000n, recipient: RECIPIENT });
  });

  it("refuses a burn from another source chain", () => {
    expect(() => verifyMessage(tampered(7, 6), { tokenMessenger: TOKEN_MESSENGER })).toThrow(
      /from Sui/,
    );
  });

  it("refuses a burn aimed at another destination", () => {
    expect(() => verifyMessage(tampered(11, 5), { tokenMessenger: TOKEN_MESSENGER })).toThrow(
      /to Stellar/,
    );
  });

  it("refuses a message addressed to a different token messenger", () => {
    expect(() => verifyMessage(REAL_MESSAGE, { tokenMessenger: STELLAR_CCTP_FORWARDER })).toThrow(
      /token messenger/,
    );
  });

  it("refuses a burn that does not mint to our forwarder", () => {
    // Byte 148 + 36 is the first byte of the body's mintRecipient.
    expect(() =>
      verifyMessage(tampered(148 + 36, 0xff), { tokenMessenger: TOKEN_MESSENGER }),
    ).toThrow(/CctpForwarder/);
  });

  it("accepts a burn whose destinationCaller is the forwarder (every burn built since the fix)", () => {
    const v = verifyMessage(withCaller(forwarderBytes()), { tokenMessenger: TOKEN_MESSENGER });
    expect(v).toEqual({ amount: 1_000_000n, recipient: RECIPIENT });
  });

  it("still accepts a zero destinationCaller, so burns made before the fix can be finished", () => {
    const v = verifyMessage(withCaller(Buffer.alloc(32)), { tokenMessenger: TOKEN_MESSENGER });
    expect(v.recipient).toBe(RECIPIENT);
  });

  it("refuses any other destinationCaller: mint_and_forward could not complete it", () => {
    expect(() =>
      verifyMessage(withCaller(Buffer.alloc(32, 0xab)), { tokenMessenger: TOKEN_MESSENGER }),
    ).toThrow(/destinationCaller/);
  });

  it("refuses a hook whose declared length is wrong", () => {
    // The hook's length field is the last byte before the address text: body offset 228 + 31.
    expect(() =>
      verifyMessage(tampered(148 + 228 + 31, 55), { tokenMessenger: TOKEN_MESSENGER }),
    ).toThrow(/length/);
  });

  it("refuses a hook that does not name a Stellar address", () => {
    expect(() =>
      verifyMessage(tampered(148 + 228 + 32, 0x58), { tokenMessenger: TOKEN_MESSENGER }),
    ).toThrow(/Stellar address/);
  });
});
