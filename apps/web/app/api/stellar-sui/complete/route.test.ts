import { IrisUnavailable } from "@xebra/cctp-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const relayEvmToSui = vi.fn();
const relayStellarToSui = vi.fn();
let sources: number[] = [26];
let key: object | null = { fake: "key" };
vi.mock("../../../../lib/stellar-sui/relayer", () => ({
  suiRelayerKey: () => key,
  evmSuiSources: () => sources,
  relayEvmToSui: (...a: unknown[]) => relayEvmToSui(...a),
  relayStellarToSui: (...a: unknown[]) => relayStellarToSui(...a),
}));

const { POST } = await import("./route");

const post = (body: unknown) =>
  POST(
    new Request("http://x/api/stellar-sui/complete", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
const EVM_TX = `0x${"ab".repeat(32)}`;
const STELLAR_TX = "cd".repeat(32);

describe("POST /api/stellar-sui/complete", () => {
  beforeEach(() => {
    relayEvmToSui.mockReset().mockResolvedValue({ status: "submitted", hash: "SuiDigest" });
    relayStellarToSui.mockReset().mockResolvedValue({ status: "submitted", hash: "SuiDigest" });
    sources = [26];
    key = { fake: "key" };
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is switched off without a relayer key, for both kinds of burn", async () => {
    key = null;
    expect((await post({ tx: STELLAR_TX })).status).toBe(404);
    const res = await post({ src: 26, tx: EVM_TX });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "feature_disabled" });
    expect(relayEvmToSui).not.toHaveBeenCalled();
    expect(relayStellarToSui).not.toHaveBeenCalled();
  });

  it("still relays a Stellar burn by its hash alone, or with src 27", async () => {
    expect((await post({ tx: STELLAR_TX })).status).toBe(200);
    expect(relayStellarToSui).toHaveBeenLastCalledWith(STELLAR_TX, { key });
    expect((await post({ src: 27, tx: STELLAR_TX })).status).toBe(200);
    expect(relayStellarToSui).toHaveBeenCalledTimes(2);
    expect(relayEvmToSui).not.toHaveBeenCalled();
  });

  it("refuses an EVM chain while NEXT_PUBLIC_EVM_TO_SUI names none", async () => {
    sources = [];
    expect((await post({ src: 26, tx: EVM_TX })).status).toBe(400);
    expect(relayEvmToSui).not.toHaveBeenCalled();
  });

  it("refuses a chain that does not send to Sui, and a hash of the wrong kind", async () => {
    expect((await post({ src: 6, tx: EVM_TX })).status).toBe(400);
    expect((await post({ src: 26, tx: "nope" })).status).toBe(400);
    expect((await post({ src: 26, tx: STELLAR_TX })).status).toBe(400);
    expect((await post({ src: 26 })).status).toBe(400);
    expect((await post({ src: "x", tx: EVM_TX })).status).toBe(400);
    expect(relayEvmToSui).not.toHaveBeenCalled();
  });

  it("relays an Arc burn, the hash lower-cased", async () => {
    const res = await post({ src: "26", tx: EVM_TX.toUpperCase().replace("0X", "0x") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "submitted", hash: "SuiDigest" });
    expect(relayEvmToSui).toHaveBeenCalledWith(EVM_TX, 26, { key, sources: [26] });
  });

  it("answers 202 while Circle has not attested, 422 on a refusal, 502 on a failed mint", async () => {
    relayEvmToSui.mockResolvedValueOnce({ status: "pending" });
    expect((await post({ src: 26, tx: EVM_TX })).status).toBe(202);
    relayEvmToSui.mockResolvedValueOnce({ status: "refused", reason: "too small" });
    expect((await post({ src: 26, tx: EVM_TX })).status).toBe(422);
    relayEvmToSui.mockResolvedValueOnce({ status: "failed", hash: "Bad" });
    expect((await post({ src: 26, tx: EVM_TX })).status).toBe(502);
  });

  it("answers 503 with Retry-After while Circle lookups are paused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    relayEvmToSui.mockRejectedValueOnce(new IrisUnavailable("rate_limited", 30_000));
    const res = await post({ src: 26, tx: EVM_TX });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(await res.json()).toMatchObject({ status: "pending" });
  });
});
