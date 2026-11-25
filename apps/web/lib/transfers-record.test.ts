import { describe, expect, it } from "vitest";
import { loadTransfersRecord, parseRecord } from "./transfers-record";

const row = (over: Record<string, unknown> = {}) => ({
  id: "stellar:0xab",
  source: "stellar",
  to: "base",
  proof: "contract",
  sourceTx: "7e4b",
  sourceTxUrl: "https://stellar.expert/explorer/public/tx/7e4b",
  at: "2026-11-22T16:40:00Z",
  amount: 1000,
  xebraFee: 0.0455,
  ...over,
});

describe("the transfers record", () => {
  it("keeps valid rows, newest first, and totals them", () => {
    const r = parseRecord({
      updatedAt: "2026-11-22T17:00:00Z",
      transfers: [
        row(),
        row({
          id: "base:0x1",
          source: "base",
          proof: "fee-payment",
          tagged: true,
          amount: null,
          at: "2026-11-22T18:00:00Z",
          xebraFee: 0.0125,
        }),
      ],
    });
    expect(r?.transfers.map((t) => t.id)).toEqual(["base:0x1", "stellar:0xab"]);
    expect(r?.totals).toEqual({ transfers: 2, usdcSent: 1000, xebraFees: 0.058 });
    expect(r?.transfers[0]?.tagged).toBe(true);
    expect(r?.coverage).toEqual({});
  });

  it("keeps where a source's record starts, and drops a date it cannot read", () => {
    const r = parseRecord({
      updatedAt: "2026-11-22T17:00:00Z",
      coverage: { stellar: "2026-11-15T20:12:47.000Z", arc: "soon" },
      transfers: [],
    });
    expect(r?.coverage).toEqual({ stellar: "2026-11-15T20:12:47.000Z" });
  });

  it("drops rows it cannot show truthfully", () => {
    const r = parseRecord({
      updatedAt: "2026-11-22T17:00:00Z",
      transfers: [
        row({ id: "a", sourceTxUrl: "javascript:alert(1)" }),
        row({ id: "b", proof: "trust-me" }),
        row({ id: "c", at: "yesterday" }),
        row({ id: "d", sourceTx: "" }),
        "nonsense",
        row({ id: "ok" }),
      ],
    });
    expect(r?.transfers.map((t) => t.id)).toEqual(["ok"]);
  });

  it("refuses a file that is not a record", () => {
    expect(parseRecord(null)).toBeNull();
    expect(parseRecord({ transfers: [] })).toBeNull();
    expect(parseRecord({ updatedAt: "x", transfers: "no" })).toBeNull();
  });

  it("says unavailable rather than throwing when the file cannot be read", async () => {
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await loadTransfersRecord(down)).toEqual({ ok: false, reason: "unavailable" });
    const missing = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await loadTransfersRecord(missing)).toEqual({ ok: false, reason: "unavailable" });
    const bad = (async () => Response.json({ hello: 1 })) as unknown as typeof fetch;
    expect(await loadTransfersRecord(bad)).toEqual({ ok: false, reason: "malformed" });
  });
});
