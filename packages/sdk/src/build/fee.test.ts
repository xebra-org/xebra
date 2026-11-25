import { decodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { TransferStepSchema } from "../api/schemas.js";
import { EVM_CHAINS } from "../core/chains/evm.js";
import { APTOS_CCTP, buildAptosFeeStep } from "./aptos.js";
import { buildEvmFeeStep } from "./evm.js";

const FEE_ADDRESS = "0x32e95718A4D9B60F2e4Fb1d371189ac5DD28211A";

describe("fee steps", () => {
  it("EVM: a USDC transfer of exactly the fee to Xebra's address, on the source chain", () => {
    const base = EVM_CHAINS.base;
    const step = buildEvmFeeStep({ source: base, feeAddress: FEE_ADDRESS, fee: 100_000n });
    expect(step).toMatchObject({ id: "fee", chain: "base", expiresAt: null });
    expect(step.description).toContain("0.10 USDC");
    if (step.tx.kind !== "evm") throw new Error("not evm");
    expect(step.tx.to).toBe(base.usdcAddress);
    expect(step.tx.chainId).toBe(base.chainId);
    const call = decodeFunctionData({
      abi: parseAbi(["function transfer(address to, uint256 value) returns (bool)"]),
      data: step.tx.data,
    });
    expect(call.functionName).toBe("transfer");
    expect(call.args).toEqual([FEE_ADDRESS, 100_000n]);
    expect(TransferStepSchema.parse(step)).toEqual(step);
  });

  it("EVM: refuses a zero fee or a bad address", () => {
    const source = EVM_CHAINS.base;
    expect(() => buildEvmFeeStep({ source, feeAddress: FEE_ADDRESS, fee: 0n })).toThrow();
    expect(() =>
      buildEvmFeeStep({ source, feeAddress: "0x123" as `0x${string}`, fee: 1n }),
    ).toThrow();
  });

  it("Aptos: primary_fungible_store::transfer of native USDC to Xebra's address", () => {
    const to = `0x${"ab".repeat(32)}`;
    const step = buildAptosFeeStep({ feeAddress: to, fee: 50_000n });
    expect(step).toMatchObject({
      id: "fee",
      chain: "aptos",
      tx: {
        kind: "aptos_call",
        chainId: 1,
        function: "0x1::primary_fungible_store::transfer",
        typeArguments: ["0x1::fungible_asset::Metadata"],
        functionArguments: [APTOS_CCTP.usdc, to, "50000"],
      },
    });
    expect(TransferStepSchema.parse(step)).toEqual(step);
    expect(() => buildAptosFeeStep({ feeAddress: "nope", fee: 1n })).toThrow();
  });
});
