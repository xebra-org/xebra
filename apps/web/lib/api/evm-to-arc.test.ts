import { FINALITY } from "@xebra/cctp-evm";
import { ARC_PEERS, EVM_ARC_PEERS, EVM_CHAINS, type EnabledRoutes } from "@xebra/sdk/core";
import { decodeFunctionData, erc20Abi, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import type { Deps } from "./deps";
import { EVM_SENDER, RECIPIENT, buildDeps, deps } from "./fakes";
import { createService } from "./service";

/**
 * EVM chains into Arc (`NEXT_PUBLIC_ARC_RECEIVES_FROM`). Off in production until 2026-11-28: Arc sent
 * to every chain, the mesh joined the rest, and nothing but Stellar, Sui, Solana and Aptos reached
 * Arc. These hold the switched-on routes to the same price and speeds as every other EVM route.
 */

const FEE_EVM = "0x32e95718A4D9B60F2e4Fb1d371189ac5DD28211A";

/** Production's EVM lists as built on 2026-11-28 (what /v1/routes answered that day). */
const PRODUCTION: EnabledRoutes = {
  arcSendsTo: ARC_PEERS,
  arcReceivesFrom: [],
  evmMesh: EVM_ARC_PEERS,
};

const svc = (evmRoutes: EnabledRoutes, top: Partial<Deps> = {}) =>
  createService(
    deps({
      evmRoutes,
      feeAddresses: { evm: FEE_EVM, solana: null, sui: null, aptos: null },
      build: buildDeps(),
      ...top,
    }),
  );

const count = (groups: Array<{ to: unknown[] }>) => groups.reduce((n, g) => n + g.to.length, 0);

const BURN_ABI = parseAbi([
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);

describe("EVM chains into Arc", () => {
  it("is off while ARC_RECEIVES_FROM is empty: only Arc's own sends and the mesh", async () => {
    const { routes } = await svc(PRODUCTION).routes();
    const evm = routes.filter((g) => g.from !== "stellar");
    expect(evm.some((g) => g.from !== "arc" && g.to.some((d) => d.id === "arc"))).toBe(false);
    // Arc to its 24 peers and Solana, and each of the 24 peers to the other 23: 577, as live.
    expect(EVM_ARC_PEERS).toHaveLength(24);
    expect(count(evm)).toBe(25 + 24 * 23);
  });

  it("adds Arc to every peer's list, one route each, when switched on for all", async () => {
    const before = count((await svc(PRODUCTION).routes()).routes);
    const on = { ...PRODUCTION, arcReceivesFrom: EVM_ARC_PEERS };
    const { routes } = await svc(on).routes();
    expect(count(routes)).toBe(before + EVM_ARC_PEERS.length);
    for (const peer of EVM_ARC_PEERS) {
      const arc = routes.find((g) => g.from === peer)?.to.find((d) => d.id === "arc");
      // Fast wherever Circle runs it from the source chain, as on every other EVM route.
      expect(arc, peer).toEqual({
        id: "arc",
        name: "Arc",
        speeds: EVM_CHAINS[peer].fast ? ["standard", "fast"] : ["standard"],
      });
    }
  });

  it("prices Base to Arc with Xebra's 0.01% plus 0.01, both speeds", async () => {
    const s = svc({ ...PRODUCTION, arcReceivesFrom: ["base"] });
    const { options } = await s.quoteOptions({ from: "base", to: "arc", amount: 25_000_000n });
    expect(options.map((o) => o.speed)).toEqual(["standard", "fast"]);
    for (const o of options) {
      if (!o.ok) throw o.error;
      const q = o.priced.quote;
      // 0.01 + 0.01% of 25: never free.
      expect(q.fees.xebra).toBe(12_500n);
      expect(q.feeRule).not.toBeNull();
      expect(o.priced.flat).toMatchObject({ fee: 12_500n, address: FEE_EVM });
      expect(q.recipientGets).toBe(25_000_000n - q.fees.total);
    }
    const fast = options.find((o) => o.speed === "fast");
    if (!fast?.ok) throw new Error("no Fast option");
    expect(fast.priced.quote.fees.circle).toBeGreaterThan(0n);
  });

  it("refuses Base to Arc while it is not switched on", async () => {
    const err = await svc(PRODUCTION)
      .quote({ from: "base", to: "arc", amount: 25_000_000n })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "route_unavailable" });
  });

  it("builds Base to Arc: approve the burn, burn to domain 26 for the recipient, then the fee", async () => {
    const s = svc({ ...PRODUCTION, arcReceivesFrom: ["base"] });
    for (const speed of ["standard", "fast"] as const) {
      const { quote, steps } = await s.buildTransfer({
        from: "base",
        to: "arc",
        amount: 25_000_000n,
        sender: EVM_SENDER,
        recipient: RECIPIENT,
        speed,
      });
      expect(steps.map((st) => st.id)).toEqual(["approve", "burn", "fee"]);
      const [approve, burn, fee] = steps.map((st) => {
        if (st.tx.kind !== "evm") throw new Error("not an EVM step");
        return st.tx;
      });
      if (!approve || !burn || !fee) throw new Error("missing a step");
      // The approval covers the burn, the burn goes straight to Circle on Base.
      expect(approve.to.toLowerCase()).toBe(EVM_CHAINS.base.usdcAddress.toLowerCase());
      expect(burn.to.toLowerCase()).toBe(EVM_CHAINS.base.tokenMessengerAddress.toLowerCase());
      const call = decodeFunctionData({ abi: BURN_ABI, data: burn.data });
      const [amount, domain, mintRecipient, , caller, maxFee, finality] = call.args;
      expect(domain).toBe(EVM_CHAINS.arc.cctpDomainId);
      expect(domain).toBe(26);
      expect(mintRecipient.toLowerCase()).toBe(`0x${"0".repeat(24)}${RECIPIENT.slice(2)}`);
      expect(caller).toBe(`0x${"0".repeat(64)}`);
      expect(finality).toBe(speed === "fast" ? FINALITY.fast : FINALITY.standard);
      expect(amount).toBe(25_000_000n - 12_500n);
      expect(maxFee).toBe(quote.fees.delivery + quote.fees.circle);
      // Xebra's fee leaves the wallet on Base, to Xebra's EVM fee address.
      const transfer = decodeFunctionData({ abi: erc20Abi, data: fee.data });
      expect(fee.to.toLowerCase()).toBe(EVM_CHAINS.base.usdcAddress.toLowerCase());
      expect(transfer.functionName).toBe("transfer");
      expect(transfer.args).toEqual([FEE_EVM, 12_500n]);
    }
  });
});
