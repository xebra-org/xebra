import { describe, expect, it } from "vitest";
import {
  type DomainForwardConfig,
  chooseMaxFee,
  unitsToStroops,
  withTableCeiling,
} from "./stellar.js";

const QUOTE = { low: 133_000, med: 158_000, high: 177_000 }; // canonical 6-decimal units
const CFG: DomainForwardConfig = {
  forward: true,
  maxForwardFee: 3_000_000n, // 0.30 USDC in stroops
  accountCreation: true,
  maxForwardFeeNewAccount: 6_000_000n, // 0.60
};
const base = { quote: QUOTE, needsAccount: false, cfg: CFG, destinationName: "Solana" };

describe("unitsToStroops", () => {
  it("scales 6-decimal canonical units to 7-decimal stroops", () => {
    expect(unitsToStroops(177_000)).toBe(1_770_000n);
    expect(unitsToStroops(1)).toBe(10n);
  });
});

describe("withTableCeiling", () => {
  it("keeps the stricter of the contract's cap and the chain table's", () => {
    // Table 0.50 USDC (500_000 units), contract 0.30: the contract's stands.
    expect(withTableCeiling(CFG, 500_000).maxForwardFee).toBe(3_000_000n);
    // Table 0.10, contract 0.30: the table's, so a generous commit cannot widen it.
    expect(withTableCeiling(CFG, 100_000).maxForwardFee).toBe(1_000_000n);
  });

  it("leaves Solana's caps, including the new-account one, to the contract", () => {
    expect(withTableCeiling(CFG, null)).toBe(CFG);
    expect(withTableCeiling(CFG, 100_000).maxForwardFeeNewAccount).toBe(6_000_000n);
  });
});

describe("chooseMaxFee", () => {
  it("signs Circle's high tier at exactly 1.0x, in stroops", () => {
    expect(chooseMaxFee(base)).toEqual({ ok: true, maxFee: 1_770_000n });
  });

  it("produces a value the contract will not need to round (multiple of ten stroops)", () => {
    const r = chooseMaxFee(base);
    expect(r.ok && r.maxFee % 10n).toBe(0n);
  });

  it("refuses a domain whose forwarding is switched off, before anyone signs", () => {
    const r = chooseMaxFee({ ...base, cfg: { ...CFG, forward: false } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/switched off/);
  });

  it("refuses a first-time recipient when account creation is off", () => {
    const r = chooseMaxFee({
      ...base,
      needsAccount: true,
      cfg: { ...CFG, accountCreation: false },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no USDC account/);
  });

  it("applies the plain cap to an ordinary transfer and the larger one to a new account", () => {
    const pricey = { ...QUOTE, high: 400_000 }; // 0.40 USDC
    expect(chooseMaxFee({ ...base, quote: pricey }).ok).toBe(false); // above 0.30
    expect(chooseMaxFee({ ...base, quote: pricey, needsAccount: true })).toEqual({
      ok: true,
      maxFee: 4_000_000n,
    });
  });

  it("allows exactly the cap and refuses one unit over", () => {
    expect(chooseMaxFee({ ...base, quote: { ...QUOTE, high: 300_000 } }).ok).toBe(true);
    expect(chooseMaxFee({ ...base, quote: { ...QUOTE, high: 300_001 } }).ok).toBe(false);
  });

  it("says what the fee and the limit are when it refuses on price", () => {
    const r = chooseMaxFee({ ...base, quote: { ...QUOTE, high: 400_000 } });
    expect(!r.ok && r.reason).toMatch(/0\.4000 USDC.*0\.3000 USDC/);
  });
});

import { forwardBoundHolds, minimumForwardedAmount, suggestedMinimum } from "./stellar.js";

const PARAMS = { feeBps: 10n, minFee: 3_000_000n }; // 0.10%, 0.30 USDC: what is deployed

describe("minimumForwardedAmount", () => {
  it("agrees with the deployed contract at the amounts checked live on mainnet", () => {
    // 1 USDC to Solana at 0.177: refused (#41). 2.5 USDC at 0.177: accepted.
    expect(forwardBoundHolds(10_000_000n, 1_770_000n, PARAMS)).toBe(false);
    expect(forwardBoundHolds(25_000_000n, 1_770_000n, PARAMS)).toBe(true);
    // 1 USDC to Arc at 0.0219: accepted.
    expect(forwardBoundHolds(10_000_000n, 219_000n, PARAMS)).toBe(true);
  });

  it("is exactly the smallest accepted amount: one stroop less fails, the amount itself holds", () => {
    for (const m of [219_000n, 1_770_000n, 3_307_690n, 3_445_310n, 4_127_120n]) {
      const min = minimumForwardedAmount(m, PARAMS);
      expect(forwardBoundHolds(min, m, PARAMS), `m=${m}`).toBe(true);
      expect(forwardBoundHolds(min - 1n, m, PARAMS), `m=${m} min-1`).toBe(false);
    }
  });

  it("gives the figures a person can act on", () => {
    // Existing Solana account: a little under 1.9 USDC. New account at today's fee: about 3.3-3.5.
    const existing = minimumForwardedAmount(1_770_000n, PARAMS);
    expect(existing).toBeGreaterThan(18_000_000n);
    expect(existing).toBeLessThan(20_000_000n);
    const created = minimumForwardedAmount(3_307_690n, PARAMS);
    expect(created).toBeGreaterThan(33_000_000n);
    expect(created).toBeLessThan(34_000_000n);
    // Arc: the contract's own floor is what binds, not the delivery fee.
    expect(minimumForwardedAmount(219_000n, PARAMS)).toBeLessThan(10_000_000n);
  });

  it("is monotonic in the fee: a dearer delivery never lowers the minimum", () => {
    let prev = 0n;
    for (let m = 100_000n; m <= 5_000_000n; m += 250_000n) {
      const min = minimumForwardedAmount(m, PARAMS);
      expect(min >= prev).toBe(true);
      prev = min;
    }
  });
});

describe("suggestedMinimum", () => {
  it("adds 5% and rounds up to the cent", () => {
    expect(suggestedMinimum(33_000_000n)).toBe(34_700_000n); // 3.30 * 1.05 = 3.465 -> 3.47
    expect(suggestedMinimum(19_000_000n) % 100_000n).toBe(0n);
    expect(suggestedMinimum(19_000_000n)).toBeGreaterThan(19_000_000n);
  });
});
