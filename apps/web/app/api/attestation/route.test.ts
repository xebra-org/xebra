import { IrisUnavailable } from "@xebra/cctp-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/env", () => ({
  env: {
    usdcSolanaMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
}));

const irisFetch = vi.fn();
vi.mock("../../../lib/server/iris", () => ({
  irisBaseUrl: () => "https://iris-api.circle.com",
  irisFetch: (...args: unknown[]) => irisFetch(...args),
  stellarDomainId: () => 27,
}));

const { GET } = await import("./route");

const STELLAR_TX = "a".repeat(64);

const MAINNET_MESSAGE =
  "0x000000010000001b00000005903db3847105114c62d6f4d69f3780523dd557eb4fccfa1c95662eb4d214eef809a3773ffd1ff361f8315d629adf17d3e4730fd00a6900715431ed4b142aded2a65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e938930000000000000000000000000000000000000000000000000000000000000000000007d0000007d000000001adefce59aee52968f76061d494c2525b75659fa4296a65f499ef29e56477e4961e7f7ed3b6de486f9ebf2833a6e50a119258a1e1f972154ea7d2ad33538dae860000000000000000000000000000000000000000000000000000000000387520a6a802b3d6321726794683981b6efb4595cba3ed022afda79c798d5cdd7045b00000000000000000000000000000000000000000000000000000000000050c110000000000000000000000000000000000000000000000000000000000050c110000000000000000000000000000000000000000000000000000000000000000636374702d666f7277617264000000000000000000000000000000000000002101a585d59e03fda49302a75520b46cb0b532ea9b326189de6aedf43a69cd030c68";

const get = (url: string) => GET(new Request(url));

describe("GET /api/attestation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid source or missing tx with 400", async () => {
    const invalidSrc = await get(`http://localhost/api/attestation?src=invalid&tx=${STELLAR_TX}`);
    expect(invalidSrc.status).toBe(400);

    const missingTx = await get("http://localhost/api/attestation");
    expect(missingTx.status).toBe(400);

    const invalidTx = await get("http://localhost/api/attestation?tx=not-a-hash");
    expect(invalidTx.status).toBe(400);
  });

  it("passes AbortSignal timeout to irisFetch", async () => {
    irisFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({
        messages: [
          {
            message: MAINNET_MESSAGE,
            attestation: "0xattestation",
            status: "complete",
          },
        ],
      }),
    });

    const res = await get(`http://localhost/api/attestation?tx=${STELLAR_TX}`);
    expect(res.status).toBe(200);
    expect(irisFetch).toHaveBeenCalledTimes(1);
    expect(irisFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/v2/messages/27?transactionHash=${STELLAR_TX}`),
      expect.objectContaining({
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("handles 404 from Circle gracefully as unknown/not indexed yet", async () => {
    irisFetch.mockResolvedValueOnce({
      status: 404,
      ok: false,
    });

    const res = await get(`http://localhost/api/attestation?tx=${STELLAR_TX}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "unknown",
      reason: "Circle has not indexed this burn yet",
    });
  });

  it("returns 503 with Retry-After header when IrisUnavailable is thrown", async () => {
    irisFetch.mockRejectedValueOnce(new IrisUnavailable("over_budget", 5_400));

    const res = await get(`http://localhost/api/attestation?tx=${STELLAR_TX}`);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("6");
    expect(await res.json()).toEqual({
      status: "unknown",
      reason: "Circle lookups are paused for a moment; try again shortly",
    });
  });

  it("returns 502 with fixed reason and logs real error on network/fetch failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    irisFetch.mockRejectedValueOnce(
      new Error("fetch failed: getaddrinfo ENOTFOUND iris-api.circle.com"),
    );

    const res = await get(`http://localhost/api/attestation?tx=${STELLAR_TX}`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { status: string; reason: string };
    expect(body).toEqual({
      status: "unknown",
      reason: "could not reach Circle",
    });
    expect(JSON.stringify(body)).not.toContain("getaddrinfo");
    expect(errorSpy).toHaveBeenCalledWith("attestation lookup failed", expect.any(Error));
    errorSpy.mockRestore();
  });
});
