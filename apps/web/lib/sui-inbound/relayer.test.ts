import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { AlreadyMintedError, SuiCctpPausedError, readSuiBoundMessage } from "@xebra/sdk/build";
import { describe, expect, it, vi } from "vitest";
import { type InboundRelayDeps, inboundProblem, relayEvmToSui } from "./relayer";

/**
 * The real CCTP V2 message bound for Sui that the Stellar to Sui relayer is tested with (Sui
 * transaction C6C7hezp…, 2026-11-20, 32.359273 USDC), with its source domain rewritten to Arc (26).
 * Its `destinationCaller` is zero, as an EVM burn to Sui built by Xebra leaves it.
 */
const REAL =
  "0x000000010000000500000008faf94ea890456e4f8838f12c48cd4cf43d9ee9dcadd160905e36fae5f167173ba65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e93893f47842a2b5ac4483731927a7500175a9354d2eccd94312aa591ec50b9e8657e60000000000000000000000000000000000000000000000000000000000000000000003e8000003e800000001c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61e56ad8c14ab50d71625eeec43a6227b8d336fe90d737b8bac5dbfc53e853ac110000000000000000000000000000000000000000000000000000000001edc369e64f08d9eb0e2430e2e0c54c8cba74b3830ddd5041c2582654cd8c3ec3c348d400000000000000000000000000000000000000000000000000000000000019480000000000000000000000000000000000000000000000000000000000000ca3000000000000000000000000000000000000000000000000000001a1fda2facb";
const ARC = 26;
const ATTESTATION = `0x${"ab".repeat(130)}`;
const TX = `0x${"c3".repeat(32)}`;

function variant(edit: (m: Buffer) => void): string {
  const m = Buffer.from(REAL.slice(2), "hex");
  m.writeUInt32BE(ARC, 4);
  edit(m);
  return `0x${m.toString("hex")}`;
}
const MESSAGE = variant(() => {});
const parsed = (hex: string) => readSuiBoundMessage(Buffer.from(hex.slice(2), "hex"));

function deps(
  message = MESSAGE,
  over: Partial<InboundRelayDeps> = {},
): InboundRelayDeps & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => ({ digest: "SuiDigest222", ok: true }));
  return {
    key: new Ed25519Keypair(),
    client: {} as never,
    sources: [ARC],
    readAttestation: async () => ({ state: "complete", message, attestation: ATTESTATION }),
    buildSuiMint: async () => ({ transaction: "{}", message: parsed(message) }),
    execute,
    ...over,
  } as InboundRelayDeps & { execute: ReturnType<typeof vi.fn> };
}

describe("inboundProblem", () => {
  it("pays for an open burn to Sui of at least 1 USDC from the chain asked about", () => {
    expect(inboundProblem(parsed(MESSAGE), ARC)).toBeNull();
  });

  it("refuses a message from another chain than the one asked about", () => {
    expect(inboundProblem(parsed(MESSAGE), 6)).toMatch(/different chain/);
  });

  it("refuses a burn that names a caller (only that wallet can mint it)", () => {
    const named = variant((m) => m.fill(0x11, 108, 140));
    expect(inboundProblem(parsed(named), ARC)).toMatch(/only wallet that may mint/);
  });

  it("refuses dust below the floor", () => {
    const dust = variant((m) => {
      m.fill(0, 148 + 68, 148 + 100);
      m.writeUInt32BE(999_999, 148 + 96);
    });
    expect(parsed(dust).amount).toBe(999_999n);
    expect(inboundProblem(parsed(dust), ARC)).toMatch(/at least 1 USDC/);
  });
});

describe("relayEvmToSui", () => {
  it("is refused for a chain that does not send to Sui here, without asking Circle", async () => {
    const readAttestation = vi.fn();
    const d = deps(MESSAGE, { sources: [], readAttestation });
    expect((await relayEvmToSui(TX, ARC, d)).status).toBe("refused");
    expect(readAttestation).not.toHaveBeenCalled();
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("waits while Circle has not attested, without touching Sui", async () => {
    const d = deps(MESSAGE, { readAttestation: async () => ({ state: "pending" }) });
    expect(await relayEvmToSui(TX, ARC, d)).toEqual({ status: "pending" });
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("says unknown while Circle has not indexed the burn", async () => {
    const d = deps(MESSAGE, {
      readAttestation: async () => ({ state: "unknown", reason: "not indexed" }),
    });
    expect(await relayEvmToSui(TX, ARC, d)).toEqual({ status: "unknown", reason: "not indexed" });
  });

  it("reads the attestation for the chain asked about and mints with the relayer as sender", async () => {
    const readAttestation = vi.fn(async () => ({
      state: "complete" as const,
      message: MESSAGE,
      attestation: ATTESTATION,
    }));
    const build = vi.fn(async () => ({ transaction: "{}", message: parsed(MESSAGE) }));
    const d = deps(MESSAGE, { readAttestation, buildSuiMint: build });
    expect(await relayEvmToSui(TX, ARC, d)).toEqual({ status: "submitted", hash: "SuiDigest222" });
    expect(readAttestation).toHaveBeenCalledWith(TX, ARC);
    expect(build).toHaveBeenCalledWith(expect.anything(), {
      sender: d.key.toSuiAddress(),
      message: MESSAGE,
      attestation: ATTESTATION,
    });
  });

  it("refuses a message bound elsewhere (an Arc to Base burn), spending nothing", async () => {
    const toBase = variant((m) => m.writeUInt32BE(6, 8));
    const d = deps(toBase);
    const r = await relayEvmToSui(TX, ARC, d);
    expect(r).toMatchObject({ status: "refused" });
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("answers delivered for a transfer already minted, spending nothing", async () => {
    const d = deps(MESSAGE, {
      buildSuiMint: async () => {
        throw new AlreadyMintedError();
      },
    });
    expect(await relayEvmToSui(TX, ARC, d)).toEqual({ status: "delivered" });
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("waits while Circle has CCTP on Sui paused", async () => {
    const d = deps(MESSAGE, {
      buildSuiMint: async () => {
        throw new SuiCctpPausedError();
      },
    });
    expect((await relayEvmToSui(TX, ARC, d)).status).toBe("pending");
  });

  it("answers delivered when it loses the race to the recipient's own claim", async () => {
    let calls = 0;
    const d = deps(MESSAGE, {
      buildSuiMint: async () => {
        calls += 1;
        if (calls > 1) throw new AlreadyMintedError();
        return { transaction: "{}", message: parsed(MESSAGE) };
      },
    });
    d.execute.mockResolvedValueOnce({ digest: "Lost", ok: false, error: "abort 4" });
    expect(await relayEvmToSui(TX, ARC, d)).toEqual({ status: "delivered" });
  });

  it("reports a failed mint, and a retry after it tries again", async () => {
    const d = deps();
    vi.spyOn(console, "error").mockImplementation(() => {});
    d.execute.mockResolvedValueOnce({ digest: "Bad", ok: false, error: "out of gas" });
    expect(await relayEvmToSui(TX, ARC, d)).toMatchObject({ status: "failed", hash: "Bad" });
    expect(await relayEvmToSui(TX, ARC, d)).toEqual({ status: "submitted", hash: "SuiDigest222" });
    expect(d.execute).toHaveBeenCalledTimes(2);
  });

  it("does not send the same burn twice at once on one instance", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const d = deps(MESSAGE, {
      readAttestation: async () => {
        await gate;
        return { state: "complete", message: MESSAGE, attestation: ATTESTATION };
      },
    });
    const first = relayEvmToSui(TX, ARC, d);
    expect(await relayEvmToSui(TX, ARC, d)).toEqual({
      status: "pending",
      reason: "already being completed",
    });
    release();
    expect((await first).status).toBe("submitted");
    expect(d.execute).toHaveBeenCalledOnce();
  });
});
