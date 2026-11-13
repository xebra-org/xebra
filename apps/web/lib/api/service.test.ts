import { EVM_CHAINS, stellarDestination } from "@xebra/sdk/core";
import { describe, expect, it } from "vitest";
import type { Deps } from "./deps";
import { ApiError } from "./errors";
import { EVM_TX, STELLAR_TX, cfg, deps, health } from "./fakes";
import { createService } from "./service";

const NOW = 1_800_000_000_000;
const svc = (over: Partial<Deps> = {}) => createService(deps(over), () => NOW);

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(err)}`);
  return err;
}

describe("routes", () => {
  it("offers Sui to Stellar only when it is switched on", async () => {
    const off = await svc().routes();
    expect(off.routes.some((g) => g.from === "sui")).toBe(false);
    const on = await svc({ suiStellar: { enabled: true, maxUnits: null } }).routes();
    expect(on.routes.find((g) => g.from === "sui")?.to).toEqual([
      { id: "stellar", name: "Stellar", speeds: ["standard"] },
    ]);
  });

  it("offers Fast only from chains Circle runs it on, and never from Stellar", async () => {
    const { routes } = await svc().routes();
    expect(routes.find((g) => g.from === "stellar")?.to[0]?.speeds).toEqual(["standard"]);
    expect(routes.find((g) => g.from === "arc")?.to[0]?.speeds).toEqual(
      EVM_CHAINS.arc.fast ? ["standard", "fast"] : ["standard"],
    );
  });
});

describe("quote", () => {
  it("prices Stellar to Base in 6-decimal units that add up", async () => {
    const { quote } = await svc().quote({ from: "stellar", to: "base", amount: 10_000_000n });
    expect(quote.amount).toBe(10_000_000n);
    expect(quote.fees.total).toBe(quote.fees.xebra + quote.fees.circle + quote.fees.delivery);
    expect(quote.recipientGets + quote.fees.total).toBeGreaterThanOrEqual(quote.amount);
    expect(quote.recipientGets + quote.fees.total - quote.amount).toBeLessThan(2n);
    expect(quote.expiresAt).toBe(new Date(NOW + 60_000).toISOString());
  });

  it("refuses a destination the contract has not committed, even if the table lists it", async () => {
    const err = await refusal(
      svc({
        stellarRoutes: async () => ({
          destinations: [stellarDestination("base"), stellarDestination("arbitrum")],
          domains: new Map([[6, cfg()]]),
        }),
      }).quote({ from: "stellar", to: "arbitrum", amount: 10_000_000n }),
    );
    expect(err.code).toBe("route_unavailable");
    expect(err.status).toBe(422);
  });

  it("refuses a route that is not offered at all", async () => {
    const err = await refusal(svc().quote({ from: "stellar", to: "monad", amount: 10_000_000n }));
    expect(err.code).toBe("route_unavailable");
  });

  it("gives no price when Circle's fee cannot be read, rather than a guessed one", async () => {
    const err = await refusal(
      svc({ circle: async () => null }).quote({ from: "stellar", to: "base", amount: 10_000_000n }),
    );
    expect(err).toMatchObject({ code: "upstream_unavailable", status: 503 });
  });

  it("refuses when Circle says the route is down", async () => {
    const err = await refusal(
      svc({ circle: async () => health({ status: "down", reasons: ["paused"] }) }).quote({
        from: "stellar",
        to: "base",
        amount: 10_000_000n,
      }),
    );
    expect(err.code).toBe("upstream_unavailable");
    expect(err.detail).toContain("paused");
  });

  it("holds Stellar transfers to the contract's per-transfer bounds, with the bound in the error", async () => {
    const bounded = svc({
      feeParams: async () => ({
        feeBps: 10n,
        minFee: 3_000_000n,
        minTransfer: 10_000_000n,
        maxTransfer: 1_000_000_000n,
      }),
    });
    const over = await refusal(
      bounded.quote({ from: "stellar", to: "base", amount: 100_000_001n }),
    );
    expect(over).toMatchObject({ code: "amount_above_maximum", extra: { maximum: 100_000_000n } });
    const fine = await bounded.quote({ from: "stellar", to: "base", amount: 100_000_000n });
    expect(fine.quote.maximum).toBe(100_000_000n);
  });

  it("names the minimum when fees would take more than a tenth", async () => {
    // The fake's delivery fee is 0.02 USDC, more than a tenth of 0.05.
    const err = await refusal(svc().quote({ from: "stellar", to: "base", amount: 50_000n }));
    expect(err.code).toBe("amount_below_minimum");
    expect(typeof err.extra.minimum).toBe("bigint");
    expect(err.extra.minimum as bigint).toBeGreaterThan(200_000n);
  });

  it("splits an EVM Fast quote into Circle's transfer fee and the delivery fee", async () => {
    if (!EVM_CHAINS.arc.fast) return;
    const { quote } = await svc().quote({
      from: "arc",
      to: "base",
      amount: 25_500_000n,
      speed: "fast",
    });
    expect(quote.fees.circle).toBeGreaterThan(0n);
    expect(quote.fees.delivery).toBe(20_000n);
    expect(quote.recipientGets).toBe(25_500_000n - quote.fees.total);
  });

  it("prices one EVM chain to another through the mesh, with no Arc in between", async () => {
    const mesh = svc({
      evmRoutes: { arcSendsTo: [], arcReceivesFrom: [], evmMesh: ["unichain", "base"] },
    });
    const { routes } = await mesh.routes();
    expect(routes.find((g) => g.from === "unichain")?.to.map((d) => d.id)).toEqual(["base"]);
    expect(routes.find((g) => g.from === "base")?.to.map((d) => d.id)).toEqual(["unichain"]);
    const { quote } = await mesh.quote({ from: "unichain", to: "base", amount: 25_000_000n });
    expect(quote.recipientGets).toBe(25_000_000n - quote.fees.total);
    const err = await refusal(mesh.quote({ from: "unichain", to: "sonic", amount: 25_000_000n }));
    expect(err.code).toBe("route_unavailable");
  });

  it("refuses Fast from Stellar", async () => {
    const err = await refusal(
      svc().quote({ from: "stellar", to: "base", amount: 10_000_000n, speed: "fast" }),
    );
    expect(err.code).toBe("route_unavailable");
  });

  it("prices Sui to Stellar at no fee and enforces its cap", async () => {
    const s = svc({ suiStellar: { enabled: true, maxUnits: 5_000_000n } });
    const { quote } = await s.quote({ from: "sui", to: "stellar", amount: 5_000_000n });
    expect(quote).toMatchObject({ recipientGets: 5_000_000n, fees: { total: 0n } });
    const err = await refusal(s.quote({ from: "sui", to: "stellar", amount: 5_000_001n }));
    expect(err.code).toBe("amount_above_maximum");
  });

  it("refuses zero", async () => {
    const err = await refusal(svc().quote({ from: "stellar", to: "base", amount: 0n }));
    expect(err.code).toBe("invalid_amount");
  });
});

describe("transferStatus", () => {
  const states: Array<[string, string]> = [
    ["waiting", "pending"],
    ["forwarding", "delivering"],
    ["delivered", "delivered"],
    ["claimable", "needs_claim"],
    ["failed", "failed"],
  ];
  for (const [circle, ours] of states) {
    it(`reads Circle's ${circle} as ${ours}`, async () => {
      const s = svc({
        delivery: async () => ({
          status: "known",
          state: circle,
          forwardTxHash: null,
          reason: null,
        }),
      });
      const status = await s.transferStatus({ chain: "stellar", tx: STELLAR_TX });
      expect(status.state).toBe(ours);
      expect(status.claimUrl !== null).toBe(ours === "needs_claim" || ours === "failed");
    });
  }

  it("names the source domain in an EVM claim link", async () => {
    const s = svc({
      delivery: async () => ({
        status: "known",
        state: "claimable",
        forwardTxHash: null,
        reason: null,
      }),
    });
    const status = await s.transferStatus({ chain: "arc", tx: EVM_TX });
    expect(status.claimUrl).toBe(
      `https://xebra.exchange/claim?tx=${EVM_TX}&src=${EVM_CHAINS.arc.cctpDomainId}`,
    );
  });

  it("refuses a hash of the wrong shape for the chain", async () => {
    expect((await refusal(svc().transferStatus({ chain: "stellar", tx: EVM_TX }))).code).toBe(
      "invalid_request",
    );
    expect((await refusal(svc().transferStatus({ chain: "arc", tx: STELLAR_TX }))).code).toBe(
      "invalid_request",
    );
  });

  it("says it could not ask, never that the transfer failed, when Circle is unreachable", async () => {
    const err = await refusal(
      svc({ delivery: async () => ({ status: "unknown", reason: "budget" }) }).transferStatus({
        chain: "stellar",
        tx: STELLAR_TX,
      }),
    );
    expect(err.code).toBe("upstream_unavailable");
  });
});
