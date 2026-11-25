import { beforeEach, describe, expect, it, vi } from "vitest";

const buildSuiMint = vi.fn();
vi.mock("@xebra/sdk/build", async (importOriginal) => {
  const real = await importOriginal<typeof import("@xebra/sdk/build")>();
  return { ...real, buildSuiMint: (...a: unknown[]) => buildSuiMint(...a) };
});
vi.mock("../../../../lib/sui-stellar/client", () => ({ suiClient: () => ({}) }));

const { AlreadyMintedError, SuiCctpPausedError, WrongSuiCallerError } = await import(
  "@xebra/sdk/build"
);
const { POST } = await import("./route");

const post = (body: unknown) =>
  POST(new Request("http://x/api/sui-mint/build", { method: "POST", body: JSON.stringify(body) }));

/** The real Solana -> Sui message from `packages/sdk/src/build/sui-mint.test.ts`. */
const MESSAGE =
  "0x000000010000000500000008faf94ea890456e4f8838f12c48cd4cf43d9ee9dcadd160905e36fae5f167173ba65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e93893f47842a2b5ac4483731927a7500175a9354d2eccd94312aa591ec50b9e8657e60000000000000000000000000000000000000000000000000000000000000000000003e8000003e800000001c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61e56ad8c14ab50d71625eeec43a6227b8d336fe90d737b8bac5dbfc53e853ac110000000000000000000000000000000000000000000000000000000001edc369e64f08d9eb0e2430e2e0c54c8cba74b3830ddd5041c2582654cd8c3ec3c348d400000000000000000000000000000000000000000000000000000000000019480000000000000000000000000000000000000000000000000000000000000ca3000000000000000000000000000000000000000000000000000001a1fda2facb";
const RECIPIENT = "0xe56ad8c14ab50d71625eeec43a6227b8d336fe90d737b8bac5dbfc53e853ac11";
const ATTESTATION = `0x${"ab".repeat(130)}`;
const SENDER = `0x${"5".repeat(64)}`;
/** The same message bound for Stellar (domain 27) instead. */
const TO_STELLAR = `${MESSAGE.slice(0, 18)}0000001b${MESSAGE.slice(26)}`;

describe("POST /api/sui-mint/build", () => {
  beforeEach(() => {
    buildSuiMint.mockReset().mockResolvedValue({
      transaction: "{}",
      message: { recipient: RECIPIENT, received: 32_356_038n },
    });
  });

  it("builds the mint and says who receives what", async () => {
    const res = await post({ sender: SENDER, message: MESSAGE, attestation: ATTESTATION });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ready",
      transaction: "{}",
      recipient: RECIPIENT,
      received: "32356038",
      receivedUsdc: "32.356038",
    });
    expect(buildSuiMint).toHaveBeenCalledWith(
      {},
      { sender: SENDER, message: MESSAGE, attestation: ATTESTATION },
    );
  });

  it("refuses a bad sender, bad hex, and a message for another chain, without the node", async () => {
    expect(
      (await post({ sender: "0x12", message: MESSAGE, attestation: ATTESTATION })).status,
    ).toBe(400);
    expect((await post({ sender: SENDER, message: "zz", attestation: ATTESTATION })).status).toBe(
      400,
    );
    expect((await post({ sender: SENDER, message: MESSAGE, attestation: "0x123" })).status).toBe(
      400,
    );
    const other = await post({ sender: SENDER, message: TO_STELLAR, attestation: ATTESTATION });
    expect(other.status).toBe(400);
    expect((await other.json()).error).toContain("not Sui");
    expect(buildSuiMint).not.toHaveBeenCalled();
  });

  it("reports an already-minted transfer, a pause, and the wrong wallet plainly", async () => {
    const body = { sender: SENDER, message: MESSAGE, attestation: ATTESTATION };
    buildSuiMint.mockRejectedValueOnce(new AlreadyMintedError());
    expect(await (await post(body)).json()).toEqual({ status: "already-minted" });
    buildSuiMint.mockRejectedValueOnce(new SuiCctpPausedError());
    expect((await post(body)).status).toBe(503);
    buildSuiMint.mockRejectedValueOnce(new WrongSuiCallerError(RECIPIENT));
    expect((await post(body)).status).toBe(403);
  });

  it("hides a node failure behind a plain message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    buildSuiMint.mockRejectedValueOnce(new Error("grpc: internal 0xdeadbeef"));
    const res = await post({ sender: SENDER, message: MESSAGE, attestation: ATTESTATION });
    expect(res.status).toBe(502);
    expect((await res.json()).error).not.toContain("grpc");
  });
});
