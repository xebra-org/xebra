import { HYPERLIQUID_DESTINATIONS } from "@xebra/sdk/core";
import { describe, expect, it, vi } from "vitest";
import type { Deps, HyperliquidDeps } from "./deps";
import { ApiError } from "./errors";
import { RECIPIENT, SOLANA_WALLET, TOKEN_ACCOUNT, buildDeps, deps } from "./fakes";
import { createService } from "./service";
import { buildToWire, quoteToWire, statusToWire } from "./wire";

const NOW = 1_795_870_421_000;
const SENDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const FEE_ADDRESS = "0x1111111111111111111111111111111111111111";
const BURN = `0x${"ab".repeat(32)}`;

function hl(over: Partial<HyperliquidDeps> = {}): HyperliquidDeps {
  return {
    feeAddress: FEE_ADDRESS,
    maxUnits: null,
    forwardFee: async (domain) => (domain === 0 ? 1_200_000n : domain === 5 ? 500_000n : 200_000n),
    account: async () => ({ perps: 500_000_000n, spot: 0n, activated: true }),
    activationFeeTo: async () => 0n,
    findBurn: async () => "not_found",
    ...over,
  };
}

function svc(h: Partial<HyperliquidDeps> | null = {}, top: Partial<Deps> = {}) {
  return createService(
    deps({
      build: buildDeps(),
      ...(h === null ? {} : { hyperliquid: hl(h) }),
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

describe("Hyperliquid routes", () => {
  it("are listed only when switched on and Xebra's fee address there is set", async () => {
    expect((await svc(null).routes()).routes.some((g) => g.from === "hyperliquid")).toBe(false);
    expect(
      (await svc({ feeAddress: null }).routes()).routes.some((g) => g.from === "hyperliquid"),
    ).toBe(false);
    const group = (await svc().routes()).routes.find((g) => g.from === "hyperliquid");
    expect(group?.name).toBe("Hyperliquid");
    expect(group?.to.map((d) => d.id).sort()).toEqual([...HYPERLIQUID_DESTINATIONS].sort());
    expect(group?.to.every((d) => d.speeds.join() === "standard")).toBe(true);
  });

  it("never list Stellar, Sui, Aptos or HyperEVM", async () => {
    const group = (await svc().routes()).routes.find((g) => g.from === "hyperliquid");
    const ids = group?.to.map((d) => d.id as string) ?? [];
    for (const id of ["stellar", "sui", "aptos", "hyperevm", "injective"]) {
      expect(ids).not.toContain(id);
    }
  });
});

describe("a Hyperliquid quote", () => {
  it("prices Xebra's fee from the table and Circle's from CoreDepositWallet", async () => {
    const forwardFee = vi.fn(async () => 200_000n);
    const { quote } = await svc({ forwardFee }).quote({
      from: "hyperliquid",
      to: "arc",
      amount: 100_000_000n,
    });
    expect(forwardFee).toHaveBeenCalledWith(26);
    expect(quote.fees).toEqual({
      xebra: 20_000n,
      circle: 0n,
      delivery: 200_000n,
      activation: 0n,
      total: 220_000n,
    });
    expect(quote.recipientGets).toBe(99_780_000n);
    expect(quote.feeRule).toBe("default");
    expect(quoteToWire(quote).fees).toEqual({
      xebra: "0.02",
      circle: "0",
      delivery: "0.2",
      activation: "0",
      total: "0.22",
    });
  });

  it("charges Ethereum's and Solana's own delivery fees", async () => {
    const s = svc();
    const eth = await s.quote({ from: "hyperliquid", to: "ethereum", amount: 10_000_000n });
    expect(eth.quote.fees.delivery).toBe(1_200_000n);
    const sol = await s.quote({ from: "hyperliquid", to: "solana", amount: 10_000_000n });
    expect(sol.quote.fees.delivery).toBe(500_000n);
  });

  it("adds Hyperliquid's 1 USDC when the sender's account has never sent anything", async () => {
    const { quote } = await svc({
      account: async () => ({ perps: 50_000_000n, spot: 0n, activated: false }),
    }).quote({ from: "hyperliquid", to: "base", amount: 10_000_000n, sender: SENDER });
    expect(quote.fees.activation).toBe(1_000_000n);
    expect(quote.recipientGets).toBe(10_000_000n - 11_000n - 1_000_000n - 200_000n);
    expect(quote.fees.total + quote.recipientGets).toBe(10_000_000n);
  });

  it("refuses an amount the fees would swallow, naming the minimum", async () => {
    const err = await refusal(
      svc().quote({ from: "hyperliquid", to: "arbitrum", amount: 200_000n }),
    );
    expect(err.code).toBe("amount_below_minimum");
    expect(err.extra.minimum).toBeGreaterThan(210_000n);
  });

  it("refuses Stellar with a plain reason that offers the two-step way, before reading anything", async () => {
    const forwardFee = vi.fn(async () => 200_000n);
    const err = await refusal(
      svc({ forwardFee }).quote({ from: "hyperliquid", to: "stellar", amount: 10_000_000n }),
    );
    expect(err.code).toBe("route_unavailable");
    expect(err.message).toMatch(/stuck for good/);
    expect(err.message).toMatch(/HyperEVM/);
    expect(forwardFee).not.toHaveBeenCalled();
  });

  it("refuses HyperEVM and the chains Circle does not deliver to, each with its reason", async () => {
    const s = svc();
    const evm = await refusal(s.quote({ from: "hyperliquid", to: "hyperevm", amount: 5_000_000n }));
    expect(evm.message).toMatch(/Hyperliquid's own transfer/);
    const inj = await refusal(
      s.quote({ from: "hyperliquid", to: "injective", amount: 5_000_000n }),
    );
    expect(inj.message).toMatch(/Circle does not deliver/);
  });

  it("is never free: refused when Xebra's fee address is not set", async () => {
    const err = await refusal(
      svc({ feeAddress: null }).quote({ from: "hyperliquid", to: "base", amount: 10_000_000n }),
    );
    expect(err.code).toBe("route_unavailable");
    expect(err.message).toMatch(/fee/);
  });

  it("says try again when Circle's contract cannot be read, or has paused withdrawals", async () => {
    const unreadable = await refusal(
      svc({ forwardFee: async () => null }).quote({
        from: "hyperliquid",
        to: "base",
        amount: 10_000_000n,
      }),
    );
    expect(unreadable.code).toBe("upstream_unavailable");
    const paused = await refusal(
      svc({ forwardFee: async () => "paused" }).quote({
        from: "hyperliquid",
        to: "base",
        amount: 10_000_000n,
      }),
    );
    expect(paused.code).toBe("upstream_unavailable");
    expect(paused.message).toMatch(/paused/);
  });

  it("keeps to the cap when one is set", async () => {
    const err = await refusal(
      svc({ maxUnits: 50_000_000n }).quote({
        from: "hyperliquid",
        to: "base",
        amount: 60_000_000n,
      }),
    );
    expect(err.code).toBe("amount_above_maximum");
  });
});

describe("building a Hyperliquid withdrawal", () => {
  const build = (s = svc(), over: Record<string, unknown> = {}) =>
    s.buildTransfer({
      from: "hyperliquid",
      to: "arc",
      amount: 10_000_000n,
      sender: SENDER,
      recipient: RECIPIENT,
      signatureChainId: 8453,
      ...over,
    });

  it("is two signatures: the withdrawal, then Xebra's fee, one nonce apart", async () => {
    const built = await build();
    expect(built.steps.map((s) => [s.id, s.chain, s.tx.kind])).toEqual([
      ["burn", "hyperliquid", "hyperliquid"],
      ["fee", "hyperliquid", "hyperliquid"],
    ]);
    const [burn, fee] = built.steps.map((s) => s.tx);
    if (burn?.kind !== "hyperliquid" || fee?.kind !== "hyperliquid") throw new Error("kind");
    expect(burn.nonce).toBe(NOW);
    expect(fee.nonce).toBe(NOW + 1);
    expect(burn.action).toMatchObject({
      type: "sendToEvmWithData",
      signatureChainId: "0x2105",
      amount: "9.989",
      sourceDex: "",
      destinationRecipient: RECIPIENT.toLowerCase(),
      destinationChainId: 26,
      data: "0x",
    });
    expect(fee.action).toMatchObject({
      type: "usdSend",
      destination: FEE_ADDRESS,
      amount: "0.011",
      time: NOW + 1,
    });
    expect(built.quote.recipientGets).toBe(9_789_000n);
    // The id the transfer is tracked by is in what the person reads.
    expect(built.steps[0]?.description).toContain(`${SENDER.toLowerCase()}:${NOW}`);
    // And it survives the wire.
    expect(buildToWire(built).steps[0]?.tx).toEqual(burn);
  });

  it("signs for Arbitrum when the caller names no chain", async () => {
    const built = await build(svc(), { signatureChainId: undefined });
    const tx = built.steps[0]?.tx;
    if (tx?.kind !== "hyperliquid") throw new Error("kind");
    expect(tx.typedData.domain.chainId).toBe(42161);
    expect(tx.action.signatureChainId).toBe("0xa4b1");
  });

  it("takes the activation fee out of the withdrawal on a first withdrawal", async () => {
    const built = await build(
      svc({ account: async () => ({ perps: 50_000_000n, spot: 0n, activated: false }) }),
    );
    const tx = built.steps[0]?.tx;
    if (tx?.kind !== "hyperliquid") throw new Error("kind");
    expect(tx.action.amount).toBe("8.989");
    expect(built.quote.fees.activation).toBe(1_000_000n);
  });

  it("withdraws from spot, fee included, when only spot holds enough", async () => {
    const built = await build(
      svc({ account: async () => ({ perps: 1_000_000n, spot: 20_000_000n, activated: true }) }),
    );
    const [burn, fee] = built.steps.map((s) => s.tx);
    if (burn?.kind !== "hyperliquid" || fee?.kind !== "hyperliquid") throw new Error("kind");
    expect(burn.action.sourceDex).toBe("spot");
    expect(fee.action.type).toBe("spotSend");
  });

  it("refuses when neither balance holds it, and says to move USDC when the two together would", async () => {
    const split = await refusal(
      build(
        svc({ account: async () => ({ perps: 6_000_000n, spot: 6_000_000n, activated: true }) }),
      ),
    );
    expect(split.code).toBe("insufficient_balance");
    expect(split.message).toMatch(/Perps/);
    expect(split.message).toMatch(/Spot/);
    const short = await refusal(
      build(svc({ account: async () => ({ perps: 1_000_000n, spot: 0n, activated: true }) })),
    );
    expect(short.code).toBe("insufficient_balance");
    expect(short.extra).toMatchObject({ have: 1_000_000n, need: 10_000_000n });
  });

  it("refuses rather than charge the sender Hyperliquid's 1 USDC for Xebra's own fee account", async () => {
    const err = await refusal(build(svc({ activationFeeTo: async () => 1_000_000n })));
    expect(err.code).toBe("route_unavailable");
  });

  it("refuses Stellar before it reads a single Stellar account", async () => {
    const stellarAccount = vi.fn(async () => ({ exists: true, hasTrustline: true, balance: 0n }));
    const s = createService(
      deps({ build: buildDeps({ stellarAccount }), hyperliquid: hl() }),
      () => NOW,
    );
    const err = await refusal(
      s.buildTransfer({
        from: "hyperliquid",
        to: "stellar",
        amount: 10_000_000n,
        sender: SENDER,
        recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      }),
    );
    expect(err.code).toBe("route_unavailable");
    expect(err.message).toMatch(/stuck for good/);
    expect(stellarAccount).not.toHaveBeenCalled();
  });

  it("sends to Solana's USDC token account in base58, with Circle's open-account hook for the owner", async () => {
    const built = await build(svc(), { to: "solana", recipient: SOLANA_WALLET });
    const tx = built.steps[0]?.tx;
    if (tx?.kind !== "hyperliquid") throw new Error("kind");
    expect(tx.action).toMatchObject({
      destinationRecipient: TOKEN_ACCOUNT,
      addressEncoding: "base58",
      destinationChainId: 5,
    });
    expect(String(tx.action.data)).toMatch(/^0x636374702d666f7277617264[0]{24}01[0-9a-f]{64}$/);
  });

  it("refuses a sender that is not an EVM address, and an EVM recipient for Solana", async () => {
    expect((await refusal(build(svc(), { sender: "not-an-address" }))).code).toBe(
      "invalid_request",
    );
    expect((await refusal(build(svc(), { to: "solana", recipient: RECIPIENT }))).code).toBe(
      "invalid_recipient",
    );
  });

  it("refuses when fees rose above what the caller showed", async () => {
    const err = await refusal(build(svc(), { maxTotalFee: 100_000n }));
    expect(err.code).toBe("fee_above_limit");
  });
});

describe("a Hyperliquid withdrawal's status", () => {
  const ID = `${SENDER.toLowerCase()}:${NOW}`;

  it("is pending until Hyperliquid hands it to Circle", async () => {
    const findBurn = vi.fn(async () => "not_found" as const);
    const s = await svc({ findBurn }).transferStatus({ chain: "hyperliquid", tx: ID });
    expect(findBurn).toHaveBeenCalledWith(SENDER.toLowerCase(), NOW);
    expect(s).toMatchObject({ state: "pending", chain: "hyperliquid", tx: ID, burnTx: null });
    expect(s.reason).toMatch(/not handed it to Circle yet/);
  });

  it("follows the HyperEVM burn through Circle once it is found", async () => {
    const delivery = vi.fn(async () => ({
      status: "known",
      state: "delivered",
      forwardTxHash: `0x${"cd".repeat(32)}`,
      reason: null,
    }));
    const s = await svc({ findBurn: async () => ({ txHash: BURN }) }, { delivery }).transferStatus({
      chain: "hyperliquid",
      tx: ID,
    });
    expect(delivery).toHaveBeenCalledWith(BURN, 19);
    expect(s).toMatchObject({
      state: "delivered",
      chain: "hyperliquid",
      tx: ID,
      burnTx: BURN,
      deliveryTx: `0x${"cd".repeat(32)}`,
    });
    expect(statusToWire(s)).toMatchObject({ chain: "hyperliquid", burnTx: BURN });
  });

  it("points a failed delivery at the claim page for the HyperEVM burn", async () => {
    const s = await svc(
      { findBurn: async () => ({ txHash: BURN }) },
      {
        delivery: async () => ({
          status: "known",
          state: "failed",
          forwardTxHash: null,
          reason: "x",
        }),
      },
    ).transferStatus({ chain: "hyperliquid", tx: ID });
    expect(s.state).toBe("failed");
    expect(s.claimUrl).toBe(`https://xebra.exchange/claim?tx=${BURN}&src=19`);
  });

  it("takes the HyperEVM burn's hash directly too", async () => {
    const findBurn = vi.fn(async () => "not_found" as const);
    const s = await svc({ findBurn }).transferStatus({ chain: "hyperliquid", tx: BURN });
    expect(findBurn).not.toHaveBeenCalled();
    expect(s).toMatchObject({ chain: "hyperliquid", tx: BURN, burnTx: BURN, state: "delivering" });
  });

  it("says try again, not failed, when HyperEVM cannot be read", async () => {
    const err = await refusal(
      svc({ findBurn: async () => null }).transferStatus({ chain: "hyperliquid", tx: ID }),
    );
    expect(err.code).toBe("upstream_unavailable");
    expect(err.message).toMatch(/does not mean/);
  });

  it("tells the person where the money is when nothing has turned up for a long while", async () => {
    const old = `${SENDER.toLowerCase()}:${NOW - 60 * 60_000}`;
    const s = await svc().transferStatus({ chain: "hyperliquid", tx: old });
    expect(s.state).toBe("pending");
    expect(s.reason).toMatch(/still in your Hyperliquid balance/);
  });

  it("refuses an id that is neither a signer:nonce nor a hash", async () => {
    expect((await refusal(svc().transferStatus({ chain: "hyperliquid", tx: "nope" }))).code).toBe(
      "invalid_request",
    );
  });
});
