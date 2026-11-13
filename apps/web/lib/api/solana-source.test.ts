import type { TransferStep } from "@xebra/sdk/build";
import { describe, expect, it, vi } from "vitest";
import type { BuildDeps, Deps } from "./deps";
import { ApiError } from "./errors";
import { RECIPIENT, STELLAR_RECIPIENT, buildDeps, deps, health } from "./fakes";
import { createService } from "./service";

/** The /v1 surface for transfers that start on Solana (`SOLANA_SENDS_TO`). */

const SOLANA_SENDER = "DtG5HoH4WKC6HjmdTm4k7PNreyQmB1UmpFfqHMCeNj9y";
const SIG =
  "3uY8BdRmijxsnuAqxx5sy12qLBf1QvdoxxJdJgDaveyiHHEMDAwbjBimteY49piuvBoTYhmXu3hELvcyp6AjCSX6";
const STEP: TransferStep = {
  id: "burn",
  chain: "solana",
  description: "burn",
  tx: { kind: "solana", transaction: "AAAA" },
  expiresAt: null,
};

function svc(over: Partial<BuildDeps> = {}, top: Partial<Deps> = {}) {
  return createService(
    deps({
      build: buildDeps({ solanaBurn: async () => STEP, ...over }),
      solanaSource: { evm: ["base", "arc"], stellar: true, maxUnits: null },
      ...top,
    }),
  );
}

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(err)}`);
  return err;
}

describe("routes", () => {
  it("lists Solana with what the switch names, Standard only", async () => {
    const { routes } = await svc().routes();
    const solana = routes.find((g) => g.from === "solana");
    expect(solana?.to.map((d) => d.id)).toEqual(["stellar", "base", "arc"]);
    expect(solana?.to.every((d) => d.speeds.join() === "standard")).toBe(true);
  });

  it("leaves Solana out while the switch is off", async () => {
    const off = svc({}, { solanaSource: { evm: [], stellar: false, maxUnits: null } });
    expect((await off.routes()).routes.some((g) => g.from === "solana")).toBe(false);
    const absent = createService(deps());
    expect((await absent.routes()).routes.some((g) => g.from === "solana")).toBe(false);
    expect(
      (await refusal(absent.quote({ from: "solana", to: "base", amount: 5_000_000n }))).code,
    ).toBe("route_unavailable");
  });
});

describe("quote", () => {
  it("to an EVM chain: Circle's delivery fee from domain 5, and nothing for Xebra", async () => {
    const circle = vi.fn(async () => health({}, 54_000));
    const { quote } = await svc({}, { circle }).quote({
      from: "solana",
      to: "base",
      amount: 5_000_000n,
    });
    expect(circle).toHaveBeenCalledWith(5, 6);
    expect(quote.fees.xebra).toBe(0n);
    expect(quote.fees.delivery).toBeGreaterThan(0n);
    expect(quote.recipientGets).toBe(5_000_000n - quote.fees.total);
  });

  it("to Stellar: no fee at all, from 1 USDC", async () => {
    const circle = vi.fn();
    const s = svc({}, { circle });
    const { quote } = await s.quote({ from: "solana", to: "stellar", amount: 2_000_000n });
    expect(quote.fees.total).toBe(0n);
    expect(quote.recipientGets).toBe(2_000_000n);
    expect(quote.minimum).toBe(1_000_000n);
    expect(circle).not.toHaveBeenCalled();
    expect((await refusal(s.quote({ from: "solana", to: "stellar", amount: 999_999n }))).code).toBe(
      "amount_below_minimum",
    );
  });

  it("refuses Fast and an amount over the cap", async () => {
    const s = svc({}, { solanaSource: { evm: ["base"], stellar: true, maxUnits: 10_000_000n } });
    expect(
      (await refusal(s.quote({ from: "solana", to: "base", amount: 5_000_000n, speed: "fast" })))
        .code,
    ).toBe("route_unavailable");
    expect((await refusal(s.quote({ from: "solana", to: "base", amount: 10_000_001n }))).code).toBe(
      "amount_above_maximum",
    );
  });
});

describe("buildTransfer", () => {
  it("builds the Solana burn at the fee it quoted", async () => {
    const solanaBurn = vi.fn(async () => STEP);
    const { quote, steps } = await svc({ solanaBurn }).buildTransfer({
      from: "solana",
      to: "base",
      amount: 5_000_000n,
      sender: SOLANA_SENDER,
      recipient: RECIPIENT,
    });
    expect(steps).toEqual([STEP]);
    expect(solanaBurn).toHaveBeenCalledWith({
      sender: SOLANA_SENDER,
      amount: 5_000_000n,
      to: "base",
      recipient: RECIPIENT,
      maxFee: quote.fees.delivery,
    });
  });

  it("builds a burn to Stellar with no fee, once the recipient can receive", async () => {
    const solanaBurn = vi.fn(async () => STEP);
    await svc({ solanaBurn }).buildTransfer({
      from: "solana",
      to: "stellar",
      amount: 5_000_000n,
      sender: SOLANA_SENDER,
      recipient: STELLAR_RECIPIENT,
    });
    expect(solanaBurn).toHaveBeenCalledWith(expect.objectContaining({ to: "stellar", maxFee: 0n }));
    const noTrustline = svc({
      solanaBurn,
      stellarAccount: async () => ({ exists: true, hasTrustline: false, balance: 0n }),
    });
    expect(
      (
        await refusal(
          noTrustline.buildTransfer({
            from: "solana",
            to: "stellar",
            amount: 5_000_000n,
            sender: SOLANA_SENDER,
            recipient: STELLAR_RECIPIENT,
          }),
        )
      ).code,
    ).toBe("invalid_recipient");
    expect(solanaBurn).toHaveBeenCalledTimes(1);
  });

  it("refuses a sender that is not a Solana wallet", async () => {
    const err = await refusal(
      svc().buildTransfer({
        from: "solana",
        to: "base",
        amount: 5_000_000n,
        sender: RECIPIENT,
        recipient: RECIPIENT,
      }),
    );
    expect(err.code).toBe("invalid_request");
    expect(err.detail).toMatch(/Solana wallet/);
  });

  it("passes the builder's own refusals through", async () => {
    const solanaBurn = async () => {
      throw new ApiError("insufficient_balance", "That Solana wallet holds 1 USDC, less than 5.");
    };
    const err = await refusal(
      svc({ solanaBurn }).buildTransfer({
        from: "solana",
        to: "base",
        amount: 5_000_000n,
        sender: SOLANA_SENDER,
        recipient: RECIPIENT,
      }),
    );
    expect(err.code).toBe("insufficient_balance");
  });
});

describe("transferStatus", () => {
  it("reads a burn into Stellar from Stellar's side", async () => {
    const s = svc(
      {},
      {
        solanaStellarStatus: async () => ({ state: "complete", delivered: false }),
      },
    );
    expect(await s.transferStatus({ chain: "solana", tx: SIG })).toMatchObject({
      state: "needs_claim",
      chain: "solana",
      tx: SIG,
    });
  });

  it("reads a forwarded burn from Circle's delivery record, by its signature on domain 5", async () => {
    const delivery = vi.fn(async () => ({
      status: "known",
      state: "delivered",
      forwardTxHash: "0xabc",
      reason: null,
    }));
    const s = svc(
      {},
      {
        delivery,
        solanaStellarStatus: async () => ({
          state: "complete",
          delivered: false,
          refusal: "not a burn to Stellar",
        }),
      },
    );
    expect(await s.transferStatus({ chain: "solana", tx: SIG })).toMatchObject({
      state: "delivered",
      deliveryTx: "0xabc",
      tx: SIG,
    });
    expect(delivery).toHaveBeenCalledWith(SIG, 5);
  });

  it("refuses something that is not a signature", async () => {
    expect((await refusal(svc().transferStatus({ chain: "solana", tx: "0x12" }))).code).toBe(
      "invalid_request",
    );
  });
});

describe("buildClaim", () => {
  it("mints a Solana burn into Stellar from the payer's Stellar account", async () => {
    const solanaStellarClaim = vi.fn(async () => ({ ok: true as const, xdr: "AAAA" }));
    const attestation = vi.fn(async () => ({
      status: "complete",
      message: "0x01",
      attestation: "0x02",
      destinationDomain: 27,
      sourceDomainId: 5,
    }));
    const { steps } = await svc({ solanaStellarClaim, attestation }).buildClaim({
      chain: "solana",
      tx: SIG,
      payer: STELLAR_RECIPIENT,
    });
    expect(attestation).toHaveBeenCalledWith(SIG, 5);
    expect(solanaStellarClaim).toHaveBeenCalledWith(SIG, STELLAR_RECIPIENT);
    expect(steps[0]).toMatchObject({ id: "claim", chain: "stellar", tx: { kind: "stellar" } });
  });

  it("mints a Solana burn to an EVM chain there, like any other source", async () => {
    const { steps } = await svc().buildClaim({ chain: "solana", tx: SIG, payer: RECIPIENT });
    expect(steps[0]).toMatchObject({ id: "claim", chain: "base", tx: { kind: "evm" } });
  });
});
