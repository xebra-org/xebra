import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import { tokenMessengerAbi } from "@xebra/cctp-evm";
import { decodeFunctionData } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { BuildDeps, Deps } from "./deps";
import { ApiError } from "./errors";
import { EVM_SENDER, SUI_SENDER, SUI_STEP, buildDeps, deps } from "./fakes";
import { createService } from "./service";

/**
 * Muxed M... recipients into Stellar: the deposit address an exchange hands out, a G... account
 * plus a numeric id. Circle's CctpForwarder pays them (the M... text goes whole into the hook); the
 * trustline that has to exist is the underlying G... account's.
 */

const BASE_ACCOUNT = Keypair.random().publicKey();
const MUXED = new MuxedAccount(new Account(BASE_ACCOUNT, "0"), "9007199254740993").accountId();
const CONTRACT = "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL";

const FEES = {
  evm: "0x32e95718A4D9B60F2e4Fb1d371189ac5DD28211A",
  solana: null,
  sui: `0x${"fe".repeat(32)}`,
  aptos: null,
};

function svc(over: Partial<BuildDeps> = {}, top: Partial<Deps> = {}) {
  return createService(
    deps({
      build: buildDeps(over),
      evmRoutes: { arcSendsTo: [], arcReceivesFrom: [], evmToStellar: ["base"] },
      suiStellar: { enabled: true, maxUnits: null },
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

const toStellar = (recipient: string) =>
  ({
    from: "base",
    to: "stellar",
    amount: 10_000_000n,
    sender: EVM_SENDER,
    recipient,
  }) as const;

function hookRecipient(
  steps: Awaited<ReturnType<ReturnType<typeof svc>["buildTransfer"]>>["steps"],
) {
  const burn = steps.find((s) => s.id === "burn")?.tx;
  if (burn?.kind !== "evm") throw new Error("no EVM burn");
  const { args } = decodeFunctionData({ abi: tokenMessengerAbi, data: burn.data });
  const hook = Buffer.from(String(args[7]).slice(2), "hex");
  expect(hook.readUInt32BE(28)).toBe(hook.length - 32);
  return hook.subarray(32).toString("utf8");
}

describe("a muxed (M...) recipient into Stellar", () => {
  it("is accepted from an EVM chain: the hook names the M... address, the trustline check the G...", async () => {
    const stellarAccount = vi.fn(async () => ({ exists: true, hasTrustline: true, balance: 0n }));
    const { steps } = await svc({ stellarAccount }).buildTransfer(toStellar(MUXED));
    expect(hookRecipient(steps)).toBe(MUXED);
    expect(stellarAccount).toHaveBeenCalledWith(BASE_ACCOUNT);
    expect(stellarAccount).not.toHaveBeenCalledWith(MUXED);
  });

  it("says whose trustline is missing when the account behind it has none", async () => {
    const s = svc({
      stellarAccount: async () => ({ exists: true, hasTrustline: false, balance: 0n }),
    });
    const err = await refusal(s.buildTransfer(toStellar(MUXED)));
    expect(err.code).toBe("invalid_recipient");
    expect(err.detail).toContain(BASE_ACCOUNT);
    expect(err.detail).toMatch(/trustline/);
    const missing = await refusal(
      svc({
        stellarAccount: async () => ({ exists: false, hasTrustline: false, balance: 0n }),
      }).buildTransfer(toStellar(MUXED)),
    );
    expect(missing.detail).toContain(BASE_ACCOUNT);
  });

  it("is passed whole to the Sui burn, which puts it in the hook", async () => {
    const suiBurn = vi.fn<BuildDeps["suiBurn"]>(async () => SUI_STEP);
    const stellarAccount = vi.fn(async () => ({ exists: true, hasTrustline: true, balance: 0n }));
    await svc({ suiBurn, stellarAccount }).buildTransfer({
      from: "sui",
      to: "stellar",
      amount: 1_000_000n,
      sender: SUI_SENDER,
      recipient: MUXED,
    });
    expect(suiBurn.mock.calls[0]?.[0]).toMatchObject({ stellarRecipient: MUXED });
    expect(stellarAccount).toHaveBeenCalledWith(BASE_ACCOUNT);
  });

  it("is refused with a broken checksum, cut short, or in lower case, before anything is read", async () => {
    const stellarAccount = vi.fn();
    const s = svc({ stellarAccount });
    for (const bad of [
      `${MUXED.slice(0, -1)}${MUXED.endsWith("A") ? "B" : "A"}`,
      MUXED.slice(0, 60),
      MUXED.toLowerCase(),
    ]) {
      const err = await refusal(s.buildTransfer(toStellar(bad)));
      expect(err.code).toBe("invalid_recipient");
      expect(err.detail).toMatch(/G.*M/);
    }
    expect(stellarAccount).not.toHaveBeenCalled();
  });

  it("leaves G... accounts as they were, and contracts refused", async () => {
    const stellarAccount = vi.fn(async () => ({ exists: true, hasTrustline: true, balance: 0n }));
    const { steps } = await svc({ stellarAccount }).buildTransfer(toStellar(BASE_ACCOUNT));
    expect(hookRecipient(steps)).toBe(BASE_ACCOUNT);
    expect(stellarAccount).toHaveBeenCalledWith(BASE_ACCOUNT);
    expect((await refusal(svc().buildTransfer(toStellar(CONTRACT)))).code).toBe(
      "invalid_recipient",
    );
  });
});
