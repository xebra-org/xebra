import {
  Account,
  Networks,
  type Transaction,
  TransactionBuilder,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";
import { FINALITY, encodeDepositForBurnWithHook } from "@xebra/cctp-evm";
import { InsufficientUsdcError, type TransferStep } from "@xebra/sdk/build";
import {
  EVM_CHAINS,
  bytesToHex,
  solanaAddressToBytes32,
  stellarDestination,
} from "@xebra/sdk/core";
import { describe, expect, it, vi } from "vitest";
import type { BuildDeps, Deps } from "./deps";
import { ApiError } from "./errors";
import {
  EVM_SENDER,
  RECIPIENT,
  SENDER,
  SOLANA_WALLET,
  STELLAR_RECIPIENT,
  SUI_SENDER,
  SUI_STEP,
  TOKEN_ACCOUNT,
  WRAPPER,
  WRAPPER_SETTINGS,
  buildDeps,
  cfg,
  deps,
  health,
} from "./fakes";
import { createService } from "./service";

function svc(over: Partial<BuildDeps> = {}, top: Partial<Deps> = {}) {
  return createService(
    deps({
      build: buildDeps(over),
      suiStellar: { enabled: true, maxUnits: null },
      evmRoutes: { arcSendsTo: ["base", "solana"], arcReceivesFrom: [] },
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

function bridgeRequest(step: TransferStep | undefined): Record<string, unknown> {
  if (step?.tx.kind !== "stellar") throw new Error("not a Stellar step");
  const tx = TransactionBuilder.fromXDR(step.tx.xdr, Networks.PUBLIC) as Transaction;
  const op = tx.operations[0];
  if (op?.type !== "invokeHostFunction") throw new Error("not an invocation");
  return scValToNative(op.func.invokeContract().args()[0] as xdr.ScVal) as Record<string, unknown>;
}

const toStellar = { from: "stellar", amount: 10_000_000n, sender: SENDER } as const;

describe("buildTransfer: recipients", () => {
  it("refuses an address of the wrong family before reading anything", async () => {
    const circle = vi.fn(async () => health());
    const solanaRecipient = vi.fn(async () => ({
      tokenAccount: TOKEN_ACCOUNT,
      status: "exists" as const,
    }));
    const s = svc({ solanaRecipient }, { circle });
    const cases = [
      { ...toStellar, to: "base", recipient: SOLANA_WALLET },
      { ...toStellar, to: "solana", recipient: RECIPIENT },
      { from: "sui", to: "stellar", amount: 1_000_000n, sender: SUI_SENDER, recipient: WRAPPER },
    ] as const;
    for (const c of cases) {
      expect((await refusal(s.buildTransfer(c))).code).toBe("invalid_recipient");
    }
    expect(circle).not.toHaveBeenCalled();
    expect(solanaRecipient).not.toHaveBeenCalled();
  });

  it("refuses a Stellar recipient with no USDC trustline", async () => {
    const s = svc({
      stellarAccount: async () => ({ exists: true, hasTrustline: false, balance: 0n }),
    });
    const err = await refusal(
      s.buildTransfer({
        from: "sui",
        to: "stellar",
        amount: 1_000_000n,
        sender: SUI_SENDER,
        recipient: STELLAR_RECIPIENT,
      }),
    );
    expect(err).toMatchObject({ code: "invalid_recipient" });
    expect(err.detail).toContain("trustline");
  });

  it("ends a borrowed address-check message with one full stop", async () => {
    const err = await refusal(
      svc().buildTransfer({ ...toStellar, to: "base", recipient: SOLANA_WALLET }),
    );
    expect(err.detail).not.toMatch(/\.\.$/);
    expect(err.detail).toMatch(/\.$/);
  });

  it("refuses a sender that is not an address on the source chain", async () => {
    const err = await refusal(
      svc().buildTransfer({ ...toStellar, sender: EVM_SENDER, to: "base", recipient: RECIPIENT }),
    );
    expect(err.code).toBe("invalid_request");
  });

  it("will not price a Solana transfer when it cannot tell whether the account exists", async () => {
    const s = svc({
      solanaRecipient: async () => ({ tokenAccount: TOKEN_ACCOUNT, status: "unknown" }),
    });
    const err = await refusal(
      s.buildTransfer({ ...toStellar, to: "solana", recipient: SOLANA_WALLET }),
    );
    expect(err.code).toBe("upstream_unavailable");
  });
});

describe("buildTransfer: the sender's balance", () => {
  it("names what a short Stellar sender holds and needs", async () => {
    const s = svc({
      stellarAccount: async () => ({ exists: true, hasTrustline: true, balance: 50_000_000n }),
    });
    const err = await refusal(s.buildTransfer({ ...toStellar, to: "base", recipient: RECIPIENT }));
    expect(err).toMatchObject({
      code: "insufficient_balance",
      extra: { have: 5_000_000n, need: 10_000_000n },
    });
  });

  it("says the sender's account does not exist, rather than that it holds nothing", async () => {
    const s = svc({
      stellarAccount: async () => ({ exists: false, hasTrustline: false, balance: 0n }),
    });
    const err = await refusal(s.buildTransfer({ ...toStellar, to: "base", recipient: RECIPIENT }));
    expect(err.code).toBe("insufficient_balance");
    expect(err.detail).toContain("does not exist");
  });

  it("says so when the Stellar sender has no trustline", async () => {
    const s = svc({
      stellarAccount: async () => ({ exists: true, hasTrustline: false, balance: 0n }),
    });
    const err = await refusal(s.buildTransfer({ ...toStellar, to: "base", recipient: RECIPIENT }));
    expect(err.detail).toContain("trustline");
  });

  it("is short on an EVM chain", async () => {
    const s = svc({ evmUsdc: async () => ({ balance: 1_000_000n, allowance: 0n }) });
    const err = await refusal(
      s.buildTransfer({
        from: "arc",
        to: "base",
        amount: 25_000_000n,
        sender: EVM_SENDER,
        recipient: RECIPIENT,
      }),
    );
    expect(err).toMatchObject({ code: "insufficient_balance", extra: { have: 1_000_000n } });
  });

  it("keeps Arc's gas reserve", async () => {
    const s = svc({ evmUsdc: async () => ({ balance: 25_000_000n, allowance: 0n }) });
    const err = await refusal(
      s.buildTransfer({
        from: "arc",
        to: "base",
        amount: 25_000_000n,
        sender: EVM_SENDER,
        recipient: RECIPIENT,
      }),
    );
    expect(err.code).toBe("insufficient_balance");
    expect(err.detail).toContain("gas");
  });

  it("is short on Sui", async () => {
    const s = svc({
      suiBurn: async () => {
        throw new InsufficientUsdcError(1n, 1_000_000n);
      },
    });
    const err = await refusal(
      s.buildTransfer({
        from: "sui",
        to: "stellar",
        amount: 1_000_000n,
        sender: SUI_SENDER,
        recipient: STELLAR_RECIPIENT,
      }),
    );
    expect(err).toMatchObject({
      code: "insufficient_balance",
      extra: { have: 1n, need: 1_000_000n },
    });
  });
});

describe("buildTransfer: what gets signed", () => {
  it("pins the quoted fee in a Stellar transfer to an EVM chain", async () => {
    const { quote, steps } = await svc().buildTransfer({
      ...toStellar,
      to: "base",
      recipient: RECIPIENT,
    });
    const req = bridgeRequest(steps[0]);
    expect(req.destination_domain).toBe(stellarDestination("base").domain);
    expect(Buffer.from(req.mint_recipient as Buffer).toString("hex")).toBe(
      `${"00".repeat(12)}${RECIPIENT.slice(2)}`,
    );
    expect(req.recipient_needs_account).toBe(false);
    // max_wrapper_fee is the whole fee the quote showed, in stroops.
    expect(req.max_wrapper_fee as bigint).toBeGreaterThanOrEqual(quote.fees.total * 10n - 9n);
    expect(req.max_wrapper_fee as bigint).toBeLessThanOrEqual(quote.fees.total * 10n);
  });

  it("prices and builds account creation for a Solana wallet with no USDC account", async () => {
    const circle = vi.fn(async () => health());
    const s = svc(
      { solanaRecipient: async () => ({ tokenAccount: TOKEN_ACCOUNT, status: "missing" }) },
      {
        circle,
        stellarRoutes: async () => ({
          destinations: [stellarDestination("solana")],
          domains: new Map([
            [5, { ...cfg(), accountCreation: true, maxForwardFeeNewAccount: 4_500_000n }],
          ]),
        }),
      },
    );
    const { steps } = await s.buildTransfer({
      ...toStellar,
      to: "solana",
      recipient: SOLANA_WALLET,
    });
    expect(circle).toHaveBeenCalledWith(27, 5, true);
    const req = bridgeRequest(steps[0]);
    expect(req.recipient_needs_account).toBe(true);
    expect(Buffer.from(req.recipient_owner as Buffer).equals(Buffer.alloc(32))).toBe(false);
  });

  it("approves then burns from an EVM chain, straight to Circle", async () => {
    const { steps } = await svc().buildTransfer({
      from: "arc",
      to: "base",
      amount: 25_000_000n,
      sender: EVM_SENDER,
      recipient: RECIPIENT,
    });
    expect(steps.map((x) => x.id)).toEqual(["approve", "burn"]);
    expect(steps[1]?.tx).toMatchObject({ kind: "evm", to: EVM_CHAINS.arc.tokenMessengerAddress });
  });

  it("refuses when fees came out above the caller's limit", async () => {
    const err = await refusal(
      svc().buildTransfer({ ...toStellar, to: "base", recipient: RECIPIENT, maxTotalFee: 1n }),
    );
    expect(err.code).toBe("fee_above_limit");
  });

  it("explains a transfer the contract would reject instead of building it", async () => {
    const s = svc({
      stellarRpc: () => ({
        getAccount: async (id) => new Account(id, "100"),
        getLatestLedger: async () => ({ sequence: 1 }),
        prepareTransaction: async () => {
          throw new Error("HostError: Error(Contract, #19)");
        },
      }),
    });
    const err = await refusal(s.buildTransfer({ ...toStellar, to: "base", recipient: RECIPIENT }));
    expect(err.code).toBe("transaction_rejected");
  });

  it("builds EVM sends through the fee wrapper when the chain has one, priced by its terms", async () => {
    const ARC_WRAPPER = "0x11b30470DAE40B2Fc27b7AA90dc58e6B4fE9f4c3";
    const evmUsdc = vi.fn(async () => ({ balance: 1_000_000_000n, allowance: 0n }));
    const s = svc(
      { evmWrapperOn: true, evmUsdc },
      {
        evmWrapperAddress: (chain) => (chain.id === "arc" ? ARC_WRAPPER : null),
        evmWrapperSettings: async () => WRAPPER_SETTINGS,
      },
    );
    const { quote, steps } = await s.buildTransfer({
      from: "arc",
      to: "base",
      amount: 25_000_000n,
      sender: EVM_SENDER,
      recipient: RECIPIENT,
    });
    // 0.05% of 25 is below the 0.10 floor, so Xebra's fee is the floor less Circle's delivery.
    expect(quote.fees.xebra + quote.fees.circle + quote.fees.delivery).toBe(100_000n);
    expect(quote.fees.xebra).toBeGreaterThan(0n);
    expect(quote.recipientGets).toBe(25_000_000n - 100_000n);
    expect(quote.maximum).toBe(100_000_000n);
    // The approval and the burn both go to the wrapper, and the allowance is read against it.
    expect(evmUsdc).toHaveBeenCalledWith(EVM_CHAINS.arc, EVM_SENDER, ARC_WRAPPER);
    expect(steps.map((x) => x.id)).toEqual(["approve", "burn"]);
    const burn = steps[1]?.tx;
    if (burn?.kind !== "evm") throw new Error("not an EVM step");
    expect(burn.to.toLowerCase()).toBe(ARC_WRAPPER.toLowerCase());
  });

  it("refuses to price a wrapper send when the wrapper cannot be read", async () => {
    const s = svc(
      { evmWrapperOn: true },
      {
        evmWrapperAddress: () => "0x11b30470DAE40B2Fc27b7AA90dc58e6B4fE9f4c3",
        evmWrapperSettings: async () => null,
      },
    );
    const err = await refusal(s.quote({ from: "arc", to: "base", amount: 25_000_000n }));
    expect(err.code).toBe("upstream_unavailable");
  });

  it("sends straight to Circle from a chain with no wrapper, even with the wrapper switched on", async () => {
    const s = svc(
      { evmWrapperOn: true },
      {
        evmRoutes: { arcSendsTo: [], arcReceivesFrom: [], evmMesh: ["unichain", "base"] },
        evmWrapperAddress: () => null,
      },
    );
    const { quote, steps } = await s.buildTransfer({
      from: "unichain",
      to: "base",
      amount: 25_000_000n,
      sender: EVM_SENDER,
      recipient: RECIPIENT,
    });
    expect(quote.fees.xebra).toBe(0n);
    const burn = steps.at(-1)?.tx;
    if (burn?.kind !== "evm") throw new Error("not an EVM step");
    expect(burn.to.toLowerCase()).toBe(EVM_CHAINS.unichain.tokenMessengerAddress.toLowerCase());
  });

  it("hands back the Sui burn as built", async () => {
    const { steps, quote } = await svc().buildTransfer({
      from: "sui",
      to: "stellar",
      amount: 1_000_000n,
      sender: SUI_SENDER,
      recipient: STELLAR_RECIPIENT,
    });
    expect(steps).toEqual([SUI_STEP]);
    expect(quote.recipientGets).toBe(1_000_000n);
  });
});

describe("buildTransfer: the exact figures signed", () => {
  it("puts the quoted amount and Circle's fee into the Stellar request, in stroops", async () => {
    const { quote, steps } = await svc().buildTransfer({
      ...toStellar,
      to: "base",
      recipient: RECIPIENT,
    });
    const req = bridgeRequest(steps[0]);
    expect(req.amount).toBe(10_000_000n * 10n);
    expect(req.max_fee).toBe(quote.fees.delivery * 10n);
    // Xebra's share is shown rounded up to whole 6-decimal units, never down.
    const xebraStroops = (req.max_wrapper_fee as bigint) - (req.max_fee as bigint);
    expect((xebraStroops + 9n) / 10n).toBe(quote.fees.xebra);
  });

  const toSolana = (status: "exists" | "missing") =>
    svc(
      { solanaRecipient: async () => ({ tokenAccount: TOKEN_ACCOUNT, status }) },
      {
        stellarRoutes: async () => ({
          destinations: [stellarDestination("solana")],
          domains: new Map([
            [5, { ...cfg(), accountCreation: true, maxForwardFeeNewAccount: 4_500_000n }],
          ]),
        }),
      },
    );

  it("mints to the token account, never the wallet, when the account exists", async () => {
    const { steps } = await toSolana("exists").buildTransfer({
      ...toStellar,
      to: "solana",
      recipient: SOLANA_WALLET,
    });
    const req = bridgeRequest(steps[0]);
    expect(
      Buffer.from(req.mint_recipient as Buffer).equals(
        Buffer.from(solanaAddressToBytes32(TOKEN_ACCOUNT)),
      ),
    ).toBe(true);
    expect(req.recipient_needs_account).toBe(false);
    expect(Buffer.from(req.recipient_owner as Buffer).equals(Buffer.alloc(32))).toBe(true);
  });

  it("names the wallet as owner, and still mints to the token account, when Circle opens it", async () => {
    const { steps } = await toSolana("missing").buildTransfer({
      ...toStellar,
      to: "solana",
      recipient: SOLANA_WALLET,
    });
    const req = bridgeRequest(steps[0]);
    expect(
      Buffer.from(req.mint_recipient as Buffer).equals(
        Buffer.from(solanaAddressToBytes32(TOKEN_ACCOUNT)),
      ),
    ).toBe(true);
    expect(
      Buffer.from(req.recipient_owner as Buffer).equals(
        Buffer.from(solanaAddressToBytes32(SOLANA_WALLET)),
      ),
    ).toBe(true);
  });

  for (const status of ["exists", "missing"] as const) {
    it(`encodes an EVM burn to Solana with the token account (${status})`, async () => {
      const { quote, steps } = await svc({
        solanaRecipient: async () => ({ tokenAccount: TOKEN_ACCOUNT, status }),
        evmUsdc: async () => ({ balance: 1_000_000_000n, allowance: 1_000_000_000n }),
      }).buildTransfer({
        from: "arc",
        to: "solana",
        amount: 25_000_000n,
        sender: EVM_SENDER,
        recipient: SOLANA_WALLET,
      });
      const burn = steps.find((x) => x.id === "burn");
      if (burn?.tx.kind !== "evm") throw new Error("no EVM burn");
      expect(burn.tx.data).toBe(
        encodeDepositForBurnWithHook({
          amount: 25_000_000n,
          destinationDomain: 5,
          recipient: {
            kind: "solana",
            tokenAccount: bytesToHex(solanaAddressToBytes32(TOKEN_ACCOUNT)),
            createAccountFor:
              status === "missing" ? bytesToHex(solanaAddressToBytes32(SOLANA_WALLET)) : undefined,
          },
          burnToken: EVM_CHAINS.arc.usdcAddress,
          // What Circle may keep is the quote's delivery plus its transfer fee.
          maxFee: quote.fees.delivery + quote.fees.circle,
          minFinalityThreshold: FINALITY.standard,
        }),
      );
    });
  }

  it("dates an EVM burn by its quote, since Circle's fee is fixed into it", async () => {
    const { quote, steps } = await svc().buildTransfer({
      from: "arc",
      to: "base",
      amount: 25_000_000n,
      sender: EVM_SENDER,
      recipient: RECIPIENT,
    });
    expect(steps.find((x) => x.id === "burn")?.expiresAt).toBe(quote.expiresAt);
  });
});

describe("buildTransfer: an upstream that cannot be reached", () => {
  it("is a 503 to try again, not a rejection, when Stellar's RPC fails", async () => {
    const err = await refusal(
      svc({
        stellarRpc: () => ({
          getAccount: async () => {
            throw new Error("fetch failed");
          },
          getLatestLedger: async () => ({ sequence: 1 }),
          prepareTransaction: async (tx) => tx,
        }),
      }).buildTransfer({ ...toStellar, to: "base", recipient: RECIPIENT }),
    );
    expect(err).toMatchObject({ code: "upstream_unavailable", status: 503 });
  });

  it("is a 503 when an account read fails", async () => {
    const err = await refusal(
      svc({
        stellarAccount: async () => {
          throw new Error("socket hang up");
        },
      }).buildTransfer({ ...toStellar, to: "base", recipient: RECIPIENT }),
    );
    expect(err.code).toBe("upstream_unavailable");
    expect(err.detail).not.toContain("socket");
  });

  it("builds nothing while the contract's destinations cannot be read, as the page does", async () => {
    const err = await refusal(
      svc(
        {},
        {
          stellarRoutes: async () => ({
            destinations: [stellarDestination("base")],
            domains: null,
          }),
        },
      ).buildTransfer({ ...toStellar, to: "base", recipient: RECIPIENT }),
    );
    expect(err.code).toBe("upstream_unavailable");
  });
});

describe("buildTransfer: Sui to an EVM chain or Solana", () => {
  const sui = (sendsTo: ReadonlyArray<"base" | "monad" | "solana">) => ({
    suiStellar: { enabled: true, maxUnits: null, sendsTo },
  });

  it("lists every Sui destination the switches name, Standard only", async () => {
    const { routes } = await svc({}, sui(["monad", "base", "solana"])).routes();
    expect(routes.find((g) => g.from === "sui")?.to).toEqual([
      { id: "stellar", name: "Stellar", speeds: ["standard"] },
      { id: "monad", name: "Monad", speeds: ["standard"] },
      { id: "base", name: "Base", speeds: ["standard"] },
      { id: "solana", name: "Solana", speeds: ["standard"] },
    ]);
  });

  it("refuses a destination the switches do not name", async () => {
    const err = await refusal(
      svc({}, sui(["monad"])).quote({ from: "sui", to: "solana", amount: 5_000_000n }),
    );
    expect(err.code).toBe("route_unavailable");
  });

  it("prices Sui to an EVM chain from Circle's quote for domain 8, and builds the forwarded burn", async () => {
    const circle = vi.fn(async () => health({}, 54_785));
    const suiForwardBurn = vi.fn(async () => SUI_STEP);
    const { quote, steps } = await svc(
      { suiForwardBurn },
      { ...sui(["base"]), circle },
    ).buildTransfer({
      from: "sui",
      to: "base",
      amount: 5_000_000n,
      sender: SUI_SENDER,
      recipient: RECIPIENT,
    });
    expect(circle).toHaveBeenCalledWith(8, 6);
    expect(quote.fees).toEqual({ xebra: 0n, circle: 0n, delivery: 54_785n, total: 54_785n });
    expect(quote.recipientGets).toBe(5_000_000n - 54_785n);
    expect(suiForwardBurn).toHaveBeenCalledWith({
      sender: SUI_SENDER,
      amount: 5_000_000n,
      recipient: RECIPIENT,
      destinationDomain: 6,
      maxFee: 54_785n,
      destinationName: "Base",
    });
    expect(steps[0]?.expiresAt).toBe(quote.expiresAt);
  });

  it("mints to Solana into the token account, and has Circle open it when it is missing", async () => {
    const circle = vi.fn(async () => health({}, 249_659));
    const suiForwardBurn = vi.fn(async () => SUI_STEP);
    await svc(
      {
        suiForwardBurn,
        solanaRecipient: async () => ({ tokenAccount: TOKEN_ACCOUNT, status: "missing" }),
      },
      { ...sui(["solana"]), circle },
    ).buildTransfer({
      from: "sui",
      to: "solana",
      amount: 5_000_000n,
      sender: SUI_SENDER,
      recipient: SOLANA_WALLET,
    });
    // The account-opening quote, under Solana's own ceiling for it.
    expect(circle).toHaveBeenCalledWith(8, 5, true);
    expect(suiForwardBurn).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationDomain: 5,
        maxFee: 249_659n,
        recipient: {
          kind: "solana",
          tokenAccount: bytesToHex(solanaAddressToBytes32(TOKEN_ACCOUNT)),
          createAccountFor: bytesToHex(solanaAddressToBytes32(SOLANA_WALLET)),
        },
      }),
    );
  });

  it("asks for no account when the Solana recipient already has one", async () => {
    const suiForwardBurn = vi.fn(async () => SUI_STEP);
    await svc({ suiForwardBurn }, sui(["solana"])).buildTransfer({
      from: "sui",
      to: "solana",
      amount: 5_000_000n,
      sender: SUI_SENDER,
      recipient: SOLANA_WALLET,
    });
    expect(suiForwardBurn).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: {
          kind: "solana",
          tokenAccount: bytesToHex(solanaAddressToBytes32(TOKEN_ACCOUNT)),
          createAccountFor: undefined,
        },
      }),
    );
  });

  it("keeps the Sui page's cap on every destination", async () => {
    const err = await refusal(
      svc({}, { suiStellar: { enabled: true, maxUnits: 1_000_000n, sendsTo: ["base"] } }).quote({
        from: "sui",
        to: "base",
        amount: 2_000_000n,
      }),
    );
    expect(err.code).toBe("amount_above_maximum");
  });

  it("refuses a Solana delivery fee above Solana's ceiling", async () => {
    const err = await refusal(
      svc({}, { ...sui(["solana"]), circle: async () => health({}, 600_000) }).buildTransfer({
        from: "sui",
        to: "solana",
        amount: 50_000_000n,
        sender: SUI_SENDER,
        recipient: SOLANA_WALLET,
      }),
    );
    expect(err.code).toBe("upstream_unavailable");
  });

  it("says how much the Sui address holds when it is short", async () => {
    const err = await refusal(
      svc(
        {
          suiForwardBurn: async () => {
            throw new InsufficientUsdcError(1_000_000n, 5_000_000n);
          },
        },
        sui(["base"]),
      ).buildTransfer({
        from: "sui",
        to: "base",
        amount: 5_000_000n,
        sender: SUI_SENDER,
        recipient: RECIPIENT,
      }),
    );
    expect(err.code).toBe("insufficient_balance");
  });
});
