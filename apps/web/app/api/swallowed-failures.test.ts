import { IrisUnavailable } from "@xebra/cctp-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const irisFetch = vi.fn();
vi.mock("../../lib/server/iris", () => ({
  irisBaseUrl: () => "https://iris-api.circle.com",
  irisFetch: (...args: unknown[]) => irisFetch(...args),
  stellarDomainId: () => 27,
}));

const { GET: delivery } = await import("./delivery/route");
const { POST: reattest } = await import("./reattest/route");

const REQUEST_ID = "iad1::k8s2x-1700000000000-abcdef";
/** Both routes cache by their key, so every test asks about a transaction or nonce of its own. */
let n = 0;
const hex64 = () => (++n).toString(16).padStart(64, "0");

let logged: ReturnType<typeof vi.spyOn>;
/** Each line `logFailure` wrote, parsed. One line is one failure. */
const lines = () => logged.mock.calls.map(([line]) => JSON.parse(String(line)));

beforeEach(() => {
  irisFetch.mockReset();
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/delivery, when the lookup fails", () => {
  const ask = (tx: string) =>
    delivery(
      new Request(`https://xebra.exchange/api/delivery?tx=${tx}`, {
        headers: { "x-vercel-id": REQUEST_ID },
      }),
    );

  it("still answers unknown when Circle cannot be reached, and now says why in the logs", async () => {
    const tx = hex64();
    irisFetch.mockRejectedValueOnce(
      new TypeError("fetch failed", { cause: new Error("ECONNRESET") }),
    );
    const res = await ask(tx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "unknown", reason: "could not reach Circle" });
    expect(lines()).toEqual([
      {
        route: "/api/delivery",
        request_id: REQUEST_ID,
        message: "fetch failed",
        name: "TypeError",
        cause: { name: "Error", message: "ECONNRESET" },
        src: 27,
        tx,
      },
    ]);
  });

  it("logs a pause of our own Iris budget, with the same answer as before", async () => {
    const tx = hex64();
    irisFetch.mockRejectedValueOnce(new IrisUnavailable("rate_limited", 330_000));
    const res = await ask(tx);
    expect(await res.json()).toEqual({
      status: "unknown",
      reason: "status lookups are paused for a moment",
    });
    expect(lines()).toMatchObject([
      { route: "/api/delivery", request_id: REQUEST_ID, name: "IrisUnavailable", src: 27, tx },
    ]);
  });

  it("logs an answer from Circle that could not be read", async () => {
    const tx = hex64();
    irisFetch.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 200 }));
    const res = await ask(tx);
    expect(await res.json()).toEqual({ status: "unknown", reason: "could not reach Circle" });
    expect(lines()).toMatchObject([{ route: "/api/delivery", name: "SyntaxError", tx }]);
  });

  it("logs nothing for a burn Circle has not indexed yet, or one it reports on", async () => {
    irisFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const waiting = await (await ask(hex64())).json();
    expect(waiting).toMatchObject({ status: "known", destinationDomain: null });

    irisFetch.mockResolvedValueOnce(Response.json({ messages: [] }));
    const answered = await (await ask(hex64())).json();
    expect(answered).toMatchObject({ status: "known" });

    expect(lines()).toEqual([]);
  });
});

describe("POST /api/reattest, when the request fails", () => {
  const ask = (nonce: string) =>
    reattest(
      new Request("https://xebra.exchange/api/reattest", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-vercel-id": REQUEST_ID },
        body: JSON.stringify({ nonce }),
      }),
    );

  it("still answers 502 when Circle cannot be reached, and now says why in the logs", async () => {
    const nonce = `0x${hex64()}`;
    irisFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    const res = await ask(nonce);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ status: "failed", reason: "could not reach Circle" });
    expect(lines()).toEqual([
      {
        route: "/api/reattest",
        request_id: REQUEST_ID,
        message: "fetch failed",
        name: "TypeError",
        cause: null,
        nonce,
      },
    ]);
  });

  it("logs a pause of our own Iris budget, with the same 503 as before", async () => {
    const nonce = `0x${hex64()}`;
    irisFetch.mockRejectedValueOnce(new IrisUnavailable("over_budget", 1_500));
    const res = await ask(nonce);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "failed",
      reason: "Circle lookups are paused for a moment; try again shortly",
    });
    expect(lines()).toMatchObject([
      { route: "/api/reattest", request_id: REQUEST_ID, name: "IrisUnavailable", nonce },
    ]);
  });

  it("logs nothing when Circle accepts the request", async () => {
    irisFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const res = await ask(`0x${hex64()}`);
    expect(await res.json()).toEqual({ status: "requested" });
    expect(lines()).toEqual([]);
  });
});
