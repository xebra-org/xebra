import { describe, expect, it } from "vitest";
import { chainName, groupBySource, loadRoutes } from "../components/routes-table";

const ok = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("loadRoutes", () => {
  it("reads the live list", async () => {
    const r = await loadRoutes(
      ok({ routes: [{ from: "stellar", to: "base", speeds: ["standard"] }], complete: true }),
    );
    expect(r.ok && r.routes).toHaveLength(1);
  });

  it("falls back instead of throwing when the fetch fails", async () => {
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await loadRoutes(boom)).toEqual({ ok: false });
  });

  it("falls back on an error status or a body of the wrong shape", async () => {
    const bad = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    expect(await loadRoutes(bad)).toEqual({ ok: false });
    expect(await loadRoutes(ok({ nope: 1 }))).toEqual({ ok: false });
  });

  it("reports a partial list", async () => {
    const r = await loadRoutes(ok({ routes: [], complete: false }));
    expect(r.ok && r.complete).toBe(false);
  });
});

describe("groupBySource", () => {
  it("keeps the API order and groups by source", () => {
    const g = groupBySource([
      { from: "stellar", to: "base", speeds: ["standard"] },
      { from: "sui", to: "stellar", speeds: ["standard"] },
      { from: "stellar", to: "solana", speeds: ["standard"] },
    ]);
    expect(g.map((x) => [x.from, x.to.length])).toEqual([
      ["stellar", 2],
      ["sui", 1],
    ]);
  });
});

it("names chains", () => {
  expect(chainName("stellar")).toBe("Stellar");
  expect(chainName("base")).toBe("Base");
});
