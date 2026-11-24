import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/env", () => ({
  env: {
    solanaRpcUrl: "https://api.mainnet-beta.solana.com",
  },
}));

const { POST } = await import("./route");

const FAKE_URL = "http://localhost/api/solana-rpc";

const post = (
  body: unknown,
  init?: {
    headers?: Record<string, string>;
    rawBody?: BodyInit;
  },
) => {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const reqInit: RequestInit = {
    method: "POST",
    headers,
    body: init?.rawBody ?? (typeof body === "string" ? body : JSON.stringify(body)),
  };
  return POST(new Request(FAKE_URL, reqInit));
};

describe("POST /api/solana-rpc", () => {
  const origFetch = globalThis.fetch;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    errorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("caps the body when Content-Length declares more than 16KB", async () => {
    const res = await post(
      {},
      {
        headers: { "content-length": "20000" },
        rawBody: "{}",
      },
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("The body is too large.");
  });

  it("caps the body when streamed body exceeds 16KB without Content-Length", async () => {
    const chunk = new Uint8Array(1024).fill(120); // 'x'
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 20; i++) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    const req = new Request(FAKE_URL, {
      method: "POST",
      body: stream,
      // @ts-expect-error duplex is required in node fetch with streaming bodies
      duplex: "half",
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("The body is too large.");
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await post("not-json", {
      headers: { "content-type": "application/json" },
      rawBody: "{invalid-json",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("invalid JSON");
  });

  it("returns 400 when calls array is empty or exceeds 10", async () => {
    const emptyRes = await post([]);
    expect(emptyRes.status).toBe(400);
    expect((await emptyRes.json()) as { error: string }).toEqual({
      error: "expected between 1 and 10 RPC calls",
    });

    const tooMany = Array.from({ length: 11 }, () => ({
      jsonrpc: "2.0",
      id: 1,
      method: "getLatestBlockhash",
    }));
    const tooManyRes = await post(tooMany);
    expect(tooManyRes.status).toBe(400);
    expect((await tooManyRes.json()) as { error: string }).toEqual({
      error: "expected between 1 and 10 RPC calls",
    });
  });

  it("returns 403 on disallowed methods", async () => {
    const res = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "getProgramAccounts",
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({
      error: "method not allowed: getProgramAccounts",
    });
  });

  it("forwards successful responses verbatim with timeout signal", async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: { value: 100 }, id: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const res = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "getLatestBlockhash",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { jsonrpc: string; result: { value: number }; id: number };
    expect(body.result.value).toBe(100);
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it.each([401, 403, 500, 502, 503, 504])(
    "converts upstream %i to 502 with fixed error text and logs details",
    async (status) => {
      const secretUrl = "https://solana-paid-rpc.example.com/?api-key=SECRET123";
      globalThis.fetch = vi.fn(
        async () =>
          new Response(`Internal error from ${secretUrl}`, {
            status,
            headers: { "content-type": "text/plain" },
          }),
      );

      const res = await post({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: ["11111111111111111111111111111111"],
      });

      expect(res.status).toBe(502);
      const json = (await res.json()) as { error: string };
      expect(json).toEqual({ error: "Solana's network is not answering" });
      expect(JSON.stringify(json)).not.toContain("SECRET123");
      expect(JSON.stringify(json)).not.toContain("solana-paid-rpc");

      expect(errorSpy).toHaveBeenCalledWith(
        "Solana RPC upstream failure",
        status,
        `Internal error from ${secretUrl}`,
      );
    },
  );

  it("converts upstream 429 to 429 with Retry-After and fixed error text", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("Too Many Requests - quota exceeded on https://private-node.example.com", {
          status: 429,
          headers: {
            "retry-after": "45",
            "content-type": "text/plain",
          },
        }),
    );

    const res = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignatureStatuses",
      params: [["5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYj7WNPEWm8pHg79WwK2G975bCgw"]],
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("45");
    const json = (await res.json()) as { error: string };
    expect(json).toEqual({ error: "Solana's network is rate limited" });
    expect(JSON.stringify(json)).not.toContain("private-node");
    expect(errorSpy).toHaveBeenCalledWith(
      "Solana RPC rate limited",
      429,
      expect.stringContaining("quota exceeded"),
    );
  });

  it("defaults Retry-After to 10 on upstream 429 without header", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("Rate limited", {
          status: 429,
        }),
    );

    const res = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "getLatestBlockhash",
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("10");
  });

  it("handles upstream network drop or timeout with 502 and fixed error text", async () => {
    const leakMessage = "connect ECONNREFUSED https://solana-rpc.internal:8899/?secret=TOP_SECRET";
    globalThis.fetch = vi.fn(async () => {
      throw new Error(leakMessage);
    });

    const res = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: ["base64wire"],
    });

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    expect(json).toEqual({ error: "Solana's network is not answering" });
    expect(JSON.stringify(json)).not.toContain("TOP_SECRET");
    expect(JSON.stringify(json)).not.toContain("solana-rpc.internal");

    expect(errorSpy).toHaveBeenCalledWith("Solana RPC request failed", expect.any(Error));
  });
});
