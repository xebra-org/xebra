import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { describe, expect, it } from "vitest";
import {
  AlreadyMintedError,
  SuiCctpPausedError,
  buildSuiMint,
  mintMoveCalls,
  readSuiBoundMessage,
  receiveAbortCode,
} from "./sui-mint.js";

/**
 * A real Solana -> Sui message, minted on mainnet in Sui transaction
 * C6C7hezpxmCKGLwyk6kbC6mCFnmusZjfJcYn1dTVpnbS (2026-11-20): 32.359273 USDC burned, 0.003235 to
 * Circle, to 0xe56a…ac11, which also submitted the mint.
 */
const MESSAGE =
  "0x000000010000000500000008faf94ea890456e4f8838f12c48cd4cf43d9ee9dcadd160905e36fae5f167173ba65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e93893f47842a2b5ac4483731927a7500175a9354d2eccd94312aa591ec50b9e8657e60000000000000000000000000000000000000000000000000000000000000000000003e8000003e800000001c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61e56ad8c14ab50d71625eeec43a6227b8d336fe90d737b8bac5dbfc53e853ac110000000000000000000000000000000000000000000000000000000001edc369e64f08d9eb0e2430e2e0c54c8cba74b3830ddd5041c2582654cd8c3ec3c348d400000000000000000000000000000000000000000000000000000000000019480000000000000000000000000000000000000000000000000000000000000ca3000000000000000000000000000000000000000000000000000001a1fda2facb";
const RECIPIENT = "0xe56ad8c14ab50d71625eeec43a6227b8d336fe90d737b8bac5dbfc53e853ac11";
const ATTESTATION = `0x${"ab".repeat(130)}`;
const OTHER = `0x${"5".repeat(64)}`;

const MT = "0x16bcfcfc465f96281663a344641c017de84529370e11aa3879d0dce43ad6db87";
const TMM = "0xeb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830";
const HANDLER = "0x185ed207c4d64fc594882ab927f9f3c6ff957aad03df8a731ba64378faeeb2bf";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.slice(2).match(/../g) ?? [], (b) => Number.parseInt(b, 16));
}

function hex(b: Uint8Array): string {
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** The fixture with some bytes replaced, for messages Circle would not sign. */
function patched(offset: number, replacement: Uint8Array): string {
  const b = bytes(MESSAGE);
  b.set(replacement, offset);
  return hex(b);
}

describe("readSuiBoundMessage", () => {
  it("reads the real message", () => {
    const m = readSuiBoundMessage(bytes(MESSAGE));
    expect(m.sourceDomain).toBe(5);
    expect(m.recipient).toBe(RECIPIENT);
    expect(m.destinationCaller).toBeNull();
    expect(m.amount).toBe(32_359_273n);
    expect(m.feeExecuted).toBe(3_235n);
    expect(m.received).toBe(32_356_038n);
  });

  it("refuses a message bound for another chain", () => {
    expect(() => readSuiBoundMessage(bytes(patched(8, Uint8Array.of(0, 0, 0, 27))))).toThrow(
      "domain 27, not Sui",
    );
  });

  it("refuses a short message and a non-V2 one", () => {
    expect(() => readSuiBoundMessage(bytes(MESSAGE).subarray(0, 300))).toThrow("too short");
    expect(() => readSuiBoundMessage(bytes(patched(0, Uint8Array.of(0, 0, 0, 0))))).toThrow(
      "not a CCTP V2 message",
    );
  });

  it("reports a destination caller", () => {
    const m = readSuiBoundMessage(bytes(patched(108, bytes(OTHER))));
    expect(m.destinationCaller).toBe(OTHER);
  });
});

describe("mintMoveCalls", () => {
  it("is the four calls Circle's own mainnet mints run, wired the same way", () => {
    const data = mintMoveCalls({
      sender: RECIPIENT,
      message: MESSAGE,
      attestation: ATTESTATION,
    }).getData();
    const calls = data.commands.map((c) => c.MoveCall);
    expect(calls.map((c) => `${c?.package}::${c?.module}::${c?.function}`)).toEqual([
      `${MT}::receive_message::receive_message`,
      `${TMM}::handle_receive_message::prepare_mint`,
      `${HANDLER}::handler::mint`,
      `${TMM}::handle_receive_message::complete_mint`,
    ]);
    expect(calls[1]?.typeArguments).toEqual([USDC]);
    expect(calls[3]?.typeArguments).toEqual([USDC, `${HANDLER}::handler::Auth`]);

    // Each call takes the previous one's result where Circle's does.
    expect(calls[1]?.arguments[0]).toEqual({ $kind: "NestedResult", NestedResult: [0, 0] });
    expect(calls[2]?.arguments[1]).toEqual({ $kind: "NestedResult", NestedResult: [1, 0] });
    expect(calls[3]?.arguments[0]).toEqual({ $kind: "NestedResult", NestedResult: [2, 0] });

    // The shared objects, by ID: MT state, TMM state, clock, handler state, treasury, deny list.
    const objects = data.inputs
      .filter((i) => i.UnresolvedObject)
      .map((i) => i.UnresolvedObject?.objectId);
    expect(objects).toEqual([
      "0x0c067f7d325e5b60e3179712e7783534ba1556cbb3d359d8161497e37689230c",
      "0x06fb166941cd7bc095edc019d054a753ec3f1e4c25f28f2ecc4a6cfa0a9b1167",
      "0x0000000000000000000000000000000000000000000000000000000000000006",
      "0xa32de8a6dd0178fb05f662929d55cddb69a25c26bde4b83f89e36d17ead94c41",
      "0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7",
      "0x0000000000000000000000000000000000000000000000000000000000000403",
    ]);
  });
});

describe("receiveAbortCode", () => {
  it("reads the used-nonce abort seen on mainnet", () => {
    const seen = `Transaction resolution failed: MoveAbort in 1st command, abort code: 4, in '${MT}::receive_message::receive_message_shared' (instruction 83)`;
    expect(receiveAbortCode(seen)).toBe(4);
  });

  it("reads the other shape a node returns, as seen from the web server", () => {
    const seen =
      "Transaction fails in simulation: Move Runtime Abort. Location: 16bcfcfc465f96281663a344641c017de84529370e11aa3879d0dce43ad6db87::receive_message::receive_message_shared (function index 15) at offset 83, Abort Code: 4 in command 0";
    expect(receiveAbortCode(seen)).toBe(4);
    expect(receiveAbortCode(encodeURIComponent(seen))).toBe(4);
  });

  it("ignores the same code from another package or module", () => {
    expect(receiveAbortCode(`abort code: 4, in '${TMM}::receive_message::x'`)).toBeNull();
    expect(receiveAbortCode(`abort code: 4, in '${MT}::state::x'`)).toBeNull();
    expect(receiveAbortCode("network error")).toBeNull();
  });
});

describe("buildSuiMint", () => {
  const failing = (message: string) =>
    ({
      // `tx.build` asks the client to resolve the transaction; this one fails the way a node does.
      core: {
        resolveTransactionPlugin: () => async () => {
          throw new Error(message);
        },
      },
    }) as unknown as SuiGrpcClient;

  it("refuses a wallet the burn did not name as its caller, before asking the node", async () => {
    const message = patched(108, bytes(OTHER));
    await expect(
      buildSuiMint({} as SuiGrpcClient, { sender: RECIPIENT, message, attestation: ATTESTATION }),
    ).rejects.toThrow(`Only ${OTHER}`);
  });

  it("reports an already-minted transfer as such", async () => {
    const client = failing(
      `MoveAbort in 1st command, abort code: 4, in '${MT}::receive_message::receive_message_shared'`,
    );
    await expect(
      buildSuiMint(client, { sender: RECIPIENT, message: MESSAGE, attestation: ATTESTATION }),
    ).rejects.toBeInstanceOf(AlreadyMintedError);
  });

  it("reports Circle's pause as such", async () => {
    const client = failing(
      `MoveAbort in 1st command, abort code: 0, in '${MT}::receive_message::receive_message_shared'`,
    );
    await expect(
      buildSuiMint(client, { sender: RECIPIENT, message: MESSAGE, attestation: ATTESTATION }),
    ).rejects.toBeInstanceOf(SuiCctpPausedError);
  });
});
