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

  it("does not build EVM sends while the fee wrapper is on, rather than misprice them", async () => {
    const err = await refusal(
      svc({ evmWrapperOn: true }).buildTransfer({
        from: "arc",
        to: "base",
        amount: 25_000_000n,
        sender: EVM_SENDER,
        recipient: RECIPIENT,
      }),
    );
    expect(err.code).toBe("route_unavailable");
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
