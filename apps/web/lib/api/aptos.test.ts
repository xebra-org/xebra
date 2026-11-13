import { FORWARD_HOOK, ZERO_BYTES32 } from "@xebra/cctp-evm";
import { APTOS_BURN_SCRIPT, APTOS_CCTP } from "@xebra/sdk/build";
import { describe, expect, it, vi } from "vitest";
import type { AptosBuildAnswer } from "../aptos/build";
import { APTOS_ALL_DESTINATIONS } from "../aptos/config";
import type { BuildDeps, Deps } from "./deps";
import { ApiError } from "./errors";
import { RECIPIENT, STELLAR_RECIPIENT, buildDeps, deps, health } from "./fakes";
import { createService } from "./service";

const NOW = 1_800_000_000_000;
const SENDER = "0x744bf58c5562a9ebc71ef07743e8e3385eec8e5743fde745d937ba22d37e9eb1";
const TX = `0x${"cd".repeat(32)}`;

const BUILT: AptosBuildAnswer = {
  status: 200,
  body: {
    transaction: {
      kind: "aptos",
      chainId: 1,
      bytecode: APTOS_BURN_SCRIPT,
      arguments: {
        amount: "10000000",
        destinationDomain: 6,
        mintRecipient: `0x${"00".repeat(12)}${RECIPIENT.slice(2)}`,
        destinationCaller: ZERO_BYTES32,
        burnToken: APTOS_CCTP.usdc,
        maxFee: "20000",
        minFinalityThreshold: 2000,
        hookData: FORWARD_HOOK,
      },
    },
    envelope: {
      sequenceNumber: "1",
      maxGasAmount: "2000",
      gasUnitPrice: "100",
      expirationTimestampSecs: "1800000600",
    },
    maxFee: "20000",
    received: "9980000",
  },
};

function svc(over: Partial<BuildDeps> = {}, top: Partial<Deps> = {}) {
  return createService(
    deps({
      build: buildDeps({ aptosBuild: async () => BUILT, ...over }),
      aptos: { destinations: [...APTOS_ALL_DESTINATIONS], maxUnits: null },
      ...top,
    }),
    () => NOW,
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

describe("Aptos in the public API", () => {
  it("lists Aptos routes only when switched on, Standard only", async () => {
    const off = await createService(deps()).routes();
    expect(off.routes.some((g) => g.from === "aptos")).toBe(false);
    const on = await svc(
      {},
      { aptos: { destinations: ["stellar", "base"], maxUnits: null } },
    ).routes();
    expect(on.routes.find((g) => g.from === "aptos")?.to).toEqual([
      { id: "stellar", name: "Stellar", speeds: ["standard"] },
      { id: "base", name: "Base", speeds: ["standard"] },
    ]);
  });

  it("prices forwarded routes from Circle's Aptos quote, and Stellar at no fee", async () => {
    const circle = vi.fn(async () => health());
    const s = svc({}, { circle });
    const toBase = await s.quote({ from: "aptos", to: "base", amount: 10_000_000n });
    expect(circle).toHaveBeenCalledWith(9, 6);
    expect(toBase.quote.fees).toEqual({ xebra: 0n, circle: 0n, delivery: 20_000n, total: 20_000n });
    expect(toBase.quote.recipientGets).toBe(9_980_000n);
    const toStellar = await s.quote({ from: "aptos", to: "stellar", amount: 10_000_000n });
    expect(toStellar.quote.fees.total).toBe(0n);
    expect(toStellar.quote.recipientGets).toBe(10_000_000n);
    // No Fast from Aptos.
    expect(
      (await refusal(s.quote({ from: "aptos", to: "base", amount: 10_000_000n, speed: "fast" })))
        .code,
    ).toBe("route_unavailable");
  });

  it("refuses a destination the switch does not name, and amounts over the cap", async () => {
    const s = svc({}, { aptos: { destinations: ["base"], maxUnits: 5_000_000n } });
    expect((await refusal(s.quote({ from: "aptos", to: "arc", amount: 1_000_000n }))).code).toBe(
      "route_unavailable",
    );
    expect((await refusal(s.quote({ from: "aptos", to: "base", amount: 6_000_000n }))).code).toBe(
      "amount_above_maximum",
    );
  });

  it("builds the burn through the Aptos builder with the fee it quoted", async () => {
    const aptosBuild = vi.fn(async () => BUILT);
    const { steps, quote } = await svc({ aptosBuild }).buildTransfer({
      from: "aptos",
      to: "base",
      amount: 10_000_000n,
      sender: SENDER,
      recipient: RECIPIENT,
    });
    expect(aptosBuild).toHaveBeenCalledWith({
      sender: SENDER,
      amount: "10",
      to: "base",
      recipient: RECIPIENT,
      maxFee: "20000",
    });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.chain).toBe("aptos");
    expect(steps[0]?.tx).toEqual({
      kind: "aptos",
      chainId: 1,
      bytecode: APTOS_BURN_SCRIPT,
      arguments: (BUILT.body as { transaction: { arguments: unknown } }).transaction.arguments,
    });
    expect(steps[0]?.expiresAt).toBe(quote.expiresAt);
  });

  it("turns the builder's refusals into API errors", async () => {
    const answer = (status: number, error: string) => async () => ({ status, body: { error } });
    const build = (over: Partial<BuildDeps>) =>
      refusal(
        svc(over).buildTransfer({
          from: "aptos",
          to: "base",
          amount: 10_000_000n,
          sender: SENDER,
          recipient: RECIPIENT,
        }),
      );
    expect((await build({ aptosBuild: answer(409, "fee rose") })).code).toBe("fee_above_limit");
    expect(
      (await build({ aptosBuild: answer(422, "That Aptos address holds 1 USDC, less than 10.") }))
        .code,
    ).toBe("insufficient_balance");
    expect((await build({ aptosBuild: answer(503, "Circle down") })).code).toBe(
      "upstream_unavailable",
    );
    expect((await build({ aptosBuild: answer(422, "Aptos would reject the burn") })).code).toBe(
      "transaction_rejected",
    );
  });

  it("refuses a sender that is not an Aptos address", async () => {
    const err = await refusal(
      svc().buildTransfer({
        from: "aptos",
        to: "stellar",
        amount: 1_000_000n,
        sender: STELLAR_RECIPIENT,
        recipient: STELLAR_RECIPIENT,
      }),
    );
    expect(err.code).toBe("invalid_request");
    expect(err.message).toContain("Aptos");
  });

  it("reads a burn to Stellar from the Stellar side, and any other from Circle's record", async () => {
    const delivery = vi.fn(async () => ({
      status: "known",
      state: "delivered",
      forwardTxHash: "0xf",
    }));
    const toStellar = svc(
      {},
      { delivery, aptosStatus: async () => ({ state: "complete", delivered: true }) },
    );
    expect(await toStellar.transferStatus({ chain: "aptos", tx: TX })).toMatchObject({
      state: "delivered",
      chain: "aptos",
    });
    expect(delivery).not.toHaveBeenCalled();

    const forwarded = svc(
      {},
      {
        delivery,
        aptosStatus: async () => ({ state: "complete", refusal: "not a burn to Stellar" }),
      },
    );
    expect(await forwarded.transferStatus({ chain: "aptos", tx: TX })).toMatchObject({
      state: "delivered",
      deliveryTx: "0xf",
    });
    expect(delivery).toHaveBeenCalledWith(TX, 9);
  });

  it("says Aptos is off rather than looking a burn up", async () => {
    const s = svc({}, { aptos: { destinations: [], maxUnits: null } });
    expect((await refusal(s.transferStatus({ chain: "aptos", tx: TX }))).code).toBe(
      "route_unavailable",
    );
  });

  it("claims an attested burn to Stellar with the payer's Stellar account", async () => {
    const aptosClaim = vi.fn(async () => ({ ok: true as const, xdr: "AAAA" }));
    const s = svc({
      aptosClaim,
      attestation: async () => ({
        status: "complete",
        message: "0x01",
        attestation: "0x02",
        destinationDomain: 27,
        sourceDomainId: 9,
      }),
    });
    const { steps } = await s.buildClaim({ chain: "aptos", tx: TX, payer: STELLAR_RECIPIENT });
    expect(aptosClaim).toHaveBeenCalledWith(TX, STELLAR_RECIPIENT);
    expect(steps[0]).toMatchObject({ id: "claim", chain: "stellar", tx: { kind: "stellar" } });
    expect((await refusal(s.buildClaim({ chain: "aptos", tx: TX, payer: SENDER }))).code).toBe(
      "invalid_request",
    );
  });
});
