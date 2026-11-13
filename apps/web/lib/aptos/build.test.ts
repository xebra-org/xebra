import type { CircleHealth } from "@xebra/cctp-client";
import { FORWARD_HOOK, ZERO_BYTES32, forwardHookWithAccount } from "@xebra/cctp-evm";
import {
  APTOS_BURN_SCRIPT,
  APTOS_CCTP,
  type AptosBurnArgs,
  aptosBurnArgsFromJson,
  aptosSimulationBytes,
} from "@xebra/sdk/build";
import {
  STELLAR_CCTP_FORWARDER,
  forwarderAsSuiAddress,
  solanaAddressToBytes32,
  stellarForwardHook,
} from "@xebra/sdk/core";
import { describe, expect, it, vi } from "vitest";
import { type AptosBuildDeps, buildAptosTransfer, checkSimulatedMessage } from "./build";
import { APTOS_ALL_DESTINATIONS } from "./config";

const SENDER = "0x744bf58c5562a9ebc71ef07743e8e3385eec8e5743fde745d937ba22d37e9eb1";
const EVM = "0x1111111111111111111111111111111111111111";
const STELLAR_G = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const STELLAR_TOKEN_MESSENGER = "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL";
const SOL_OWNER = "4UXmtLwyV5tRyzuCFtQccrHkepyVDnL29GLsg5LwFN82";
const SOL_ATA = "Aj2wCH6x3jQnGzS2Je3aqcA2e5aoyNVu97kAcjsLwgjF";

/**
 * Messages Aptos mainnet emitted when these burns were simulated on 2026-11-13 (see
 * `packages/sdk/src/build/aptos.test.ts`): 1 USDC to Base for `EVM`, and 1 USDC to Stellar for
 * `STELLAR_G`. Simulation only; nothing was submitted.
 */
const SIM_BASE = `0x${Buffer.from(
  "AAAAAQAAAAkAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABS9HMrHLUs4o9ZXimXhFATJ3L4gncYLhK8Qx+qZ3vmAwAAAAAAAAAAAAAAACi1oOnGIaW62qU2IZs6IoyBaM9dAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfQAAAAAAAAAAG64gdlnbiL6gy+rW2g7QCqwS7c3aFp5ZHNQclBgLRvOwAAAAAAAAAAAAAAABERERERERERERERERERERERERERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPQkB0S/WMVWKp68ce8HdD6OM4XuyOV0P950XZN7oi036esQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOpgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGNjdHAtZm9yd2FyZAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "base64",
).toString("hex")}` as const;
const SIM_STELLAR = `0x${Buffer.from(
  "AAAAAQAAAAkAAAAbAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABS9HMrHLUs4o9ZXimXhFATJ3L4gncYLhK8Qx+qZ3vmAwmjdz/9H/Nh+DFdYprfF9Pkcw/QCmkAcVQx7UsUKt7Scr0g/y+CgYAbsFt8KReQJpMyVvq6/rE+lO/Y3bz88pEAAAfQAAAAAAAAAAG64gdlnbiL6gy+rW2g7QCqwS7c3aFp5ZHNQclBgLRvO3K9IP8vgoGAG7BbfCkXkCaTMlb6uv6xPpTv2N28/PKRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPQkB0S/WMVWKp68ce8HdD6OM4XuyOV0P950XZN7oi036esQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4R0JaWE43UElSWkdOTUhHQTdNVVVVRjRHV1BZNUFZUFY2TFk0VVYyR0w2VkpHSVFSWEZETk1BREk=",
  "base64",
).toString("hex")}` as const;

const health = (high: number, over: Partial<CircleHealth> = {}): CircleHealth =>
  ({
    status: "ok",
    reasons: [],
    checkedAt: 0,
    quote: { low: high, med: high, high },
    tiers: {
      standard: { finalityThreshold: 2000, low: high, med: high, high, minimumFeePpb: 0 },
      fast: null,
    },
    slowestMs: 1,
    budget: {},
    ...over,
  }) as unknown as CircleHealth;

function fakes(over: Partial<AptosBuildDeps> = {}) {
  const simulate = vi.fn<AptosBuildDeps["simulate"]>(async (args) => ({
    ok: true,
    gasUsed: 362n,
    message: args.destinationDomain === 27 ? SIM_STELLAR : SIM_BASE,
  }));
  const circle = vi.fn<AptosBuildDeps["circle"]>(async () => health(54_802));
  const d: AptosBuildDeps = {
    destinations: () => [...APTOS_ALL_DESTINATIONS],
    maxUnits: () => null,
    circle,
    solanaAccount: async () => ({ tokenAccount: SOL_ATA, status: "exists" }),
    stellarAccount: async () => ({ exists: true, hasTrustline: true }),
    sequenceNumber: async () => 330n,
    usdcBalance: async () => 5_000_000n,
    envelope: async (sender, seq) => ({
      sender,
      sequenceNumber: seq,
      maxGasAmount: 20_000n,
      gasUnitPrice: 100n,
      expirationTimestampSecs: 1_800_000_000n,
      chainId: 1,
    }),
    simulate,
    stellarTokenMessenger: STELLAR_TOKEN_MESSENGER,
    ...over,
  };
  return { d, simulate, circle };
}

const toBase = { sender: SENDER, amount: "1", to: "base", recipient: EVM, maxFee: "54802" };
const toStellar = { sender: SENDER, amount: "1", to: "stellar", recipient: STELLAR_G };

type Built = Extract<
  Awaited<ReturnType<typeof buildAptosTransfer>>["body"],
  { transaction: unknown }
>;
const built = (body: unknown) => body as Built;
const argsOf = (body: unknown): AptosBurnArgs =>
  aptosBurnArgsFromJson(built(body).transaction.arguments);

describe("buildAptosTransfer to an EVM chain", () => {
  it("builds Circle's script with the recipient, its hook, an open caller and Circle's quote", async () => {
    const { d, circle } = fakes();
    const r = await buildAptosTransfer(toBase, d);
    expect(r.status).toBe(200);
    const b = built(r.body);
    expect(b.transaction.kind).toBe("aptos");
    expect(b.transaction.chainId).toBe(1);
    expect(b.transaction.bytecode).toBe(APTOS_BURN_SCRIPT);
    expect(argsOf(r.body)).toEqual({
      amount: 1_000_000n,
      destinationDomain: 6,
      mintRecipient: `0x${"00".repeat(12)}${EVM.slice(2)}`,
      destinationCaller: ZERO_BYTES32,
      burnToken: APTOS_CCTP.usdc,
      maxFee: 54_802n,
      minFinalityThreshold: 2000,
      hookData: FORWARD_HOOK,
    });
    expect(b.maxFee).toBe("54802");
    expect(b.received).toBe(String(1_000_000 - 54_802));
    // Base's own ceiling is what the quote is judged against.
    expect(circle).toHaveBeenCalledWith(6, false, 500_000);
    // Gas from the simulation, with headroom.
    expect(b.envelope).toEqual({
      sequenceNumber: "330",
      maxGasAmount: "2000",
      gasUnitPrice: "100",
      expirationTimestampSecs: "1800000000",
    });
  });

  it("refuses with 409 and the new fee when Circle's price rose since it was shown", async () => {
    const { d, simulate } = fakes({ circle: async () => health(70_000) });
    const r = await buildAptosTransfer(toBase, d);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ maxFee: "70000" });
    expect(simulate).not.toHaveBeenCalled();
  });

  it("refuses while Circle is down, and when the fee would be over a tenth", async () => {
    expect(
      (
        await buildAptosTransfer(
          toBase,
          fakes({ circle: async () => health(1, { status: "down" }) }).d,
        )
      ).status,
    ).toBe(503);
    const r = await buildAptosTransfer({ ...toBase, amount: "0.3", maxFee: "999999" }, fakes().d);
    expect(r.status).toBe(422);
  });

  it("refuses a bad recipient, sender, amount, route, or a fee it was not shown", async () => {
    const { d } = fakes();
    for (const bad of [
      { ...toBase, recipient: SOL_OWNER },
      { ...toBase, recipient: "0x0000000000000000000000000000000000000000" },
      { ...toBase, sender: "0x12345g" },
      { ...toBase, sender: EVM.slice(2) },
      { ...toBase, amount: "0" },
      { ...toBase, amount: "1.0000001" },
      { ...toBase, to: "ethereum" },
      { ...toBase, to: "sui" },
      { ...toBase, maxFee: undefined },
      { ...toBase, maxFee: "-1" },
    ]) {
      const r = await buildAptosTransfer(bad, d);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    // A chain the switch does not name.
    const off = await buildAptosTransfer(toBase, fakes({ destinations: () => ["arc"] }).d);
    expect(off.status).toBe(400);
  });
});

describe("buildAptosTransfer to Solana", () => {
  const toSolana = {
    sender: SENDER,
    amount: "1",
    to: "solana",
    recipient: SOL_OWNER,
    maxFee: "500000",
  };

  it("mints into the token account the server derived, never the wallet", async () => {
    const solMessage = (args: AptosBurnArgs) =>
      // A message consistent with what was asked: the checks themselves are tested below.
      synthMessage(args);
    const { d } = fakes({
      simulate: async (args) => ({ ok: true, gasUsed: 362n, message: solMessage(args) }),
    });
    const r = await buildAptosTransfer(toSolana, d);
    expect(r.status).toBe(200);
    const a = argsOf(r.body);
    expect(a.destinationDomain).toBe(5);
    expect(a.mintRecipient).toBe(
      `0x${Buffer.from(solanaAddressToBytes32(SOL_ATA)).toString("hex")}`,
    );
    expect(a.mintRecipient).not.toBe(
      `0x${Buffer.from(solanaAddressToBytes32(SOL_OWNER)).toString("hex")}`,
    );
    expect(a.hookData).toBe(FORWARD_HOOK);
    expect(built(r.body)).toMatchObject({ tokenAccount: SOL_ATA, opensAccount: false });
  });

  it("asks Circle to open a missing account, priced at Solana's higher ceiling", async () => {
    const circle = vi.fn<AptosBuildDeps["circle"]>(async () => health(109_000));
    const { d } = fakes({
      circle,
      solanaAccount: async () => ({ tokenAccount: SOL_ATA, status: "missing" }),
      simulate: async (args) => ({ ok: true, gasUsed: 362n, message: synthMessage(args) }),
    });
    const r = await buildAptosTransfer({ ...toSolana, amount: "2" }, d);
    expect(r.status).toBe(200);
    const a = argsOf(r.body);
    const owner = `0x${Buffer.from(solanaAddressToBytes32(SOL_OWNER)).toString("hex")}` as const;
    expect(a.hookData).toBe(forwardHookWithAccount(owner));
    expect(circle).toHaveBeenCalledWith(5, true, 1_000_000);
  });

  it("refuses rather than guesses when the account cannot be read", async () => {
    const { d } = fakes({ solanaAccount: async () => ({ tokenAccount: "", status: "unknown" }) });
    expect((await buildAptosTransfer(toSolana, d)).status).toBe(503);
  });
});

describe("buildAptosTransfer to Stellar", () => {
  it("names the CctpForwarder as recipient and caller, the account in the hook, and no fee", async () => {
    const { d, circle } = fakes();
    const r = await buildAptosTransfer(toStellar, d);
    expect(r.status).toBe(200);
    const a = argsOf(r.body);
    const forwarder = forwarderAsSuiAddress(STELLAR_CCTP_FORWARDER);
    expect(a.destinationDomain).toBe(27);
    expect(a.mintRecipient).toBe(forwarder);
    expect(a.destinationCaller).toBe(forwarder);
    expect(a.hookData).toBe(`0x${Buffer.from(stellarForwardHook(STELLAR_G)).toString("hex")}`);
    expect(a.maxFee).toBe(0n);
    expect(built(r.body).received).toBe("1000000");
    // Nothing forwards into Stellar, so Circle is not asked for a delivery quote.
    expect(circle).not.toHaveBeenCalled();
  });

  it("refuses an account that cannot receive, and anything but a G... account", async () => {
    const none = fakes({ stellarAccount: async () => ({ exists: false, hasTrustline: false }) });
    expect((await buildAptosTransfer(toStellar, none.d)).status).toBe(422);
    const noLine = fakes({ stellarAccount: async () => ({ exists: true, hasTrustline: false }) });
    expect((await buildAptosTransfer(toStellar, noLine.d)).status).toBe(422);
    const contract = "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T";
    expect(
      (await buildAptosTransfer({ ...toStellar, recipient: contract }, fakes().d)).status,
    ).toBe(400);
  });
});

describe("the sender and the simulation", () => {
  it("refuses an account that does not exist, and a balance short of the amount", async () => {
    expect(
      (await buildAptosTransfer(toBase, fakes({ sequenceNumber: async () => null }).d)).status,
    ).toBe(422);
    const short = await buildAptosTransfer(toBase, fakes({ usdcBalance: async () => 999_999n }).d);
    expect(short.status).toBe(422);
    expect(short.body).toMatchObject({ error: expect.stringContaining("0.999999") });
  });

  it("refuses with the chain's reason when Aptos would abort the burn", async () => {
    const { d } = fakes({
      simulate: async () => ({
        ok: false,
        vmStatus: "Move abort in 0x1::fungible_asset: EINSUFFICIENT_BALANCE(0x10004)",
      }),
    });
    const r = await buildAptosTransfer(toBase, d);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: expect.stringContaining("enough USDC") });
  });

  it("refuses when the message the burn would emit is not the one asked for", async () => {
    // The Stellar burn's message handed back for a burn to Base.
    const { d } = fakes({
      simulate: async () => ({ ok: true, gasUsed: 1n, message: SIM_STELLAR }),
    });
    expect((await buildAptosTransfer(toBase, d)).status).toBe(500);
    const silent = fakes({ simulate: async () => ({ ok: true, gasUsed: 1n, message: null }) });
    expect((await buildAptosTransfer(toBase, silent.d)).status).toBe(502);
  });

  it("still builds when the node cannot simulate: the wallet simulates before signing", async () => {
    const { d } = fakes({
      simulate: async () => {
        throw new Error("timeout");
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await buildAptosTransfer(toBase, d);
    spy.mockRestore();
    expect(r.status).toBe(200);
    expect(built(r.body).envelope.maxGasAmount).toBe("20000");
  });

  it("enforces the cap", async () => {
    const r = await buildAptosTransfer(toBase, fakes({ maxUnits: () => 500_000n }).d);
    expect(r.status).toBe(422);
  });
});

describe("checkSimulatedMessage", () => {
  const base = argsOf({
    transaction: {
      arguments: {
        amount: "1000000",
        destinationDomain: 6,
        mintRecipient: `0x${"00".repeat(12)}${EVM.slice(2)}`,
        destinationCaller: ZERO_BYTES32,
        burnToken: APTOS_CCTP.usdc,
        maxFee: "60000",
        minFinalityThreshold: 2000,
        hookData: FORWARD_HOOK,
      },
    },
  });

  it("accepts the real simulated message for the same arguments", () => {
    expect(checkSimulatedMessage(SIM_BASE, base, "base", STELLAR_TOKEN_MESSENGER)).toBeNull();
  });

  it("names the first field that differs", () => {
    expect(checkSimulatedMessage(SIM_BASE, { ...base, amount: 2n }, "base", "")).toBe("amount");
    expect(
      checkSimulatedMessage(
        SIM_BASE,
        { ...base, mintRecipient: `0x${"22".repeat(32)}` },
        "base",
        "",
      ),
    ).toBe("mint recipient");
    expect(
      checkSimulatedMessage(
        SIM_BASE,
        { ...base, destinationCaller: `0x${"33".repeat(32)}` },
        "base",
        "",
      ),
    ).toBe("destination caller");
    expect(checkSimulatedMessage(SIM_BASE, { ...base, hookData: "0x00" }, "base", "")).toBe("hook");
    expect(checkSimulatedMessage(SIM_BASE, { ...base, destinationDomain: 3 }, "arbitrum", "")).toBe(
      "destination domain",
    );
    expect(checkSimulatedMessage("0x00", base, "base", "")).toMatch(/short/);
  });
});

/**
 * A CCTP V2 burn message for `args` from Aptos, laid out as Circle's `MessageV2`/`BurnMessageV2`.
 * Used only where no mainnet simulation was recorded (Solana here); the real messages above pin
 * the layout.
 */
function synthMessage(args: AptosBurnArgs): `0x${string}` {
  const real = Buffer.from(SIM_BASE.slice(2), "hex");
  const header = Buffer.from(real.subarray(0, 148));
  header.writeUInt32BE(args.destinationDomain, 8);
  Buffer.from(args.destinationCaller.slice(2), "hex").copy(header, 108);
  const body = Buffer.from(real.subarray(148, 148 + 228));
  Buffer.from(args.mintRecipient.slice(2), "hex").copy(body, 36);
  Buffer.from(args.amount.toString(16).padStart(64, "0"), "hex").copy(body, 68);
  const hook = Buffer.from(args.hookData.slice(2), "hex");
  return `0x${Buffer.concat([header, body, hook]).toString("hex")}`;
}

it("the simulation body carries no signature, so it cannot be submitted", () => {
  const { d } = fakes();
  void d;
  const a = aptosBurnArgsFromJson({
    amount: "1000000",
    destinationDomain: 6,
    mintRecipient: `0x${"00".repeat(12)}${EVM.slice(2)}`,
    destinationCaller: ZERO_BYTES32,
    burnToken: APTOS_CCTP.usdc,
    maxFee: "60000",
    minFinalityThreshold: 2000,
    hookData: FORWARD_HOOK,
  });
  const bytes = aptosSimulationBytes(a, {
    sender: SENDER,
    sequenceNumber: 1n,
    maxGasAmount: 1n,
    gasUnitPrice: 1n,
    expirationTimestampSecs: 1n,
    chainId: 1,
  });
  expect(Buffer.from(bytes.subarray(-2)).toString("hex")).toBe("0404");
});
