import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { AlreadyMintedError, readSuiBoundMessage } from "@xebra/sdk/build";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type RelayDeps,
  type WrapperBurn,
  burnProblem,
  readWrapperBurn,
  relayStellarToSui,
  suiRelayerKey,
} from "./relayer";

/**
 * A real CCTP V2 message bound for Sui (Sui transaction C6C7hezp…, 2026-11-20): 32.359273 USDC to
 * 0xe56a…ac11. The relayer reads only its Sui half, so its Solana source does not matter here.
 */
const MESSAGE =
  "0x000000010000000500000008faf94ea890456e4f8838f12c48cd4cf43d9ee9dcadd160905e36fae5f167173ba65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e93893f47842a2b5ac4483731927a7500175a9354d2eccd94312aa591ec50b9e8657e60000000000000000000000000000000000000000000000000000000000000000000003e8000003e800000001c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61e56ad8c14ab50d71625eeec43a6227b8d336fe90d737b8bac5dbfc53e853ac110000000000000000000000000000000000000000000000000000000001edc369e64f08d9eb0e2430e2e0c54c8cba74b3830ddd5041c2582654cd8c3ec3c348d400000000000000000000000000000000000000000000000000000000000019480000000000000000000000000000000000000000000000000000000000000ca3000000000000000000000000000000000000000000000000000001a1fda2facb";
const RECIPIENT = "0xe56ad8c14ab50d71625eeec43a6227b8d336fe90d737b8bac5dbfc53e853ac11";
const AMOUNT = 32_359_273n;
const ATTESTATION = `0x${"ab".repeat(130)}`;
const TX = "a".repeat(64);

const message = readSuiBoundMessage(Buffer.from(MESSAGE.slice(2), "hex"));
const xebraBurn: WrapperBurn = {
  destinationDomain: 8,
  mintRecipient: RECIPIENT,
  // Stellar's 7 decimals against the message's 6.
  netBurned: AMOUNT * 10n,
  forwarded: false,
};

function deps(over: Partial<RelayDeps> = {}): RelayDeps & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => ({ digest: "SuiDigest111", ok: true }));
  return {
    key: new Ed25519Keypair(),
    client: {} as never,
    readAttestation: async () => ({
      state: "complete",
      message: MESSAGE,
      attestation: ATTESTATION,
    }),
    wrapperBurnIn: async () => xebraBurn,
    buildSuiMint: async () => ({ transaction: "{}", message }),
    execute,
    ...over,
  } as RelayDeps & { execute: ReturnType<typeof vi.fn> };
}

describe("readWrapperBurn", () => {
  it("reads the wrapper's bridge_initiated fields", () => {
    const recipient = Buffer.from(RECIPIENT.slice(2), "hex");
    expect(
      readWrapperBurn({
        destination_domain: 8,
        mint_recipient: recipient,
        net_burned: AMOUNT * 10n,
        forwarded: false,
        fee: 1n,
      }),
    ).toEqual(xebraBurn);
  });

  it("refuses data that is not a bridge event", () => {
    expect(readWrapperBurn(null)).toBeNull();
    expect(readWrapperBurn({ destination_domain: 8 })).toBeNull();
    expect(
      readWrapperBurn({
        destination_domain: 8,
        mint_recipient: new Uint8Array(20),
        net_burned: 1n,
      }),
    ).toBeNull();
  });
});

describe("burnProblem", () => {
  it("pays for a Xebra burn that matches Circle's message", () => {
    expect(burnProblem(xebraBurn, message)).toBeNull();
  });

  it("does not pay for a burn made outside Xebra", () => {
    expect(burnProblem(null, message)).toMatch(/not sent through Xebra/);
  });

  it("does not pay when the wrapper's burn and Circle's message disagree", () => {
    expect(burnProblem({ ...xebraBurn, netBurned: AMOUNT }, message)).toMatch(/does not match/);
    expect(burnProblem({ ...xebraBurn, mintRecipient: `0x${"1".repeat(64)}` }, message)).toMatch(
      /does not match/,
    );
    expect(burnProblem({ ...xebraBurn, destinationDomain: 5 }, message)).toMatch(/not a Xebra/);
    expect(burnProblem({ ...xebraBurn, forwarded: true }, message)).toMatch(/not a Xebra/);
  });
});

describe("burnProblem on the real first Stellar to Sui burn", () => {
  it("matches the wrapper's 7-decimal net_burned to Circle's 6-decimal amount", () => {
    // Stellar 04d26876…805d (2026-11-23): event net_burned 9900000, Circle's message 990000.
    const recipient = "0xc38bb6275219b5c559d1c098622c3b3c2f883772cf1ae7038e58ad661e86285e";
    const burn = {
      destinationDomain: 8,
      mintRecipient: recipient,
      netBurned: 9_900_000n,
      forwarded: false,
    };
    const msg = { ...message, recipient, amount: 990_000n };
    expect(burnProblem(burn, msg)).toBeNull();
  });
});

describe("relayStellarToSui", () => {
  it("waits while Circle has not signed, without touching Sui", async () => {
    const d = deps({ readAttestation: async () => ({ state: "pending" }) });
    expect(await relayStellarToSui(TX, d)).toEqual({ status: "pending" });
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("mints a Xebra burn with the relayer as sender, and answers the Sui digest", async () => {
    const build = vi.fn(async () => ({ transaction: "{}", message }));
    const d = deps({ buildSuiMint: build });
    expect(await relayStellarToSui(TX, d)).toEqual({ status: "submitted", hash: "SuiDigest111" });
    expect(build).toHaveBeenCalledWith(expect.anything(), {
      sender: d.key.toSuiAddress(),
      message: MESSAGE,
      attestation: ATTESTATION,
    });
    expect(d.execute).toHaveBeenCalledOnce();
  });

  it("refuses a burn that did not go through Xebra, and spends nothing", async () => {
    const d = deps({ wrapperBurnIn: async () => null });
    const r = await relayStellarToSui(TX, d);
    expect(r.status).toBe("refused");
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("answers delivered for a transfer already minted, and spends nothing", async () => {
    const d = deps({
      buildSuiMint: async () => {
        throw new AlreadyMintedError();
      },
    });
    expect(await relayStellarToSui(TX, d)).toEqual({ status: "delivered" });
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("answers delivered when it loses the race to another minter", async () => {
    let calls = 0;
    const d = deps({
      buildSuiMint: async () => {
        calls += 1;
        if (calls > 1) throw new AlreadyMintedError();
        return { transaction: "{}", message };
      },
    });
    d.execute.mockResolvedValueOnce({ digest: "Lost", ok: false, error: "abort 4" });
    expect(await relayStellarToSui(TX, d)).toEqual({ status: "delivered" });
  });

  it("reports a mint that failed for another reason", async () => {
    const d = deps();
    d.execute.mockResolvedValueOnce({ digest: "Bad", ok: false, error: "out of gas" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await relayStellarToSui(TX, d);
    expect(r).toMatchObject({ status: "failed", hash: "Bad" });
  });
});

describe("suiRelayerKey", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off when unset, and when the value is not a Sui key", () => {
    vi.stubEnv("SUI_RELAYER_SECRET", "");
    expect(suiRelayerKey()).toBeNull();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("SUI_RELAYER_SECRET", "SBADKEY");
    expect(suiRelayerKey()).toBeNull();
  });

  it("reads a suiprivkey1 key", () => {
    const k = new Ed25519Keypair();
    vi.stubEnv("SUI_RELAYER_SECRET", k.getSecretKey());
    expect(suiRelayerKey()?.toSuiAddress()).toBe(k.toSuiAddress());
  });
});
