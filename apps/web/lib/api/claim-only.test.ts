import { tokenMessengerAbi } from "@xebra/cctp-evm";
import { decodeFunctionData } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { Deps } from "./deps";
import { EVM_SENDER, RECIPIENT, buildDeps, deps } from "./fakes";
import { createService } from "./service";

const FEES = {
  evm: "0x32e95718A4D9B60F2e4Fb1d371189ac5DD28211A",
  solana: null,
  sui: null,
  aptos: null,
};

function svc(top: Partial<Deps> = {}) {
  return createService(
    deps({
      build: buildDeps(),
      evmRoutes: { arcSendsTo: [], arcReceivesFrom: [], evmMesh: ["base", "injective", "morph"] },
      feeAddresses: FEES,
      ...top,
    }),
  );
}

describe("into a chain Circle does not deliver to (Injective, Morph, Pharos)", () => {
  it("prices Xebra's 0.01 plus 0.01% and nothing for Circle, Standard only, without asking Circle", async () => {
    const circle = vi.fn();
    const { options } = await svc({ circle }).quoteOptions({
      from: "base",
      to: "injective",
      amount: 5_000_000n,
    });
    expect(options).toHaveLength(1);
    const o = options[0];
    if (!o?.ok) throw new Error("not priced");
    expect(o.priced.quote.fees).toEqual({
      // 0.01 + 0.01% of 5.
      xebra: 10_500n,
      circle: 0n,
      delivery: 0n,
      total: 10_500n,
    });
    expect(o.priced.quote.recipientGets).toBe(4_989_500n);
    // The least amount that still burns 0.09 after the fee: fees stay within a tenth.
    expect(o.priced.quote.minimum).toBe(100_010n);
    expect(circle).not.toHaveBeenCalled();
  });

  it("burns with depositForBurn, no hook, nothing for Circle, then pays Xebra's fee", async () => {
    const { steps } = await svc().buildTransfer({
      from: "base",
      to: "injective",
      amount: 5_000_000n,
      sender: EVM_SENDER,
      recipient: RECIPIENT,
    });
    expect(steps.map((s) => s.id)).toEqual(["approve", "burn", "fee"]);
    const burn = steps[1];
    if (burn?.tx.kind !== "evm") throw new Error("not evm");
    const { functionName, args } = decodeFunctionData({
      abi: tokenMessengerAbi,
      data: burn.tx.data as never,
    });
    expect(functionName).toBe("depositForBurn");
    expect(args[0]).toBe(4_989_500n);
    expect(args[1]).toBe(29);
    expect(args[5]).toBe(0n);
    expect(burn.description).toMatch(/claims it on Injective/);
  });

  it("still lets them send out, delivered by Circle as from any chain", async () => {
    const { options } = await svc().quoteOptions({
      from: "injective",
      to: "base",
      amount: 5_000_000n,
    });
    const o = options[0];
    if (!o?.ok) throw new Error("not priced");
    expect(o.priced.quote.fees.xebra).toBe(10_500n);
    expect(o.priced.quote.fees.delivery).toBeGreaterThan(0n);
  });
});
