import { describe, expect, it, vi } from "vitest";
import { XebraApiError, createXebraClient } from "./index.js";

const json = (status: number, body: unknown, type = "application/json") =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": type } });

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  json(
    status,
    {
      type: `https://docs.xebra.exchange/errors/${code}`,
      title: code,
      status,
      detail: `a ${code}`,
      code,
      ...extra,
    },
    "application/problem+json",
  );

const STATUS = (state: string) => ({
  state,
  chain: "stellar",
  tx: "a".repeat(64),
  deliveryTx: null,
  reason: null,
  claimUrl: null,
});

describe("createXebraClient", () => {
  it("sends the key, the SDK version and the query, to the base URL", async () => {
    const fetch = vi.fn(async () => json(200, { routes: [], complete: true }));
    const client = createXebraClient({
      baseUrl: "https://example.test/",
      apiKey: "xk_live_x",
      fetch,
    });
    await client.routes();
    await client.quote({ from: "stellar", to: "base", amount: "10" }).catch(() => {});
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.test/v1/routes");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xk_live_x");
    expect((init.headers as Record<string, string>)["X-Xebra-Sdk"]).toBeDefined();
    expect((fetch.mock.calls[1] as unknown as [string])[0]).toBe(
      "https://example.test/v1/quote?from=stellar&to=base&amount=10",
    );
  });

  it("turns a problem into an XebraApiError carrying its code and figures", async () => {
    const client = createXebraClient({
      fetch: async () => problem(422, "amount_above_maximum", { maximum: "100" }),
    });
    const err = await client.quote({ from: "stellar", to: "base", amount: "150" }).catch((e) => e);
    expect(err).toBeInstanceOf(XebraApiError);
    expect(err).toMatchObject({
      status: 422,
      code: "amount_above_maximum",
      extra: { maximum: "100" },
    });
  });

  it("refuses an answer that does not match the schema rather than passing it on", async () => {
    const client = createXebraClient({ fetch: async () => json(200, { routes: "nope" }) });
    await expect(client.routes()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("reports an answer that is not JSON", async () => {
    const client = createXebraClient({
      fetch: async () => new Response("<html>", { status: 502 }),
    });
    await expect(client.routes()).rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("gives up after its timeout", async () => {
    const client = createXebraClient({
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    });
    await expect(client.routes()).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("waitForDelivery", () => {
  it("polls until a settled state, waiting out a 503", async () => {
    const answers = [
      problem(503, "upstream_unavailable"),
      json(200, STATUS("pending")),
      json(200, STATUS("delivered")),
    ];
    const client = createXebraClient({
      fetch: async () => answers.shift() ?? json(200, STATUS("delivered")),
    });
    const s = await client.waitForDelivery("stellar", "a".repeat(64), { intervalMs: 1 });
    expect(s.state).toBe("delivered");
    expect(answers).toHaveLength(0);
  });

  for (const state of ["needs_claim", "failed"]) {
    it(`stops at ${state}`, async () => {
      const client = createXebraClient({ fetch: async () => json(200, STATUS(state)) });
      expect(
        (await client.waitForDelivery("stellar", "a".repeat(64), { intervalMs: 1 })).state,
      ).toBe(state);
    });
  }

  it("does not retry a problem with the request itself", async () => {
    const fetch = vi.fn(async () => problem(400, "invalid_request"));
    const client = createXebraClient({ fetch });
    await expect(client.waitForDelivery("stellar", "bad", { intervalMs: 1 })).rejects.toMatchObject(
      {
        code: "invalid_request",
      },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("works when taken off the client", async () => {
    const { waitForDelivery } = createXebraClient({
      fetch: async () => json(200, STATUS("delivered")),
    });
    expect((await waitForDelivery("stellar", "a".repeat(64), { intervalMs: 1 })).state).toBe(
      "delivered",
    );
  });

  it("gives up at its deadline", async () => {
    const client = createXebraClient({ fetch: async () => json(200, STATUS("pending")) });
    await expect(
      client.waitForDelivery("stellar", "a".repeat(64), { intervalMs: 5, timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});
