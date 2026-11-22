import { IrisUnavailable } from "@xebra/cctp-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const completeBurn = vi.fn();
let enabled = true;
let secret: string | null = null;
vi.mock("../../../../lib/sui-stellar/stellar-side", () => ({
  completeBurn: (...a: unknown[]) => completeBurn(...a),
}));
// Only the two switches are faked: what the route answers while one is off is the real `notFound`.
vi.mock("../../../../lib/sui-stellar/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/sui-stellar/config")>()),
  suiStellarEnabled: () => enabled,
  relayerSecret: () => secret,
}));

const { POST } = await import("./route");

const post = (body: unknown) =>
  POST(
    new Request("http://x/api/sui-stellar/complete", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const DIGEST = "8JD7n6LKxQWj3sR5gYVd4XcFz2pNhT9mUeAbCqKoLiPs";

describe("POST /api/sui-stellar/complete", () => {
  beforeEach(() => {
    completeBurn.mockReset().mockResolvedValue({ status: "submitted", hash: "h" });
    enabled = true;
    secret = "S-secret";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is switched off, not broken, while the Sui page or the relayer is off", async () => {
    for (const off of [
      () => {
        enabled = false;
      },
      () => {
        secret = null;
      },
    ]) {
      enabled = true;
      secret = "S-secret";
      off();
      const res = await post({ digest: DIGEST });
      // Without a relayer this was a 503: "outage, keep retrying" about a deployment that
      // completes nothing.
      expect(res.status).toBe(404);
      expect(res.headers.get("Retry-After")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toMatchObject({ code: "feature_disabled" });
    }
    expect(completeBurn).not.toHaveBeenCalled();
  });

  it("refuses what is not a Sui digest, and a body it cannot read", async () => {
    for (const body of [{ digest: `0x${"ab".repeat(32)}` }, { digest: 7 }, {}, "not json"]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("Sui transaction digest");
    }
    expect(completeBurn).not.toHaveBeenCalled();
  });

  it("completes a burn by its digest, trimmed and unchanged in case", async () => {
    const res = await post({ digest: ` ${DIGEST} ` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "submitted", hash: "h" });
    expect(completeBurn).toHaveBeenLastCalledWith(DIGEST, "S-secret");
  });

  it("answers 200 once the mint is on Stellar or on its way there", async () => {
    for (const result of [{ status: "delivered" }, { status: "submitted", hash: "h", ledger: 7 }]) {
      completeBurn.mockResolvedValue(result);
      const res = await post({ digest: DIGEST });
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
      const res = await post({ digest: DIGEST });
      expect(res.status, JSON.stringify(result)).toBe(202);
      // Nobody asked us to wait a set time, so there is no delay to name.
      expect(res.headers.get("Retry-After")).toBeNull();
      expect(await res.json()).toEqual(result);
    }
  });

  it("answers 422 for a refusal and 502 for a mint that did not land", async () => {
    completeBurn.mockResolvedValue({ status: "refused", reason: "no trustline" });
    expect((await post({ digest: DIGEST })).status).toBe(422);
    completeBurn.mockResolvedValue({ status: "failed", hash: "h", ledger: 7 });
    const res = await post({ digest: DIGEST });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ status: "failed", hash: "h", ledger: 7 });
  });

  it("answers 503 with Retry-After when the network asks to try again later", async () => {
    completeBurn.mockResolvedValue({
      status: "pending",
      retryAfterMs: 5_000,
      reason: "Stellar is busy and declined to queue the mint right now. Try again shortly.",
    });
    const res = await post({ digest: DIGEST });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
  });

  it("answers 503 with Retry-After, and stays pending, while Circle lookups are paused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    completeBurn.mockRejectedValue(new IrisUnavailable("rate_limited", 330_000));
    const res = await post({ digest: DIGEST });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("330");
    // Not `failed`: the Sui page stops polling and shows the transfer as stuck on `failed`, and
    // asks again on anything it does not name.
    expect(await res.json()).toEqual({
      status: "pending",
      retryAfterMs: 330_000,
      reason: "Circle lookups are paused for a moment. Try again shortly.",
    });

    // A hold that is already over still names a wait: never "retry in 0".
    completeBurn.mockRejectedValue(new IrisUnavailable("over_budget", 0));
    expect((await post({ digest: DIGEST })).headers.get("Retry-After")).toBe("1");
  });

  it("answers 502, and logs, for a failure it has no better name for", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("soroban rpc down");
    completeBurn.mockRejectedValue(boom);
    const res = await post({ digest: DIGEST });
    expect(res.status).toBe(502);
    expect(res.headers.get("Retry-After")).toBeNull();
    // The cause is logged and never returned.
    expect(await res.json()).toEqual({
      status: "failed",
      reason: "Could not complete the transfer. It is safe to try again.",
    });
    expect(logged).toHaveBeenCalledWith("sui-stellar complete failed", boom);
  });
});
