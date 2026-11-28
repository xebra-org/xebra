import {
  Networks,
  type Transaction,
  TransactionBuilder,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";
import { tokenMessengerAbi } from "@xebra/cctp-evm";
import {
  EVM_CHAINS,
  XEBRA_WRAPPERS,
  stellarBurnRecipient,
  stellarDestination,
} from "@xebra/sdk/core";
import { decodeFunctionData } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { BuildDeps, Deps } from "./deps";
import { ApiError } from "./errors";
import {
  EVM_SENDER,
  SENDER,
  STELLAR_RECIPIENT,
  SUI_SENDER,
  WRAPPER_SETTINGS,
  buildDeps,
  cfg,
  deps,
} from "./fakes";
import { createService } from "./service";

/**
 * Arc to Stellar and Arc to Sui: two routes Circle does not deliver, completed by Xebra's relayers.
 * Arc keeps its wrapper for the routes Circle delivers; these two burn to Circle directly, because
 * the wrapper always asks Circle to forward.
 */

const FEES = {
  evm: "0x32e95718A4D9B60F2e4Fb1d371189ac5DD28211A",
  solana: null,
  sui: null,
  aptos: null,
};
const TX = `0x${"c3".repeat(32)}`;
const SUI_RECIPIENT = `0x${"7a".repeat(32)}`;
const ARC = EVM_CHAINS.arc;

function svc(
  routes: Partial<Deps["evmRoutes"]> = {},
  over: Partial<BuildDeps> = {},
  top: Partial<Deps> = {},
) {
  return createService(
    deps({
      build: buildDeps({ evmWrapperOn: true, ...over }),
      evmRoutes: {
        arcSendsTo: ["base"],
        arcReceivesFrom: [],
        evmToStellar: ["arc"],
        evmToSui: ["arc"],
        ...routes,
      },
      // Arc's wrapper is on, as in production, and must not be used for these two.
      evmWrapperAddress: (chain) => XEBRA_WRAPPERS[chain.id] ?? null,
      evmWrapperSettings: async () => WRAPPER_SETTINGS,
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

function burnArgs(steps: Awaited<ReturnType<ReturnType<typeof svc>["buildTransfer"]>>["steps"]) {
  const burn = steps.find((s) => s.id === "burn");
  if (burn?.tx.kind !== "evm") throw new Error("no EVM burn");
  return {
    to: burn.tx.to,
    expiresAt: burn.expiresAt,
    ...decodeFunctionData({ abi: tokenMessengerAbi, data: burn.tx.data as never }),
  };
}

describe("route switches", () => {
  it("offers neither while their lists are unset (production today)", async () => {
    const { routes } = await svc({ evmToStellar: [], evmToSui: [] }).routes();
    const arc = routes.find((g) => g.from === "arc")?.to.map((d) => d.id);
    expect(arc).toEqual(["base"]);
  });

  it("lists Stellar and Sui from Arc once named, Standard only", async () => {
    const { routes } = await svc().routes();
    const arc = routes.find((g) => g.from === "arc")?.to ?? [];
    expect(arc.find((d) => d.id === "stellar")).toEqual({
      id: "stellar",
      name: "Stellar",
      speeds: ["standard"],
    });
    expect(arc.find((d) => d.id === "sui")).toEqual({
      id: "sui",
      name: "Sui",
      speeds: ["standard"],
    });
    // Only the chains named: Base sends nowhere here.
    expect(routes.find((g) => g.from === "base")).toBeUndefined();
  });

  it("refuses a quote to Sui from a chain not named", async () => {
    const s = svc({ evmToSui: ["base"] });
    const err = await refusal(s.quote({ from: "arc", to: "sui", amount: 5_000_000n }));
    expect(err.code).toBe("route_unavailable");
  });
});

describe("Arc to Stellar", () => {
  it("burns straight to Circle's messenger with the forwarder as recipient and caller, wrapper or not", async () => {
    const { steps, quote } = await svc().buildTransfer({
      from: "arc",
      to: "stellar",
      amount: 5_000_000n,
      sender: EVM_SENDER,
      recipient: STELLAR_RECIPIENT,
    });
    expect(steps.map((s) => s.id)).toEqual(["approve", "burn", "fee"]);
    const b = burnArgs(steps);
    expect(b.to).toBe(ARC.tokenMessengerAddress);
    expect(b.functionName).toBe("depositForBurnWithHook");
    const expected = stellarBurnRecipient(STELLAR_RECIPIENT);
    expect(b.args?.[1]).toBe(27);
    expect(String(b.args?.[2]).toLowerCase()).toBe(expected.forwarder.toLowerCase());
    expect(String(b.args?.[4]).toLowerCase()).toBe(expected.forwarder.toLowerCase());
    expect(b.args?.[5]).toBe(0n);
    expect(quote.fees.circle).toBe(0n);
    expect(b.expiresAt).toBeNull();
  });

  it("hands an attested, unminted burn to the relayer from a status poll", async () => {
    const stellarInboundStatus = vi.fn(async () => ({ state: "complete", delivered: false }));
    const stellarInboundRelay = vi.fn(async () => ({ status: "submitted", hash: "abc" }));
    const s = svc({}, {}, { stellarInboundStatus, stellarInboundRelay });
    const status = await s.transferStatus({ chain: "arc", tx: TX });
    expect(stellarInboundStatus).toHaveBeenCalledWith(TX, 26);
    expect(stellarInboundRelay).toHaveBeenCalledWith(TX, 26);
    expect(status).toMatchObject({ state: "delivering", deliveryTx: "abc" });
  });

  it("does not ask the relayer about a burn already minted", async () => {
    const stellarInboundRelay = vi.fn();
    const s = svc(
      {},
      {},
      {
        stellarInboundStatus: async () => ({ state: "complete", delivered: true }),
        stellarInboundRelay,
      },
    );
    expect((await s.transferStatus({ chain: "arc", tx: TX })).state).toBe("delivered");
    expect(stellarInboundRelay).not.toHaveBeenCalled();
  });

  it("keeps needs_claim with the relayer's reason when it refuses, and retries on the next poll after a failure", async () => {
    const stellarInboundRelay = vi
      .fn<(tx: string, src: number) => Promise<Record<string, unknown> | null>>()
      .mockRejectedValueOnce(new Error("relayer down"))
      .mockResolvedValueOnce({ status: "refused", reason: "The recipient has no USDC trustline." });
    const s = svc(
      {},
      {},
      {
        stellarInboundStatus: async () => ({ state: "complete", delivered: false }),
        stellarInboundRelay,
      },
    );
    const first = await s.transferStatus({ chain: "arc", tx: TX });
    expect(first).toMatchObject({ state: "needs_claim", reason: null });
    expect(first.claimUrl).toContain("src=26");
    const second = await s.transferStatus({ chain: "arc", tx: TX });
    expect(second).toMatchObject({
      state: "needs_claim",
      reason: "The recipient has no USDC trustline.",
    });
    expect(stellarInboundRelay).toHaveBeenCalledTimes(2);
  });
});

describe("Arc to Sui", () => {
  it("prices with no Circle fee and asks Circle nothing; at least the 1 USDC the relayer pays gas for", async () => {
    const circle = vi.fn();
    const s = svc({}, {}, { circle });
    const { options } = await s.quoteOptions({ from: "arc", to: "sui", amount: 10_000_000n });
    expect(options).toHaveLength(1);
    const o = options[0];
    if (!o?.ok) throw new Error("not priced");
    expect(o.priced.quote.fees.circle).toBe(0n);
    expect(o.priced.quote.fees.delivery).toBe(0n);
    expect(o.priced.quote.fees.xebra).toBeGreaterThan(0n);
    expect(o.priced.quote.minimum).toBeGreaterThan(1_000_000n);
    expect(circle).not.toHaveBeenCalled();
    const low = await s.quoteOptions({ from: "arc", to: "sui", amount: 1_000_000n });
    expect(low.options[0]?.ok).toBe(false);
  });

  it("burns straight to Circle: the Sui address as recipient, no hook, any caller, domain 8", async () => {
    const { steps } = await svc().buildTransfer({
      from: "arc",
      to: "sui",
      amount: 5_000_000n,
      sender: EVM_SENDER,
      recipient: SUI_RECIPIENT,
    });
    expect(steps.map((s) => s.id)).toEqual(["approve", "burn", "fee"]);
    const b = burnArgs(steps);
    expect(b.to).toBe(ARC.tokenMessengerAddress);
    expect(b.functionName).toBe("depositForBurn");
    expect(b.args?.[1]).toBe(8);
    expect(String(b.args?.[2]).toLowerCase()).toBe(SUI_RECIPIENT);
    expect(String(b.args?.[4])).toBe(`0x${"00".repeat(32)}`);
    expect(b.args?.[5]).toBe(0n);
    expect(b.args?.[6]).toBe(2000);
    expect(b.expiresAt).toBeNull();
  });

  it.each([
    ["an EVM address", "0x5b38da6a701c568545dcfcb03fcb875f56beddc4"],
    ["a Stellar account", STELLAR_RECIPIENT],
    ["the zero address", `0x${"0".repeat(64)}`],
    ["31 bytes", `0x${"7a".repeat(31)}`],
  ])("refuses %s as the Sui recipient before anything is built", async (_, recipient) => {
    const evmUsdc = vi.fn(async () => ({ balance: 1_000_000_000n, allowance: 0n }));
    const err = await refusal(
      svc({}, { evmUsdc }).buildTransfer({
        from: "arc",
        to: "sui",
        amount: 5_000_000n,
        sender: EVM_SENDER,
        recipient,
      }),
    );
    expect(err.code).toBe("invalid_recipient");
    expect(evmUsdc).not.toHaveBeenCalled();
  });

  // Circle's record of an Arc burn, as `/api/attestation` answers it.
  const attested = (destinationDomain: number) => async () => ({
    status: "complete",
    message: "0x01",
    attestation: "0x02",
    destinationDomain,
    sourceDomainId: 26,
  });

  it("is waiting while Circle has not attested, from Circle's own record", async () => {
    const suiMintRelay = vi.fn();
    const delivery = vi.fn(async () => ({ status: "known", state: "pending" }));
    const s = svc(
      {},
      { attestation: async () => ({ status: "pending" }) },
      { suiMintRelay, delivery },
    );
    expect((await s.transferStatus({ chain: "arc", tx: TX })).state).toBe("pending");
    expect(suiMintRelay).not.toHaveBeenCalled();
  });

  it("falls back to Circle's record when the attestation cannot be read", async () => {
    const suiMintRelay = vi.fn();
    const s = svc(
      { evmToStellar: [] },
      {
        attestation: async () => {
          throw new Error("Iris down");
        },
      },
      { suiMintRelay, delivery: async () => null },
    );
    expect((await refusal(s.transferStatus({ chain: "arc", tx: TX }))).code).toBe(
      "upstream_unavailable",
    );
    expect(suiMintRelay).not.toHaveBeenCalled();
  });

  it("hands an attested burn to the existing Sui relayer, and reads delivered without a claim link", async () => {
    const suiMintRelay = vi.fn(async () => ({ status: "delivered" }));
    const s = svc({ evmToStellar: [] }, { attestation: attested(8) }, { suiMintRelay });
    const status = await s.transferStatus({ chain: "arc", tx: TX });
    expect(suiMintRelay).toHaveBeenCalledWith(TX, 26);
    expect(status).toMatchObject({ state: "delivered", claimUrl: null });
  });

  it("leaves it to the recipient at /claim when the relayer is off or refuses", async () => {
    const off = svc({ evmToStellar: [] }, { attestation: attested(8) });
    const s1 = await off.transferStatus({ chain: "arc", tx: TX });
    expect(s1).toMatchObject({ state: "needs_claim" });
    expect(s1.claimUrl).toBe(`https://xebra.exchange/claim?tx=${TX}&src=26`);

    const refused = svc(
      { evmToStellar: [] },
      { attestation: attested(8) },
      { suiMintRelay: async () => ({ status: "refused", reason: "too small" }) },
    );
    expect(await refused.transferStatus({ chain: "arc", tx: TX })).toMatchObject({
      state: "needs_claim",
      reason: "too small",
    });
  });

  it("answers an Arc burn elsewhere from Circle's record, not as a Sui transfer", async () => {
    const suiMintRelay = vi.fn();
    const s = svc(
      { evmToStellar: [] },
      { attestation: attested(6) },
      {
        suiMintRelay,
        delivery: async () => ({ status: "known", state: "delivered", forwardTxHash: "0xf" }),
      },
    );
    expect(await s.transferStatus({ chain: "arc", tx: TX })).toMatchObject({
      state: "delivered",
      deliveryTx: "0xf",
    });
    expect(suiMintRelay).not.toHaveBeenCalled();
  });

  it("builds the Sui mint for a Sui payer at POST /v1/claims, and refuses other payers", async () => {
    const step = {
      id: "claim" as const,
      chain: "sui" as const,
      description: "mint",
      tx: { kind: "sui" as const, json: "{}" },
      expiresAt: null,
    };
    const suiMint = vi.fn(async () => ({ state: "ready" as const, step }));
    const attestation = async () => ({
      status: "complete",
      message: "0x01",
      attestation: "0x02",
      destinationDomain: 8,
      sourceDomainId: 26,
    });
    const s = svc({}, { suiMint, attestation });
    expect(await s.buildClaim({ chain: "arc", tx: TX, payer: SUI_SENDER })).toEqual({
      steps: [step],
    });
    expect(suiMint).toHaveBeenCalledWith({
      sender: SUI_SENDER,
      message: "0x01",
      attestation: "0x02",
    });
    expect((await refusal(s.buildClaim({ chain: "arc", tx: TX, payer: EVM_SENDER }))).code).toBe(
      "invalid_request",
    );

    const minted = svc({}, { suiMint: async () => ({ state: "delivered" as const }), attestation });
    expect(
      (await refusal(minted.buildClaim({ chain: "arc", tx: TX, payer: SUI_SENDER }))).code,
    ).toBe("already_delivered");
  });

  it("refuses to claim a burn Circle has not attested", async () => {
    const s = svc({}, { attestation: async () => ({ status: "pending" }) });
    expect((await refusal(s.buildClaim({ chain: "arc", tx: TX, payer: SUI_SENDER }))).code).toBe(
      "not_ready",
    );
  });
});

describe("Stellar to Sui", () => {
  const SUI_CFG = {
    forward: false,
    maxForwardFee: 0n,
    accountCreation: false,
    maxForwardFeeNewAccount: 0n,
  };
  const withSui = (forward = false) => ({
    stellarToSui: true,
    stellarRoutes: async () => ({
      destinations: [stellarDestination("solana"), stellarDestination("base")],
      domains: new Map([
        [5, cfg()],
        [6, cfg()],
        [8, { ...SUI_CFG, forward }],
      ]),
    }),
  });
  const STELLAR_TX = "e".repeat(64);

  it("is listed only with the switch on and domain 8 committed without forwarding", async () => {
    const ids = async (top: Partial<Deps>) =>
      (await svc({}, {}, top).routes()).routes
        .find((g) => g.from === "stellar")
        ?.to.map((d) => d.id);
    expect(await ids(withSui())).toContain("sui");
    expect(await ids({ ...withSui(), stellarToSui: false })).not.toContain("sui");
    expect(await ids({ stellarToSui: true })).not.toContain("sui");
    // Forwarding to Sui would be a burn nobody delivers; never offered.
    expect(await ids(withSui(true))).not.toContain("sui");
  });

  it("prices with the contract's fee and no delivery fee, asking Circle nothing", async () => {
    const circle = vi.fn();
    const s = svc({}, {}, { ...withSui(), circle });
    const { quote: q } = await s.quote({ from: "stellar", to: "sui", amount: 10_000_000n });
    // feeParams in the fakes: 0.1% with a 0.30 floor, so 0.30 on 10.
    expect(q.fees).toEqual({ xebra: 300_000n, circle: 0n, delivery: 0n, total: 300_000n });
    expect(q.recipientGets).toBe(9_700_000n);
    expect(circle).not.toHaveBeenCalled();
    const tiny = await s.quoteOptions({ from: "stellar", to: "sui", amount: 200_000n });
    expect(tiny.options[0]?.ok).toBe(false);
  });

  it("builds the wrapper request: domain 8, the Sui address as mint_recipient, max_fee 0", async () => {
    const { steps } = await svc({}, {}, withSui()).buildTransfer({
      from: "stellar",
      to: "sui",
      amount: 10_000_000n,
      sender: SENDER,
      recipient: SUI_RECIPIENT,
    });
    const step = steps[0];
    if (step?.tx.kind !== "stellar") throw new Error("not a Stellar step");
    const tx = TransactionBuilder.fromXDR(step.tx.xdr, Networks.PUBLIC) as Transaction;
    const op = tx.operations[0];
    if (op?.type !== "invokeHostFunction") throw new Error("not an invocation");
    const req = scValToNative(op.func.invokeContract().args()[0] as xdr.ScVal) as Record<
      string,
      unknown
    >;
    expect(req.destination_domain).toBe(8);
    expect(Buffer.from(req.mint_recipient as Buffer).toString("hex")).toBe(SUI_RECIPIENT.slice(2));
    expect(req.max_fee).toBe(0n);
  });

  it("refuses a non-Sui recipient", async () => {
    const err = await refusal(
      svc({}, {}, withSui()).buildTransfer({
        from: "stellar",
        to: "sui",
        amount: 10_000_000n,
        sender: SENDER,
        recipient: STELLAR_RECIPIENT,
      }),
    );
    expect(err.code).toBe("invalid_recipient");
  });

  it("hands an attested burn to the Sui relayer from a status poll, and keeps /claim when it refuses", async () => {
    const delivery = async () => ({
      status: "known",
      state: "claimable",
      destinationDomain: 8,
    });
    const suiMintRelay = vi.fn(
      async (_tx: string, _src: number): Promise<Record<string, unknown> | null> => ({
        status: "submitted",
        hash: "SuiDigest",
      }),
    );
    const s = svc({}, {}, { ...withSui(), delivery, suiMintRelay });
    expect(await s.transferStatus({ chain: "stellar", tx: STELLAR_TX })).toMatchObject({
      state: "delivering",
      deliveryTx: "SuiDigest",
    });
    expect(suiMintRelay).toHaveBeenCalledWith(STELLAR_TX, 27);

    suiMintRelay.mockResolvedValueOnce({ status: "refused", reason: "not sent through Xebra" });
    const refused = await s.transferStatus({ chain: "stellar", tx: STELLAR_TX });
    expect(refused).toMatchObject({ state: "needs_claim", reason: "not sent through Xebra" });
    expect(refused.claimUrl).toContain(`/claim?tx=${STELLAR_TX}`);
  });

  it("does not ask the Sui relayer about a Stellar burn bound elsewhere", async () => {
    const suiMintRelay = vi.fn();
    const s = svc(
      {},
      {},
      {
        ...withSui(),
        suiMintRelay,
        delivery: async () => ({ status: "known", state: "claimable", destinationDomain: 6 }),
      },
    );
    expect((await s.transferStatus({ chain: "stellar", tx: STELLAR_TX })).state).toBe(
      "needs_claim",
    );
    expect(suiMintRelay).not.toHaveBeenCalled();
  });

  it("claims a Stellar burn to Sui with a Sui payer at POST /v1/claims", async () => {
    const suiMint = vi.fn(async () => ({
      state: "ready" as const,
      step: {
        id: "claim" as const,
        chain: "sui" as const,
        description: "mint",
        tx: { kind: "sui" as const, json: "{}" },
        expiresAt: null,
      },
    }));
    const s = svc(
      {},
      {
        suiMint,
        attestation: async () => ({
          status: "complete",
          message: "0x01",
          attestation: "0x02",
          destinationDomain: 8,
          sourceDomainId: 27,
        }),
      },
      withSui(),
    );
    const { steps } = await s.buildClaim({ chain: "stellar", tx: STELLAR_TX, payer: SUI_SENDER });
    expect(steps[0]?.chain).toBe("sui");
  });
});
