import { IrisUnavailable } from "@xebra/cctp-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const relayEvmToSui = vi.fn();
let sources: number[] = [26];
let key: object | null = { fake: "key" };
vi.mock("../../../../lib/sui-inbound/relayer", () => ({
  suiInboundSources: () => sources,
  relayEvmToSui: (...a: unknown[]) => relayEvmToSui(...a),
}));
vi.mock("../../../../lib/stellar-sui/relayer", () => ({
  suiRelayerKey: () => key,
}));

const { POST } = await import("./route");

const post = (body: unknown) =>
  POST(
    new Request("http://x/api/sui-inbound/complete", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
const TX = `0x${"ab".repeat(32)}`;

describe("POST /api/sui-inbound/complete", () => {
  beforeEach(() => {
    relayEvmToSui.mockReset().mockResolvedValue({ status: "submitted", hash: "SuiDigest" });
    sources = [26];
    key = { fake: "key" };
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is switched off without a relayer key", async () => {
    key = null;
    const res = await post({ src: 26, tx: TX });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "feature_disabled" });
    expect(relayEvmToSui).not.toHaveBeenCalled();
  });

  it("is switched off while no chain sends to Sui (NEXT_PUBLIC_EVM_TO_SUI unset)", async () => {
    sources = [];
    expect((await post({ src: 26, tx: TX })).status).toBe(404);
    expect(relayEvmToSui).not.toHaveBeenCalled();
  });

  it("refuses a chain that does not send to Sui, and a hash of the wrong kind", async () => {
    expect((await post({ src: 6, tx: TX })).status).toBe(400);
    expect((await post({ src: 26, tx: "nope" })).status).toBe(400);
    expect(
      (await post({ src: 26, tx: "8JD7n6LKxQWj3sR5gYVd4XcFz2pNhT9mUeAbCqKoLiPs" })).status,
    ).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(relayEvmToSui).not.toHaveBeenCalled();
  });

  it("relays a burn from a named chain, the hash lower-cased", async () => {
    const res = await post({ src: "26", tx: TX.toUpperCase().replace("0X", "0x") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "submitted", hash: "SuiDigest" });
    expect(relayEvmToSui).toHaveBeenCalledWith(TX, 26, { key, sources: [26] });
  });

  it("answers 202 while Circle has not attested, 422 on a refusal, 502 on a failed mint", async () => {
    relayEvmToSui.mockResolvedValueOnce({ status: "pending" });
    expect((await post({ src: 26, tx: TX })).status).toBe(202);
    relayEvmToSui.mockResolvedValueOnce({ status: "refused", reason: "too small" });
    expect((await post({ src: 26, tx: TX })).status).toBe(422);
    relayEvmToSui.mockResolvedValueOnce({ status: "failed", hash: "Bad" });
    expect((await post({ src: 26, tx: TX })).status).toBe(502);
  });

  it("answers 503 with Retry-After while Circle lookups are paused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    relayEvmToSui.mockRejectedValueOnce(new IrisUnavailable("rate_limited", 30_000));
    const res = await post({ src: 26, tx: TX });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(await res.json()).toMatchObject({ status: "pending" });
  });
});
