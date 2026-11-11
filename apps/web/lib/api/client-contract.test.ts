import { XebraApiError, createXebraClient } from "@xebra/sdk";
import { describe, expect, it } from "vitest";
import type { Deps } from "./deps";
import { endpoints } from "./endpoints";
import { RECIPIENT, SENDER, STELLAR_TX, buildDeps, deps } from "./fakes";
import { createService } from "./service";

/**
 * The SDK's client against the real handlers, in-process: a request the client makes is one the
 * server accepts, and an answer the server gives is one the client parses. Either side drifting
 * from the shared schemas fails here.
 */
function client(over: Partial<Deps> = {}) {
  const v1 = endpoints(createService(deps({ build: buildDeps(), ...over })));
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    if (path === "/v1/routes") return v1.routes(req);
    if (path === "/v1/quote") return v1.quote(req);
    if (path === "/v1/transfers" && req.method === "POST") return v1.createTransfer(req);
    if (path === "/v1/claims" && req.method === "POST") return v1.createClaim(req);
    if (path === "/v1/health") return v1.health(req);
    const m = /^\/v1\/transfers\/([^/]+)\/([^/]+)$/.exec(path);
    if (m?.[1] && m[2]) {
      return v1.getTransfer(req, { chain: decodeURIComponent(m[1]), tx: decodeURIComponent(m[2]) });
    }
    return new Response("not found", { status: 404 });
  };
  return createXebraClient({ baseUrl: "https://api.xebra.exchange", fetch });
}

describe("the SDK client against the /v1 handlers", () => {
  it("round-trips every operation", async () => {
    const c = client();
    expect((await c.health()).status).toBe("ok");
    expect((await c.routes()).routes.length).toBeGreaterThan(0);
    const quote = await c.quote({ from: "stellar", to: "base", amount: "10" });
    expect(quote.recipientGets).toMatch(/^\d/);
    const build = await c.createTransfer({
      from: "stellar",
      to: "base",
      amount: "10",
      sender: SENDER,
      recipient: RECIPIENT,
      maxTotalFee: quote.fees.total,
    });
    expect(build.steps[0]?.tx.kind).toBe("stellar");
    expect((await c.getTransfer("stellar", STELLAR_TX)).state).toBe("delivering");
    expect(
      (await c.createClaim({ chain: "stellar", tx: STELLAR_TX, payer: RECIPIENT })).steps,
    ).toHaveLength(1);
  });

  it("surfaces the server's problem as XebraApiError with the same code and figures", async () => {
    const c = client({
      feeParams: async () => ({
        feeBps: 10n,
        minFee: 3_000_000n,
        minTransfer: 10_000_000n,
        maxTransfer: 1_000_000_000n,
      }),
    });
    const err = await c.quote({ from: "stellar", to: "base", amount: "150" }).catch((e) => e);
    expect(err).toBeInstanceOf(XebraApiError);
    expect(err).toMatchObject({
      status: 422,
      code: "amount_above_maximum",
      extra: { maximum: "100" },
    });
  });

  it("waits for delivery through the real status handler", async () => {
    const c = client({
      delivery: async () => ({
        status: "known",
        state: "delivered",
        forwardTxHash: "0xabc",
        reason: null,
      }),
    });
    const s = await c.waitForDelivery("stellar", STELLAR_TX, { intervalMs: 1 });
    expect(s).toMatchObject({ state: "delivered", deliveryTx: "0xabc" });
  });
});
