import { describe, expect, expectTypeOf, it } from "vitest";
import type { TransferStep, UnsignedTx } from "./index.js";

/**
 * The public surface: both types must be nameable from the package root, not only from the
 * `/build` subpath. These assertions are type-level; `tsc --noEmit` (typecheck) is what fails
 * when either export is removed from `src/index.ts`.
 */
describe("package root type exports", () => {
  it("names TransferStep and UnsignedTx as the root defines them", () => {
    expectTypeOf<TransferStep["id"]>().toEqualTypeOf<
      "approve" | "burn" | "open_account" | "claim"
    >();
    expectTypeOf<TransferStep["expiresAt"]>().toEqualTypeOf<string | null>();
    expectTypeOf<UnsignedTx["kind"]>().toEqualTypeOf<
      "stellar" | "evm" | "sui" | "aptos" | "solana"
    >();
    expectTypeOf<TransferStep["tx"]>().toEqualTypeOf<UnsignedTx>();

    const tx: UnsignedTx = { kind: "sui", json: "{}" };
    const step: TransferStep = {
      id: "burn",
      chain: "stellar",
      description: "Burn USDC on Stellar.",
      tx,
      expiresAt: null,
    };
    expect(step.tx).toBe(tx);
  });
});
