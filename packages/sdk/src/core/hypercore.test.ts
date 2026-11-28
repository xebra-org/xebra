import { describe, expect, it } from "vitest";
import { EVM_CHAINS, EVM_CHAIN_IDS } from "./chains/evm.js";
import { CHAIN_IDS, isChainId } from "./chains/ids.js";
import { FEE_TABLE, feeRuleFor } from "./fees/table.js";
import {
  HYPERCORE,
  HYPERLIQUID_DESTINATIONS,
  formatTransferId,
  hyperliquidDestinationDomain,
  hyperliquidRefusal,
  parseTransferId,
  planHyperliquidWithdrawal,
} from "./hypercore.js";

const RULE = feeRuleFor({}, FEE_TABLE);

describe("hyperliquid as a chain id", () => {
  it("is a chain the API names", () => {
    expect(isChainId("hyperliquid")).toBe(true);
    expect(CHAIN_IDS).toContain("hyperliquid");
  });
});

describe("HYPERLIQUID_DESTINATIONS", () => {
  it("is every EVM chain Circle delivers to, Arc included, plus Solana", () => {
    const expected = EVM_CHAIN_IDS.filter(
      (id) => !["hyperevm", "injective", "morph", "pharos"].includes(id),
    );
    expect([...HYPERLIQUID_DESTINATIONS].sort()).toEqual([...expected, "solana"].sort());
    expect(HYPERLIQUID_DESTINATIONS).toContain("arc");
    expect(HYPERLIQUID_DESTINATIONS).toContain("arbitrum");
  });

  it("never lists Stellar, Sui, Aptos, HyperEVM or a chain Circle does not deliver to", () => {
    for (const id of ["stellar", "sui", "aptos", "hyperevm", "injective", "morph", "pharos"]) {
      expect(HYPERLIQUID_DESTINATIONS as readonly string[]).not.toContain(id);
    }
  });

  it("maps each destination to its CCTP domain", () => {
    expect(hyperliquidDestinationDomain("solana")).toBe(5);
    expect(hyperliquidDestinationDomain("arc")).toBe(26);
    expect(hyperliquidDestinationDomain("ethereum")).toBe(0);
    for (const id of HYPERLIQUID_DESTINATIONS) {
      if (id !== "solana")
        expect(hyperliquidDestinationDomain(id)).toBe(EVM_CHAINS[id].cctpDomainId);
    }
  });
});

describe("hyperliquidRefusal", () => {
  it("refuses Stellar in plain words, says the funds would be stuck, and offers the two-step path", () => {
    const r = hyperliquidRefusal("stellar");
    expect(r).not.toBeNull();
    expect(r?.reason).toMatch(/stuck/i);
    expect(r?.reason).toMatch(/HyperEVM/);
    expect(r?.reason).not.toMatch(/destinationCaller|hook|forwarder/i);
  });

  it("refuses Sui and Aptos as not yet tested, and HyperEVM as Hyperliquid's own free transfer", () => {
    expect(hyperliquidRefusal("sui")?.reason).toMatch(/not open yet/i);
    expect(hyperliquidRefusal("aptos")?.reason).toMatch(/not open yet/i);
    expect(hyperliquidRefusal("hyperevm")?.reason).toMatch(/Hyperliquid's own/i);
  });

  it("refuses the chains Circle does not deliver to", () => {
    for (const id of ["injective", "morph", "pharos"]) {
      expect(hyperliquidRefusal(id)?.reason).toMatch(/Circle does not deliver/i);
    }
  });

  it("refuses nothing that is a destination", () => {
    for (const id of HYPERLIQUID_DESTINATIONS) expect(hyperliquidRefusal(id)).toBeNull();
  });
});

describe("planHyperliquidWithdrawal", () => {
  it("takes Xebra's fee and Circle's forward fee out of the amount", () => {
    // 100 USDC to Arbitrum: Xebra 0.01% + 0.01 = 0.02, Circle 0.20, account already active.
    const p = planHyperliquidWithdrawal({
      amount: 100_000_000n,
      rule: RULE,
      forwardFee: 200_000n,
      activationFee: 0n,
    });
    expect(p).toEqual({
      ok: true,
      xebraFee: 20_000n,
      forwardFee: 200_000n,
      activationFee: 0n,
      withdraw: 99_980_000n,
      received: 99_780_000n,
      total: 220_000n,
      minimum: expect.any(BigInt),
    });
  });

  it("takes Hyperliquid's one-time 1 USDC out too on an account's first withdrawal", () => {
    const p = planHyperliquidWithdrawal({
      amount: 10_000_000n,
      rule: RULE,
      forwardFee: 1_200_000n,
      activationFee: HYPERCORE.activationFee,
    });
    if (!p.ok) throw new Error(p.reason);
    // Xebra 0.001 + 0.01 = 0.011; the withdrawal is what is left after Xebra and the activation.
    expect(p.xebraFee).toBe(11_000n);
    expect(p.withdraw).toBe(10_000_000n - 11_000n - 1_000_000n);
    expect(p.received).toBe(p.withdraw - 1_200_000n);
    expect(p.total).toBe(11_000n + 1_200_000n + 1_000_000n);
    expect(p.received + p.total).toBe(10_000_000n);
  });

  it("refuses an amount the fees would swallow, naming the minimum", () => {
    // Fees to Arbitrum: 0.01 + 0.20 = 0.21 (plus 0.01% of the amount).
    const p = planHyperliquidWithdrawal({
      amount: 210_000n,
      rule: RULE,
      forwardFee: 200_000n,
      activationFee: 0n,
    });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.kind).toBe("minimum");
    expect(p.reason).toMatch(/at least/);
    expect(p.minimum).toBeGreaterThan(210_000n);
  });

  it("puts the minimum exactly where the recipient first gets something worth sending", () => {
    const args = { rule: RULE, forwardFee: 500_000n, activationFee: HYPERCORE.activationFee };
    const first = planHyperliquidWithdrawal({ amount: 2_000_000n, ...args });
    const minimum = first.minimum;
    const at = planHyperliquidWithdrawal({ amount: minimum, ...args });
    const below = planHyperliquidWithdrawal({ amount: minimum - 1n, ...args });
    expect(at.ok).toBe(true);
    expect(below.ok).toBe(false);
    if (at.ok) expect(at.received).toBeGreaterThanOrEqual(HYPERCORE.minReceived);
  });

  it("refuses zero and negative amounts", () => {
    for (const amount of [0n, -1n]) {
      const p = planHyperliquidWithdrawal({
        amount,
        rule: RULE,
        forwardFee: 0n,
        activationFee: 0n,
      });
      expect(p.ok).toBe(false);
    }
  });
});

describe("transfer ids", () => {
  const SENDER = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";

  it("names a withdrawal by its signer and nonce, lower-cased", () => {
    expect(formatTransferId(SENDER, 1795870421000)).toBe(
      "0xabcdef0123456789abcdef0123456789abcdef01:1795870421000",
    );
  });

  it("reads one back, and refuses anything else", () => {
    expect(parseTransferId(`${SENDER}:1795870421000`)).toEqual({
      user: SENDER.toLowerCase(),
      nonce: 1795870421000,
    });
    for (const bad of [
      "",
      SENDER,
      `${SENDER}:`,
      `${SENDER}:12a`,
      `${SENDER}:-1`,
      "0x123:1795870421000",
      `${SENDER}:99999999999999999999`,
    ]) {
      expect(parseTransferId(bad)).toBeNull();
    }
  });
});
