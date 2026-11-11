import {
  ClaimBuildSchema,
  ProblemSchema,
  QuoteSchema,
  RoutesSchema,
  TransferBuildSchema,
  TransferStatusSchema,
} from "@xebra/sdk";
import { describe, expect, it } from "vitest";
import type { Deps } from "./deps";
import { endpoints } from "./endpoints";
import { RECIPIENT, SENDER, STELLAR_TX, buildDeps, deps } from "./fakes";
import { preflight } from "./http";
import { createService } from "./service";

const BASE = "https://api.xebra.exchange/v1";

function api(over: Partial<Deps> = {}) {
  return endpoints(createService(deps({ build: buildDeps(), ...over })));
}

const get = (path: string) => new Request(`${BASE}${path}`);
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function problemOf(res: Response) {
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  const body = await res.json();
  expect(ProblemSchema.safeParse(body).success).toBe(true);
  return body as { code: string; status: number; detail: string; type: string } & Record<
    string,
    unknown
  >;
}

describe("answers that parse with their schemas", () => {
  it("GET /routes", async () => {
    const res = await api().routes(get("/routes"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("s-maxage=30");
    const body = await res.json();
    expect(RoutesSchema.parse(body).routes).toContainEqual({
      from: "stellar",
      to: "base",
      speeds: ["standard"],
    });
  });

  it("GET /quote", async () => {
    const res = await api().quote(get("/quote?from=stellar&to=base&amount=10"));
    expect(res.status).toBe(200);
    const q = QuoteSchema.parse(await res.json());
    expect(q.amount).toBe("10");
  });

  it("POST /transfers", async () => {
    const res = await api().createTransfer(
      post("/transfers", {
        from: "stellar",
        to: "base",
        amount: "10",
        sender: SENDER,
        recipient: RECIPIENT,
      }),
    );
    expect(res.status).toBe(200);
    expect(TransferBuildSchema.parse(await res.json()).steps[0]?.tx.kind).toBe("stellar");
  });

  it("GET /transfers/{chain}/{tx}", async () => {
    const res = await api().getTransfer(get(`/transfers/stellar/${STELLAR_TX}`), {
      chain: "stellar",
      tx: STELLAR_TX,
    });
    expect(TransferStatusSchema.parse(await res.json()).state).toBe("delivering");
  });

  it("POST /claims", async () => {
    const res = await api().createClaim(
      post("/claims", { chain: "stellar", tx: STELLAR_TX, payer: RECIPIENT }),
    );
    expect(res.status).toBe(200);
    expect(ClaimBuildSchema.parse(await res.json()).steps).toHaveLength(1);
  });

  it("GET /health", async () => {
    expect(await (await api().health(get("/health"))).json()).toMatchObject({ status: "ok" });
  });
});

describe("amounts", () => {
  for (const bad of ["0", "1e3", "1.1234567", "-1", "", "abc"]) {
    it(`refuses ${JSON.stringify(bad)} as invalid_amount`, async () => {
      const res = await api().quote(
        get(`/quote?from=stellar&to=base&amount=${encodeURIComponent(bad)}`),
      );
      expect(res.status).toBe(422);
      expect((await problemOf(res)).code).toBe("invalid_amount");
    });
  }

  it("names the maximum, as an amount string, when one is exceeded", async () => {
    const res = await api({
      feeParams: async () => ({
        feeBps: 10n,
        minFee: 3_000_000n,
        minTransfer: 10_000_000n,
        maxTransfer: 1_000_000_000n,
      }),
    }).quote(get("/quote?from=stellar&to=base&amount=100.5"));
    const body = await problemOf(res);
    expect(body).toMatchObject({ code: "amount_above_maximum", status: 422, maximum: "100" });
    expect(body.type).toBe("https://docs.xebra.exchange/errors/amount_above_maximum");
  });
});

describe("bad requests", () => {
  it("refuses malformed JSON", async () => {
    const res = await api().createTransfer(post("/transfers", "{not json"));
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("invalid_request");
  });

  it("refuses unknown fields rather than ignoring a typo", async () => {
    const res = await api().createTransfer(
      post("/transfers", {
        from: "stellar",
        to: "base",
        amount: "10",
        sender: SENDER,
        recipient: RECIPIENT,
        maxfee: "1",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("refuses a chain id it does not know", async () => {
    const res = await api().quote(get("/quote?from=stellar&to=ethereum2&amount=10"));
    expect(res.status).toBe(400);
    expect((await problemOf(res)).detail).toContain("to");
  });

  it("says a route is unavailable when the chains exist but do not connect", async () => {
    const res = await api().quote(get("/quote?from=stellar&to=sui&amount=10"));
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("route_unavailable");
  });

  it("refuses an oversized body", async () => {
    const res = await api().createTransfer(post("/transfers", { pad: "x".repeat(20_000) }));
    expect(res.status).toBe(400);
  });
});

describe("failures on our side", () => {
  it("answers 503 with Retry-After when Circle cannot be read", async () => {
    const res = await api({ circle: async () => null }).quote(
      get("/quote?from=stellar&to=base&amount=10"),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("10");
    expect((await problemOf(res)).code).toBe("upstream_unavailable");
  });

  it("answers an unexpected error as a 500 problem, with no internals in it", async () => {
    const res = await api({
      stellarRoutes: async () => {
        throw new Error("secret stack detail");
      },
    }).routes(get("/routes"));
    expect(res.status).toBe(500);
    const body = await problemOf(res);
    expect(body.code).toBe("internal_error");
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});

describe("CORS", () => {
  it("answers preflight with 204 and the allowed methods", () => {
    const res = preflight();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("sends the CORS header on successes and problems alike", async () => {
    const ok = await api().routes(get("/routes"));
    const bad = await api().quote(get("/quote?from=x"));
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    expect(bad.headers.get("access-control-allow-origin")).toBe("*");
  });
});
