import { beforeEach, describe, expect, it, vi } from "vitest";

const completeBurn = vi.fn();
let secret: string | null = null;
vi.mock("../../../../lib/sui-stellar/stellar-side", () => ({
  STELLAR_INBOUND_SOURCES: [8, 6, 26],
  completeBurn: (...a: unknown[]) => completeBurn(...a),
}));
vi.mock("../../../../lib/sui-stellar/config", () => ({
  relayerSecret: () => secret,
}));

const { POST } = await import("./route");

const post = (body: unknown) =>
  POST(
    new Request("http://x/api/stellar-inbound/complete", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
const EVM_TX = `0x${"ab".repeat(32)}`;

describe("POST /api/stellar-inbound/complete", () => {
  beforeEach(() => {
    completeBurn.mockReset().mockResolvedValue({ status: "submitted", hash: "h" });
    secret = "S-secret";
  });

  it("is off without a relayer key", async () => {
    secret = null;
    expect((await post({ src: 6, tx: EVM_TX })).status).toBe(503);
  });

  it("refuses a chain it does not complete from, and a hash of the wrong kind", async () => {
    expect((await post({ src: 5, tx: EVM_TX })).status).toBe(400);
    expect((await post({ src: 6, tx: "not-a-hash" })).status).toBe(400);
    expect((await post({ src: 8, tx: EVM_TX })).status).toBe(400);
    expect(completeBurn).not.toHaveBeenCalled();
  });

  it("completes an EVM burn with the 1 USDC floor, and a Sui burn without one", async () => {
    expect((await post({ src: "6", tx: EVM_TX.toUpperCase().replace("0X", "0x") })).status).toBe(
      200,
    );
    expect(completeBurn).toHaveBeenLastCalledWith(EVM_TX, "S-secret", 6, { minAmount: 1_000_000n });
    const digest = "8JD7n6LKxQWj3sR5gYVd4XcFz2pNhT9mUeAbCqKoLiPs";
    expect((await post({ src: 8, tx: digest })).status).toBe(200);
    expect(completeBurn).toHaveBeenLastCalledWith(digest, "S-secret", 8, {});
  });

  it("answers 422 for a refusal", async () => {
    completeBurn.mockResolvedValue({ status: "refused", reason: "no trustline" });
    expect((await post({ src: 26, tx: EVM_TX })).status).toBe(422);
  });
});
