import { FORWARD_HOOK, ZERO_BYTES32 } from "@xebra/cctp-evm";
import { APTOS_BURN_SCRIPT, APTOS_CCTP, type TransferStep } from "@xebra/sdk/build";
import { EVM_CHAINS, stellarDestination } from "@xebra/sdk/core";
import { decodeFunctionData, parseAbi } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { AptosBuildAnswer } from "../aptos/build";
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
  buildDeps,
  deps,
} from "./fakes";
import { createService } from "./service";

const FEES = {
  evm: "0x32e95718A4D9B60F2e4Fb1d371189ac5DD28211A",
  solana: "2GiJjxVmqSSTL2yfUbVnBBDkTeXEn1DM8QM2ZrRGumte",
  sui: `0x${"fe".repeat(32)}`,
  aptos: `0x${"fa".repeat(32)}`,
};
const SOLANA_SENDER = "4UXmtLwyV5tRyzuCFtQccrHkepyVDnL29GLsg5LwFN82";
const APTOS_SENDER = `0x${"74".repeat(32)}`;
const ERC20 = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
  "function transfer(address to, uint256 value) returns (bool)",
]);

const BUILT: AptosBuildAnswer = {
  status: 200,
  body: {
    transaction: {
      kind: "aptos",
      chainId: 1,
      bytecode: APTOS_BURN_SCRIPT,
      arguments: {
        amount: "9900000",
        destinationDomain: 27,
        mintRecipient: ZERO_BYTES32,
        destinationCaller: ZERO_BYTES32,
        burnToken: APTOS_CCTP.usdc,
        maxFee: "0",
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
    maxFee: "0",
    received: "9900000",
  },
};

function svc(over: Partial<BuildDeps> = {}, top: Partial<Deps> = {}) {
  return createService(
    deps({
      build: buildDeps({ aptosBuild: async () => BUILT, ...over }),
      suiStellar: { enabled: true, maxUnits: null },
      evmRoutes: { arcSendsTo: ["base", "solana"], arcReceivesFrom: [] },
      solanaSource: { evm: ["base"], stellar: true, maxUnits: null },
      aptos: { destinations: ["stellar", "base"], maxUnits: null },
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

function evmCall(step: TransferStep | undefined) {
  if (step?.tx.kind !== "evm") throw new Error("not an EVM step");
  return { to: step.tx.to, ...decodeFunctionData({ abi: ERC20, data: step.tx.data }) };
}

describe("Xebra's flat fee", () => {
  it("EVM, straight to Circle: 0.01 plus 0.01% out of the amount, the burn is the rest, the fee its own step", async () => {
    const { quote, steps } = await svc().buildTransfer({
      from: "arc",
      to: "base",
      amount: 25_000_000n,
      sender: EVM_SENDER,
      recipient: RECIPIENT,
    });
    // 0.01 + 0.01% of 25.
    expect(quote.fees.xebra).toBe(12_500n);
    expect(quote.recipientGets).toBe(25_000_000n - 12_500n - quote.fees.delivery);
    expect(steps.map((s) => s.id)).toEqual(["approve", "burn", "fee"]);
    // The approval covers the burn only; the fee is a plain transfer from the wallet.
    expect(evmCall(steps[0]).args?.[1]).toBe(24_987_500n);
    const fee = evmCall(steps[2]);
    expect(fee.to).toBe(EVM_CHAINS.arc.usdcAddress);
    expect(fee.functionName).toBe("transfer");
    expect(fee.args).toEqual([FEES.evm, 12_500n]);
  });

  it("EVM, through Xebra's wrapper: the wrapper's own fee and no flat fee", async () => {
    const { steps } = await svc(
      { evmWrapperOn: true },
      {
        evmWrapperAddress: () => "0x11b3e7df5d3a9d9a6c3a4f1d9dd5cc3d0b2bf4c3",
        evmWrapperSettings: async () =>
          ({
            paused: false,
            feeBps: 5,
            minFee: 100_000n,
            minTransfer: 1_000_000n,
            maxTransfer: 100_000_000n,
            maxFastFeeBps: 5,
            domains: new Map([
              [
                6,
                { maxForwardFee: 2_500_000n, accountCreation: false, maxForwardFeeNewAccount: 0n },
              ],
            ]),
          }) as never,
      },
    ).buildTransfer({
      from: "arc",
      to: "base",
      amount: 25_000_000n,
      sender: EVM_SENDER,
      recipient: RECIPIENT,
    });
    expect(steps.map((s) => s.id)).toEqual(["approve", "burn"]);
    // It really went through the wrapper: the approval names it, for the whole amount.
    const [spender, value] = evmCall(steps[0]).args ?? [];
    expect(String(spender).toLowerCase()).toBe("0x11b3e7df5d3a9d9a6c3a4f1d9dd5cc3d0b2bf4c3");
    expect(value).toBe(25_000_000n);
  });

  it("Solana to Stellar: 0.01 plus 0.01%, minimum about 1.0102, burned and paid in one transaction", async () => {
    const solanaBurn = vi.fn(async () => ({ ...SUI_STEP, chain: "solana" as const }));
    const s = svc({ solanaBurn });
    const options = await s.quoteOptions({ from: "solana", to: "stellar", amount: 1_010_100n });
    expect(options.options[0]).toMatchObject({ ok: false });
    const { quote } = await s.buildTransfer({
      from: "solana",
      to: "stellar",
      amount: 5_000_000n,
      sender: SOLANA_SENDER,
      recipient: STELLAR_RECIPIENT,
    });
    expect(quote.fees).toEqual({ xebra: 10_500n, circle: 0n, delivery: 0n, total: 10_500n });
    expect(quote.minimum).toBe(1_010_101n);
    expect(quote.recipientGets).toBe(4_989_500n);
    expect(solanaBurn).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 4_989_500n,
        fee: { owner: FEES.solana, amount: 10_500n },
      }),
    );
  });

  it("Sui to Stellar: the fee rides in the burn's own transaction", async () => {
    const suiBurn = vi.fn(async () => SUI_STEP);
    await svc({ suiBurn }).buildTransfer({
      from: "sui",
      to: "stellar",
      amount: 5_000_000n,
      sender: SUI_SENDER,
      recipient: STELLAR_RECIPIENT,
    });
    expect(suiBurn).toHaveBeenCalledWith({
      sender: SUI_SENDER,
      amount: 4_989_500n,
      stellarRecipient: STELLAR_RECIPIENT,
      fee: { address: FEES.sui, amount: 10_500n },
    });
  });

  it("Aptos to Stellar: burns the rest, then a fee transaction to Xebra's address", async () => {
    const aptosBuild = vi.fn(async () => BUILT);
    const { steps } = await svc({ aptosBuild }).buildTransfer({
      from: "aptos",
      to: "stellar",
      amount: 10_000_000n,
      sender: APTOS_SENDER,
      recipient: STELLAR_RECIPIENT,
    });
    expect(aptosBuild).toHaveBeenCalledWith(expect.objectContaining({ amount: "9.989" }));
    expect(steps.map((s) => s.id)).toEqual(["burn", "fee"]);
    expect(steps[1]?.tx).toMatchObject({
      kind: "aptos_call",
      functionArguments: [APTOS_CCTP.usdc, FEES.aptos, "11000"],
    });
  });

  it("Stellar, through its contract: no flat fee", async () => {
    const { steps, quote } = await svc().buildTransfer({
      from: "stellar",
      to: "base",
      amount: 10_000_000n,
      sender: SENDER,
      recipient: RECIPIENT,
    });
    expect(steps.map((s) => s.id)).toEqual(["burn"]);
    expect(quote.fees.xebra).toBeGreaterThan(0n);
    expect(stellarDestination("base").domain).toBe(6);
  });

  it("Base to Solana, once switched on: listed, priced with 0.01 plus 0.01%, burned to the token account", async () => {
    const s = svc(
      {},
      { evmRoutes: { arcSendsTo: [], arcReceivesFrom: [], evmToSolana: ["base"] } },
    );
    const { routes } = await s.routes();
    const base = routes.find((g) => g.from === "base");
    expect(base?.to.map((d) => d.id)).toEqual(["solana"]);
    const { quote, steps } = await s.buildTransfer({
      from: "base",
      to: "solana",
      amount: 25_000_000n,
      sender: EVM_SENDER,
      recipient: SOLANA_WALLET,
    });
    expect(quote.fees.xebra).toBe(12_500n);
    expect(steps.map((x) => x.id)).toEqual(["approve", "burn", "fee"]);
    expect(evmCall(steps[2]).args).toEqual([FEES.evm, 12_500n]);
  });

  it("refuses a source whose fee address is not set, rather than serving it free", async () => {
    const s = svc({}, { feeAddresses: { ...FEES, solana: null } });
    const err = await refusal(
      s.quoteOptions({ from: "solana", to: "stellar", amount: 5_000_000n }),
    );
    expect(err.code).toBe("route_unavailable");
    expect(err.message).toMatch(/fee address/);
  });
});
