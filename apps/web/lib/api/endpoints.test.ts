import { readFileSync } from "node:fs";
import {
  ClaimBuildSchema,
  ERROR_CODES,
  ProblemSchema,
  QuoteSchema,
  RoutesSchema,
  TransferBuildSchema,
  TransferStatusSchema,
} from "@xebra/sdk";
import { stellarDestination } from "@xebra/sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DELETE as catchAllDelete,
  GET as catchAllGet,
  HEAD as catchAllHead,
  PATCH as catchAllPatch,
  POST as catchAllPost,
  PUT as catchAllPut,
} from "../../app/v1/[[...rest]]/route";
import type { Deps } from "./deps";
import { endpoints } from "./endpoints";
import { ApiError } from "./errors";
import {
  RECIPIENT,
  SENDER,
  SOLANA_WALLET,
  STELLAR_TX,
  buildDeps,
  cfg,
  deps,
  health,
} from "./fakes";
import { TITLES, methodNotAllowed, notFound } from "./host";
import { preflight, problem } from "./http";
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

describe("paths the API does not have", () => {
  it("answers every method with a not_found problem, not the site's 404 page", async () => {
    for (const handler of [
      catchAllGet,
      catchAllHead,
      catchAllPost,
      catchAllPut,
      catchAllPatch,
      catchAllDelete,
    ]) {
      const res = await handler();
      expect(res.status).toBe(404);
      expect(await problemOf(res)).toMatchObject({
        code: "not_found",
        status: 404,
        detail: "The API has no such endpoint. See https://docs.xebra.exchange/api.",
      });
    }
  });
});

describe("quoting Solana", () => {
  it("prices opening the recipient's USDC account when the wallet has none", async () => {
    const calls: unknown[][] = [];
    const v1 = endpoints(
      createService(
        deps({
          build: buildDeps({
            solanaRecipient: async () => ({
              tokenAccount: "8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6",
              status: "missing",
            }),
          }),
          circle: async (...args: unknown[]) => {
            calls.push(args);
            return health();
          },
          stellarRoutes: async () => ({
            destinations: [stellarDestination("solana")],
            domains: new Map([
              [5, { ...cfg(), accountCreation: true, maxForwardFeeNewAccount: 4_500_000n }],
            ]),
          }),
        }),
      ),
    );
    const res = await v1.quote(
      get(`/quote?from=stellar&to=solana&amount=10&recipient=${SOLANA_WALLET}`),
    );
    expect(res.status).toBe(200);
    expect(calls.at(-1)).toEqual([27, 5, true]);
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

  it("refuses an oversized body that declares no length", async () => {
    const big = new TextEncoder().encode(JSON.stringify({ pad: "x".repeat(20_000) }));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < big.length; i += 1024) c.enqueue(big.slice(i, i + 1024));
        c.close();
      },
    });
    const req = new Request(`${BASE}/transfers`, {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await api().createTransfer(req);
    expect(res.status).toBe(400);
    expect((await problemOf(res)).detail).toContain("too large");
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

describe("the live instance", () => {
  afterEach(() => {
    vi.doUnmock("./wiring");
    vi.doUnmock("./service");
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("answers a missing environment variable as a 500 problem, and logs its name without returning it", async () => {
    // Nothing is faked: this is the real wiring, loaded without the first variable `lib/env.ts`
    // reads. That file throws while it loads, which is the failure a deployment would have.
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    // Loading the module the routes import must not be what fails. When it was, the caller got
    // Next's HTML 500 page and no handler ever ran.
    const { v1 } = await import("./instance");
    expect(logged).not.toHaveBeenCalled();

    const res = await v1.routes(get("/routes"));
    expect(res.status).toBe(500);
    const body = await problemOf(res);
    expect(body.code).toBe("internal_error");
    expect(body.detail).toBe("Something went wrong on our side. Nothing was sent.");
    expect(JSON.stringify(body)).not.toContain("NEXT_PUBLIC");
    // The name is in the log, where the person who can fix it will look. This reads every
    // argument of every line, so it holds whatever shape the log line is given.
    const logText = logged.mock.calls
      .flat()
      .map((part) => (part instanceof Error ? part.message : String(part)))
      .join(" ");
    expect(logText).toContain("NEXT_PUBLIC_NETWORK is not set");

    // Every endpoint that needs the service says the same.
    const again = await v1.quote(get("/quote?from=stellar&to=base&amount=10"));
    expect((await problemOf(again)).code).toBe("internal_error");
  });

  it("keeps a failed load, and does not ask for the wiring again", async () => {
    vi.resetModules();
    let loads = 0;
    vi.doMock("./wiring", () => {
      loads += 1;
      throw new Error("NEXT_PUBLIC_SOROBAN_RPC_URL is not set.");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { v1 } = await import("./instance");
    for (const call of [
      () => v1.routes(get("/routes")),
      () => v1.quote(get("/quote?from=stellar&to=base&amount=10")),
      () => v1.routes(get("/routes")),
    ]) {
      expect((await problemOf(await call())).code).toBe("internal_error");
    }
    // A variable missing from the bundle stays missing, so there is nothing to retry.
    expect(loads).toBe(1);
  });

  it("builds the service on the first call that needs it, and only once", async () => {
    vi.resetModules();
    let loads = 0;
    let builds = 0;
    vi.doMock("./wiring", () => {
      loads += 1;
      return { liveDeps: deps({ build: buildDeps() }) };
    });
    vi.doMock("./service", async (importOriginal) => {
      const real = await importOriginal<typeof import("./service")>();
      return {
        ...real,
        createService: (...args: Parameters<typeof real.createService>) => {
          builds += 1;
          return real.createService(...args);
        },
      };
    });

    const { v1 } = await import("./instance");
    expect([loads, builds]).toEqual([0, 0]);
    // Health asks nothing of the service, so it does not build one either.
    expect((await v1.health(get("/health"))).status).toBe(200);
    expect([loads, builds]).toEqual([0, 0]);

    const routes = await v1.routes(get("/routes"));
    expect(routes.status).toBe(200);
    expect(RoutesSchema.safeParse(await routes.json()).success).toBe(true);
    const quote = await v1.quote(get("/quote?from=stellar&to=base&amount=10"));
    expect(QuoteSchema.safeParse(await quote.json()).success).toBe(true);
    // Two calls, and two at once, still share the one service and whatever it has cached.
    await Promise.all([v1.routes(get("/routes")), v1.routes(get("/routes"))]);
    expect([loads, builds]).toEqual([1, 1]);
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

describe("problem titles", () => {
  /** What the docs' error table says of each code the API answers with: its status and title. */
  const documented = new Map(
    readFileSync(new URL("../../../docs/content/docs/errors/index.mdx", import.meta.url), "utf8")
      .split(/\r?\n/)
      .flatMap((row) => {
        const cells = row.match(/^\| \[`(\w+)`\]\(\/docs\/errors\/\w+\) \| (\d+) \| ([^|]+?) \|/);
        return cells ? [[cells[1], { status: Number(cells[2]), title: cells[3] }] as const] : [];
      }),
  );

  it("gives every code the title and status its docs page is listed under", async () => {
    // The table and the SDK name the same codes, so neither can gain one the other lacks.
    expect([...documented.keys()].sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      const body = await problemOf(problem(new ApiError(code, "A sentence for a person.")));
      expect(body.title, code).toBe(documented.get(code)?.title);
      expect(body.status, code).toBe(documented.get(code)?.status);
      // The fallback this replaced: a code with no title used to be shown as itself.
      expect(body.title, code).not.toBe(code);
    }
  });

  it("names the three codes that had no title", async () => {
    for (const [code, title] of [
      ["unauthorized", "Unauthorized"],
      ["not_found", "Not found"],
      ["rate_limited", "Rate limited"],
    ] as const) {
      expect((await problemOf(problem(new ApiError(code, "A sentence.")))).title).toBe(title);
    }
  });

  it("says the same from the middleware as from an endpoint", async () => {
    const detail = "The API lives under /v1. See https://docs.xebra.exchange/api.";
    expect(await notFound(detail).json()).toEqual(
      await problem(new ApiError("not_found", detail)).json(),
    );
    // A 405 has no code of its own, so it is `invalid_request` under another status: same title.
    const wrongMethod = await problemOf(methodNotAllowed("GET", ["POST", "OPTIONS"]));
    expect(wrongMethod.title).toBe(TITLES.invalid_request);
    expect(wrongMethod.title).toBe(
      (await problemOf(problem(new ApiError("invalid_request", "A sentence.")))).title,
    );
  });
});
