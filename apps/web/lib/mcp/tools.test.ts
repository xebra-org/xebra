import type { CircleHealth } from "@xebra/cctp-client";
import { type DomainForwardConfig, stellarDestination } from "@xebra/sdk/core";
import { describe, expect, it } from "vitest";
import { type Deps, buildTools } from "./tools";

const RECIPIENT = "0x5b38da6a701c568545dcfcb03fcb875f56beddc4";
const SOLANA_WALLET = "4UXmtLwyV5tRyzuCFtQccrHkepyVDnL29GLsg5LwFN82";
const STELLAR_TX = "a".repeat(64);
const EVM_TX = `0x${"b".repeat(64)}`;

const health = (over: Partial<CircleHealth> = {}, high = 20_000): CircleHealth =>
  ({
    status: "ok",
    reasons: [],
    checkedAt: 0,
    quote: { low: high, med: high, high },
    tiers: {
      standard: { finalityThreshold: 2000, low: high, med: high, high, minimumFeePpb: 0 },
      fast: { finalityThreshold: 1000, low: high, med: high, high, minimumFeePpb: 130_000 },
    },
    slowestMs: 10,
    budget: {},
    ...over,
  }) as unknown as CircleHealth;

const cfg = (maxForwardFee = 2_500_000n): DomainForwardConfig => ({
  forward: true,
  maxForwardFee,
  accountCreation: false,
  maxForwardFeeNewAccount: 0n,
});

function deps(over: Partial<Deps> = {}): Deps {
  return {
    siteUrl: "https://xebra.exchange",
    evmRoutes: { arcSendsTo: ["base"], arcReceivesFrom: [] },
    stellarRoutes: async () => ({
      destinations: [stellarDestination("solana"), stellarDestination("base")],
      domains: new Map([
        [5, cfg()],
        [6, cfg()],
      ]),
    }),
    circle: async () => health(),
    feeParams: async () => ({ feeBps: 10n, minFee: 3_000_000n }),
    delivery: async () => ({
      status: "known",
      state: "forwarding",
      forwardTxHash: null,
      reason: null,
    }),
    ...over,
  };
}

async function call(d: Deps, name: string, args: Record<string, unknown> = {}) {
  const tool = buildTools(d).find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(args);
}
const text = (r: { content: Array<{ text: string }> }) => r.content[0]?.text ?? "";

describe("tool catalogue", () => {
  it("is read-only throughout and describes every input", () => {
    const tools = buildTools(deps());
    expect(tools.map((t) => t.name)).toEqual([
      "list_routes",
      "quote_transfer",
      "create_transfer_link",
      "get_transfer_status",
    ]);
    for (const t of tools) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.annotations.destructiveHint).toBe(false);
      expect(t.description.length).toBeGreaterThan(40);
    }
  });
});

describe("list_routes", () => {
  it("lists Stellar's destinations and the routes around Arc", async () => {
    const res = await call(deps(), "list_routes");
    const routes = (
      res.structuredContent as { routes: Array<{ from: string; to: Array<{ id: string }> }> }
    ).routes;
    expect(routes.find((r) => r.from === "stellar")?.to.map((d) => d.id)).toEqual([
      "solana",
      "base",
    ]);
    expect(routes.find((r) => r.from === "arc")?.to.map((d) => d.id)).toEqual(["base"]);
  });

  it("says so when the contract could not be read", async () => {
    const res = await call(
      deps({
        stellarRoutes: async () => ({
          destinations: [stellarDestination("solana")],
          domains: null,
        }),
      }),
      "list_routes",
    );
    expect(text(res)).toContain("could not be read");
  });
});

describe("quote_transfer from Stellar", () => {
  it("applies the floor fee and Circle's delivery fee out of the amount", async () => {
    const res = await call(deps(), "quote_transfer", {
      from: "stellar",
      to: "base",
      amount: "100",
    });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({
      sent: "100.00",
      fee: "0.30",
      circleDeliveryFee: "0.02",
      xebraFee: "0.28",
      recipientReceives: "99.70",
      speed: "standard",
    });
  });

  it("charges the percentage once it passes the floor", async () => {
    const res = await call(deps(), "quote_transfer", {
      from: "stellar",
      to: "base",
      amount: "1000",
    });
    expect(res.structuredContent).toMatchObject({ fee: "1.00", recipientReceives: "999.00" });
  });

  it("asks for a larger amount when fees would pass a tenth", async () => {
    const d = deps({ circle: async () => health({}, 170_000) });
    const res = await call(d, "quote_transfer", { from: "stellar", to: "solana", amount: "1" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/at least \d/);
  });

  it("refuses when Circle's fee is above what the contract allows", async () => {
    const d = deps({
      stellarRoutes: async () => ({
        destinations: [stellarDestination("base")],
        domains: new Map([[6, cfg(100_000n)]]),
      }),
    });
    const res = await call(d, "quote_transfer", { from: "stellar", to: "base", amount: "100" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("above the limit");
  });

  it("refuses to price a route Circle reports down", async () => {
    const d = deps({
      circle: async () => health({ status: "down", reasons: ["Iris is not answering"] }),
    });
    const res = await call(d, "quote_transfer", { from: "stellar", to: "base", amount: "100" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Do not start one");
  });

  it("does not guess when the quote or the fee schedule cannot be read", async () => {
    expect(
      (
        await call(deps({ circle: async () => null }), "quote_transfer", {
          from: "stellar",
          to: "base",
          amount: "5",
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await call(deps({ feeParams: async () => null }), "quote_transfer", {
          from: "stellar",
          to: "base",
          amount: "5",
        })
      ).isError,
    ).toBe(true);
  });
});

describe("quote_transfer from an EVM chain", () => {
  it("prices both speeds where the chain has Fast", async () => {
    const d = deps({ evmRoutes: { arcSendsTo: [], arcReceivesFrom: ["base"] } });
    const res = await call(d, "quote_transfer", { from: "base", to: "arc", amount: "100" });
    expect(res.isError).toBeUndefined();
    const options = (res.structuredContent as { options: Array<{ speed: string }> }).options;
    expect(options.map((o) => o.speed)).toEqual(["standard", "fast"]);
  });

  it("prices Standard alone where the chain has no Fast", async () => {
    const res = await call(deps(), "quote_transfer", { from: "arc", to: "base", amount: "100" });
    expect(res.isError).toBeUndefined();
    const options = (res.structuredContent as { options: Array<{ speed: string }> }).options;
    expect(options.map((o) => o.speed)).toEqual(["standard"]);
  });
});

describe("input checks", () => {
  it("rejects routes that are not offered and ids it does not know", async () => {
    expect(
      (await call(deps(), "quote_transfer", { from: "base", to: "arc", amount: "5" })).isError,
    ).toBe(true);
    expect(
      (await call(deps(), "quote_transfer", { from: "stellar", to: "bitcoin", amount: "5" }))
        .isError,
    ).toBe(true);
    expect(
      (await call(deps(), "quote_transfer", { from: "stellar", to: "monad", amount: "5" })).isError,
    ).toBe(true);
  });

  it("rejects amounts that are not plain positive USDC", async () => {
    for (const amount of ["0", "-1", "abc", "1.1234567", "", 5, null]) {
      const res = await call(deps(), "quote_transfer", { from: "stellar", to: "base", amount });
      expect(res.isError).toBe(true);
    }
  });

  it("takes chain ids in any case", async () => {
    const res = await call(deps(), "quote_transfer", {
      from: "STELLAR",
      to: "Base",
      amount: "100",
    });
    expect(res.isError).toBeUndefined();
  });
});

describe("create_transfer_link", () => {
  it("builds a prefilled link and says the person signs it themselves", async () => {
    const res = await call(deps(), "create_transfer_link", {
      from: "stellar",
      to: "base",
      amount: "25.5",
      recipient: RECIPIENT,
    });
    expect(res.isError).toBeUndefined();
    const url = new URL((res.structuredContent as { url: string }).url);
    expect(url.origin).toBe("https://xebra.exchange");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: "stellar",
      to: "base",
      amount: "25.50",
      recipient: RECIPIENT,
    });
    expect(text(res)).toContain("Check the amount and recipient");
  });

  it("works without a recipient, and accepts a Solana wallet for Solana", async () => {
    expect(
      (await call(deps(), "create_transfer_link", { from: "stellar", to: "base", amount: "5" }))
        .isError,
    ).toBeUndefined();
    const sol = await call(deps(), "create_transfer_link", {
      from: "stellar",
      to: "solana",
      amount: "5",
      recipient: SOLANA_WALLET,
    });
    expect(sol.isError).toBeUndefined();
  });

  it("refuses a recipient that is wrong for the destination chain", async () => {
    const res = await call(deps(), "create_transfer_link", {
      from: "stellar",
      to: "base",
      amount: "5",
      recipient: SOLANA_WALLET,
    });
    expect(res.isError).toBe(true);
    const wrong = await call(deps(), "create_transfer_link", {
      from: "stellar",
      to: "solana",
      amount: "5",
      recipient: RECIPIENT,
    });
    expect(wrong.isError).toBe(true);
  });

  it("never lets a recipient smuggle extra parameters into the link", async () => {
    const res = await call(deps(), "create_transfer_link", {
      from: "stellar",
      to: "base",
      amount: "5",
      recipient: `${RECIPIENT}&to=solana`,
    });
    expect(res.isError).toBe(true);
  });

  it("refuses a route that is not offered", async () => {
    const res = await call(deps(), "create_transfer_link", {
      from: "stellar",
      to: "monad",
      amount: "5",
    });
    expect(res.isError).toBe(true);
  });
});

describe("get_transfer_status", () => {
  it("reports Circle's state for a Stellar burn", async () => {
    const res = await call(deps(), "get_transfer_status", { tx: STELLAR_TX });
    expect(text(res)).toContain("forwarding");
  });

  it("checks the hash against the source's own form", async () => {
    expect((await call(deps(), "get_transfer_status", { tx: EVM_TX })).isError).toBe(true);
    expect(
      (await call(deps(), "get_transfer_status", { tx: STELLAR_TX, from: "arc" })).isError,
    ).toBe(true);
    expect(
      (await call(deps(), "get_transfer_status", { tx: EVM_TX, from: "arc" })).isError,
    ).toBeUndefined();
  });

  it("points a failed delivery at /claim", async () => {
    const d = deps({
      delivery: async () => ({
        status: "known",
        state: "claimable",
        forwardTxHash: null,
        reason: "x".repeat(500),
      }),
    });
    const res = await call(d, "get_transfer_status", { tx: STELLAR_TX });
    expect(text(res)).toContain(`https://xebra.exchange/claim?tx=${STELLAR_TX}`);
    expect(((res.structuredContent as { reason: string }).reason ?? "").length).toBe(200);
  });

  it("says an unreadable status is not a failed transfer", async () => {
    const res = await call(
      deps({ delivery: async () => ({ status: "unknown", reason: "x" }) }),
      "get_transfer_status",
      { tx: STELLAR_TX },
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("does not mean the transfer failed");
  });
});
