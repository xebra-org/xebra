import { tokenMessengerAbi } from "@xebra/cctp-evm";
import { EVM_CHAINS, stellarBurnRecipient } from "@xebra/sdk/core";
import { decodeFunctionData } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { BuildDeps, Deps } from "./deps";
import { ApiError } from "./errors";
import { EVM_SENDER, SENDER, STELLAR_RECIPIENT, buildDeps, deps } from "./fakes";
import { createService } from "./service";

const FEES = {
  evm: "0x32e95718A4D9B60F2e4Fb1d371189ac5DD28211A",
  solana: null,
  sui: null,
  aptos: null,
};
const TX = `0x${"c3".repeat(32)}`;

function svc(over: Partial<BuildDeps> = {}, top: Partial<Deps> = {}) {
  return createService(
    deps({
      build: buildDeps(over),
      evmRoutes: { arcSendsTo: [], arcReceivesFrom: [], evmToStellar: ["base"] },
      feeAddresses: FEES,
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

describe("EVM chains to Stellar", () => {
  it("lists Stellar from the chains switched on, Standard only", async () => {
    const { routes } = await svc().routes();
    expect(routes.find((g) => g.from === "base")?.to).toEqual([
      { id: "stellar", name: "Stellar", speeds: ["standard"] },
    ]);
    expect(routes.find((g) => g.from === "arbitrum")).toBeUndefined();
  });

  it("charges no Circle fee and Xebra's 0.01 plus 0.01%, from about 1.0102, and asks Circle nothing", async () => {
    const circle = vi.fn();
    const s = svc({}, { circle });
    const { options } = await s.quoteOptions({ from: "base", to: "stellar", amount: 10_000_000n });
    expect(options).toHaveLength(1);
    const o = options[0];
    if (!o?.ok) throw new Error("not priced");
    expect(o.priced.quote.fees).toEqual({
      // 0.01 + 0.01% of 10.
      xebra: 11_000n,
      circle: 0n,
      delivery: 0n,
      total: 11_000n,
    });
    // The least amount that still burns the 1 USDC the relayer completes.
    expect(o.priced.quote.minimum).toBe(1_010_101n);
    expect(o.priced.quote.recipientGets).toBe(9_989_000n);
    expect(circle).not.toHaveBeenCalled();
    const low = await s.quoteOptions({ from: "base", to: "stellar", amount: 1_010_100n });
    expect(low.options[0]?.ok).toBe(false);
    expect(
      (await refusal(s.quote({ from: "base", to: "stellar", amount: 5_000_000n, speed: "fast" })))
        .code,
    ).toBe("route_unavailable");
  });

  it("burns to Circle's Stellar forwarder, which also must call it, then pays the fee", async () => {
    const { steps } = await svc().buildTransfer({
      from: "base",
      to: "stellar",
      amount: 10_000_000n,
      sender: EVM_SENDER,
      recipient: STELLAR_RECIPIENT,
    });
    expect(steps.map((s) => s.id)).toEqual(["approve", "burn", "fee"]);
    const burn = steps[1];
    if (burn?.tx.kind !== "evm") throw new Error("not evm");
    expect(burn.tx.to).toBe(EVM_CHAINS.base.tokenMessengerAddress);
    expect(burn.expiresAt).toBeNull();
    const { args } = decodeFunctionData({ abi: tokenMessengerAbi, data: burn.tx.data as never });
    const expected = stellarBurnRecipient(STELLAR_RECIPIENT);
    // amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, finality, hook
    expect(args[0]).toBe(9_989_000n);
    expect(args[1]).toBe(27);
    expect(String(args[2]).toLowerCase()).toBe(expected.forwarder.toLowerCase());
    expect(String(args[4]).toLowerCase()).toBe(expected.forwarder.toLowerCase());
    expect(args[5]).toBe(0n);
    expect(args[6]).toBe(2000);
    expect(String(args[7]).toLowerCase()).toBe(expected.hookData.toLowerCase());
  });

  it("refuses a Stellar account without a USDC trustline before anything is signed", async () => {
    const s = svc({
      stellarAccount: async () => ({ exists: true, hasTrustline: false, balance: 0n }),
    });
    const err = await refusal(
      s.buildTransfer({
        from: "base",
        to: "stellar",
        amount: 10_000_000n,
        sender: EVM_SENDER,
        recipient: STELLAR_RECIPIENT,
      }),
    );
    expect(err.code).toBe("invalid_recipient");
  });

  it("reads status from Stellar's mint record, not Circle's forwarding", async () => {
    const stellarInboundStatus = vi.fn(async () => ({ state: "complete", delivered: false }));
    const s = svc({}, { stellarInboundStatus });
    const status = await s.transferStatus({ chain: "base", tx: TX });
    expect(stellarInboundStatus).toHaveBeenCalledWith(TX, 6);
    expect(status).toMatchObject({ state: "needs_claim", chain: "base" });
    stellarInboundStatus.mockResolvedValue({ state: "complete", delivered: true });
    expect((await s.transferStatus({ chain: "base", tx: TX })).state).toBe("delivered");
  });

  it("claims through the Stellar forwarder, paid by the payer's Stellar account", async () => {
    const stellarInboundClaim = vi.fn(async () => ({ ok: true as const, xdr: "AAAA" }));
    const s = svc({
      stellarInboundClaim,
      attestation: async () => ({
        status: "complete",
        message: "0x01",
        attestation: "0x02",
        destinationDomain: 27,
        sourceDomainId: 6,
      }),
    });
    await s.buildClaim({ chain: "base", tx: TX, payer: SENDER });
    expect(stellarInboundClaim).toHaveBeenCalledWith(TX, SENDER, 6);
  });
});
