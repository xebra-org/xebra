import type { ModuleInterface } from "@creit.tech/stellar-wallets-kit";
import { describe, expect, it, vi } from "vitest";
import { patient } from "./wallet-wake";

/** A wallet module whose extension is asleep for the first `asleepFor` connection checks. */
function sleepyModule(asleepFor: number) {
  let checks = 0;
  const signed: string[] = [];
  const mod = {
    productId: "freighter",
    async isAvailable() {
      checks += 1;
      return checks > asleepFor;
    },
    async signTransaction(xdr: string) {
      if (!(await mod.isAvailable())) {
        // What the kit's module throws, after its `parseError`.
        throw { code: -1, message: "Freighter is not connected" };
      }
      signed.push(xdr);
      return { signedTxXdr: `signed:${xdr}` };
    },
  };
  return { mod: mod as unknown as ModuleInterface, signed, checks: () => checks };
}

describe("patient", () => {
  it("waits for a sleeping extension and then signs, once", async () => {
    const { mod, signed } = sleepyModule(2);
    const out = await patient(mod, { pauseMs: 1 }).signTransaction("AAAA", {});
    expect(out.signedTxXdr).toBe("signed:AAAA");
    expect(signed).toEqual(["AAAA"]);
  });

  it("still says not connected when the extension never answers", async () => {
    const { mod, signed } = sleepyModule(Number.POSITIVE_INFINITY);
    await expect(
      patient(mod, { attempts: 3, pauseMs: 1 }).signTransaction("AAAA", {}),
    ).rejects.toMatchObject({ message: "Freighter is not connected" });
    expect(signed).toEqual([]);
  });

  it("passes a refusal in the wallet straight through, without asking again", async () => {
    const decline = { code: -4, message: "User declined access" };
    const signTransaction = vi.fn().mockRejectedValue(decline);
    const mod = {
      productId: "freighter",
      isAvailable: vi.fn().mockResolvedValue(true),
      signTransaction,
    } as unknown as ModuleInterface;
    await expect(patient(mod, { pauseMs: 1 }).signTransaction("AAAA", {})).rejects.toBe(decline);
    expect(signTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not touch a call the module does not have", () => {
    const mod = {
      productId: "lobstr",
      isAvailable: async () => true,
    } as unknown as ModuleInterface;
    expect(() => patient(mod)).not.toThrow();
    expect((mod as unknown as Record<string, unknown>).signAuthEntry).toBeUndefined();
  });
});
