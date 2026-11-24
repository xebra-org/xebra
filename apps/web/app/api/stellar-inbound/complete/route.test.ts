import { IrisUnavailable } from "@xebra/cctp-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const completeBurn = vi.fn();
let secret: string | null = null;
let sources = [8, 5, 6, 26];
vi.mock("../../../../lib/sui-stellar/stellar-side", () => ({
  stellarInboundSources: () => sources,
  completeBurn: (...a: unknown[]) => completeBurn(...a),
}));
// Only the relayer key is faked: what the route answers while it is off is the real `notFound`.
vi.mock("../../../../lib/sui-stellar/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/sui-stellar/config")>()),
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
    sources = [8, 5, 6, 26];
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is switched off, not broken, without a relayer key", async () => {
    secret = null;
    const res = await post({ src: 6, tx: EVM_TX });
    // A 503 said "outage, keep retrying" about a deployment that completes nothing.
    expect(res.status).toBe(404);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ code: "feature_disabled" });
    expect(completeBurn).not.toHaveBeenCalled();
  });

  it("refuses a chain it does not complete from, and a hash of the wrong kind", async () => {
    expect((await post({ src: 9, tx: EVM_TX })).status).toBe(400);
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

  it("completes a Solana burn by its signature, unchanged in case, with the 1 USDC floor", async () => {
    const sig =
      "2bDXTMyLLYac1jMjqxZSqkpkCvypk54TqGGzCQYQVRBUWKWGDDeuGbs1pCq4QnWCgkL2mh34678XKQ98fB48Z1UM";
    expect((await post({ src: 5, tx: sig })).status).toBe(200);
    expect(completeBurn).toHaveBeenLastCalledWith(sig, "S-secret", 5, { minAmount: 1_000_000n });
    // A Sui digest is too short to be a Solana signature.
    expect(
      (await post({ src: 5, tx: "8JD7n6LKxQWj3sR5gYVd4XcFz2pNhT9mUeAbCqKoLiPs" })).status,
    ).toBe(400);
  });

  it("answers 200 once the mint is on Stellar or on its way there", async () => {
    for (const result of [{ status: "delivered" }, { status: "submitted", hash: "h", ledger: 7 }]) {
      completeBurn.mockResolvedValue(result);
      const res = await post({ src: 26, tx: EVM_TX });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(result);
    }
  });

  it("answers 202 while there is nothing to show yet", async () => {
    for (const result of [
      { status: "pending" },
      { status: "pending", reason: "already being completed" },
      { status: "unknown", reason: "Circle has not indexed this burn yet" },
    ]) {
      completeBurn.mockResolvedValue(result);
      const res = await post({ src: 26, tx: EVM_TX });
      expect(res.status, JSON.stringify(result)).toBe(202);
      // Nobody asked us to wait a set time, so there is no delay to name.
      expect(res.headers.get("Retry-After")).toBeNull();
      expect(await res.json()).toEqual(result);
    }
  });

  it("answers 422 for a refusal", async () => {
    completeBurn.mockResolvedValue({ status: "refused", reason: "no trustline" });
    expect((await post({ src: 26, tx: EVM_TX })).status).toBe(422);
  });

  it("answers 502 for a mint that was sent and did not land", async () => {
    completeBurn.mockResolvedValue({ status: "failed", hash: "h", ledger: 7 });
    const res = await post({ src: 26, tx: EVM_TX });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ status: "failed", hash: "h", ledger: 7 });
  });

  it("answers 503 with Retry-After when the network asks to try again later", async () => {
    completeBurn.mockResolvedValue({
      status: "pending",
      retryAfterMs: 5_000,
      reason: "Stellar is busy and declined to queue the mint right now. Try again shortly.",
    });
    const res = await post({ src: 26, tx: EVM_TX });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
  });

  it("answers 503 with Retry-After, and stays pending, while Circle lookups are paused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    completeBurn.mockRejectedValue(new IrisUnavailable("rate_limited", 330_000));
    const res = await post({ src: 26, tx: EVM_TX });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("330");
    // Not `failed`: the Solana and Aptos pages stop polling and show the transfer as stuck on
    // `failed` (`nextStellarDelivery`, `nextDelivery`), and ask again on anything they do not name.
    expect(await res.json()).toEqual({
      status: "pending",
      retryAfterMs: 330_000,
      reason: "Circle lookups are paused for a moment. Try again shortly.",
    });

    // A hold that is already over still names a wait: never "retry in 0".
    completeBurn.mockRejectedValue(new IrisUnavailable("over_budget", 0));
    expect((await post({ src: 26, tx: EVM_TX })).headers.get("Retry-After")).toBe("1");
  });

  it("answers 502, and logs, for a failure it has no better name for", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("soroban rpc down");
    completeBurn.mockRejectedValue(boom);
    const res = await post({ src: 26, tx: EVM_TX });
    expect(res.status).toBe(502);
    expect(res.headers.get("Retry-After")).toBeNull();
    // The cause is logged and never returned.
    expect(await res.json()).toEqual({
      status: "failed",
      reason: "Could not complete the transfer. It is safe to try again.",
    });
    expect(logged).toHaveBeenCalledWith("stellar-inbound complete failed", boom);
  });

  it("completes an Aptos burn, with the 1 USDC floor, only while Aptos may send to Stellar", async () => {
    const APTOS_TX = `0x${"cd".repeat(32)}`;
    const refused = await post({ src: 9, tx: APTOS_TX });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).not.toContain("Aptos");
    sources = [8, 5, 6, 26, 9];
    const named = await post({ src: 9, tx: "not-a-hash" });
    expect(named.status).toBe(400);
    expect(((await named.json()) as { error: string }).error).toContain("Aptos");
    expect((await post({ src: 9, tx: APTOS_TX.toUpperCase().replace("0X", "0x") })).status).toBe(
      200,
    );
    expect(completeBurn).toHaveBeenLastCalledWith(APTOS_TX, "S-secret", 9, {
      minAmount: 1_000_000n,
    });
  });
});
