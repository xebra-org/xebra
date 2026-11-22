import { describe, expect, it, vi } from "vitest";
import { IrisApiError, createIrisClient } from "./iris.js";

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("createIrisClient", () => {
  it("parses messages from a successful response", async () => {
    const fetchImpl = mockFetch(200, {
      messages: [{ message: "0xdead", attestation: "0xbeef", eventNonce: "1", status: "complete" }],
    });
    const client = createIrisClient("https://iris.example", fetchImpl);

    const messages = await client.getMessages(2, "abc123");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.status).toBe("complete");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://iris.example/v2/messages/2?transactionHash=abc123",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("encodes transaction hash in the request URL", async () => {
    const fetchImpl = mockFetch(200, { messages: [] });
    const client = createIrisClient("https://iris.example", fetchImpl);

    await client.getMessages(2, "0x123/456?foo=bar");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://iris.example/v2/messages/2?transactionHash=0x123%2F456%3Ffoo%3Dbar",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns an empty array when the message hasn't been indexed yet", async () => {
    const fetchImpl = mockFetch(200, { messages: [] });
    const client = createIrisClient("https://iris.example", fetchImpl);
    expect(await client.getMessages(2, "abc123")).toEqual([]);
  });

  it("throws IrisApiError with code 'not_found' on 404 response", async () => {
    const fetchImpl = mockFetch(404, "not indexed yet");
    const client = createIrisClient("https://iris.example", fetchImpl);
    const err = await client.getMessages(2, "abc123").catch((e) => e);
    expect(err).toBeInstanceOf(IrisApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
  });

  it("throws IrisApiError with code 'rate_limited' on 429 response", async () => {
    const fetchImpl = mockFetch(429, "too many requests");
    const client = createIrisClient("https://iris.example", fetchImpl);
    const err = await client.getMessages(2, "abc123").catch((e) => e);
    expect(err).toBeInstanceOf(IrisApiError);
    expect(err.status).toBe(429);
    expect(err.code).toBe("rate_limited");
  });

  it("throws IrisApiError with code 'upstream' on 500 response", async () => {
    const fetchImpl = mockFetch(500, "internal server error");
    const client = createIrisClient("https://iris.example", fetchImpl);
    const err = await client.getMessages(2, "abc123").catch((e) => e);
    expect(err).toBeInstanceOf(IrisApiError);
    expect(err.status).toBe(500);
    expect(err.code).toBe("upstream");
  });

  it("throws IrisApiError with code 'timeout' when request times out", async () => {
    const hangingFetch: typeof fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener("abort", () => {
              const abortErr = new Error("The operation was aborted");
              abortErr.name = "TimeoutError";
              reject(abortErr);
            });
          }
        }),
    ) as unknown as typeof fetch;

    const client = createIrisClient("https://iris.example", hangingFetch, { timeoutMs: 10 });
    const err = await client.getMessages(2, "abc123").catch((e) => e);
    expect(err).toBeInstanceOf(IrisApiError);
    expect(err.code).toBe("timeout");
  });
});
