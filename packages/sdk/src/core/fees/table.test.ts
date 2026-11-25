import { describe, expect, it } from "vitest";
import { EVM_CHAINS } from "../chains/evm.js";
import { CLAIM_ONLY_DOMAINS, XEBRA_FEE_BPS, XEBRA_FLAT_FEE, flatFeeFor } from "./flat.js";
import {
  DEFAULT_FEE_RULE_ID,
  FEE_PRODUCTS,
  FEE_TABLE,
  type FeeContext,
  type FeeRule,
  amountForBurnUnder,
  checkFeeTable,
  feeRuleFor,
  feeUnder,
  priceFee,
  withRebalancePartners,
} from "./table.js";

/** A small seeded generator, so a failure names amounts that can be run again. */
function amounts(seed: number, n: number, max: bigint): bigint[] {
  let x = seed >>> 0 || 1;
  const next = () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return BigInt(x);
  };
  const out: bigint[] = [1n, 99n, 9_999n, 10_000n, 100_000n, 1_000_000n, max];
  for (let i = 0; i < n; i++) {
    // Spread over every magnitude, not only near `max`.
    const digits = 1n + (next() % BigInt(max.toString().length));
    out.push(1n + ((next() * 4_294_967_296n + next()) % 10n ** digits));
  }
  return out;
}

/** 10 million USDC, the largest transfer the Stellar side takes; amounts are 6-decimal units. */
const MAX = 10_000_000_000_000n;
const SAMPLE = amounts(297, 400, MAX);

/** Every CCTP domain an off-contract route starts or ends on. */
const DOMAINS = [
  ...new Set([
    ...Object.values(EVM_CHAINS).map((c) => c.cctpDomainId),
    5, // Solana
    8, // Sui
    9, // Aptos
    27, // Stellar
    ...CLAIM_ONLY_DOMAINS,
  ]),
];

/** Today's price, written out independently of the table: 0.01 plus 0.01%, rounded down. */
const today = (amount: bigint) => 10_000n + amount / 10_000n;

const PARTNER = "jd7abc123keyid";
/** A key that is valid but not named as a market maker: an ordinary integrator. */
const OTHER_KEY = "jd7zzz999otherkey";
/** The table as the server builds it, with one market-maker key named. */
const SERVER_TABLE = withRebalancePartners([PARTNER]);
const CONTEXTS: FeeContext[] = FEE_PRODUCTS.flatMap((product) =>
  [null, PARTNER, OTHER_KEY].map((partner) => ({ product, partner })),
);

describe("the fee table", () => {
  it("is valid: one default, never free, rebalance only for named keys", () => {
    expect(() => checkFeeTable(FEE_TABLE)).not.toThrow();
    expect(() => checkFeeTable(SERVER_TABLE)).not.toThrow();
  });

  it("ships no market-maker price: the server names the keys", () => {
    expect(FEE_TABLE.map((r) => r.id)).toEqual([DEFAULT_FEE_RULE_ID]);
    expect(withRebalancePartners([])).toBe(FEE_TABLE);
    expect(withRebalancePartners([" ", ""])).toBe(FEE_TABLE);
    const two = withRebalancePartners([" a ", "b", "a"]);
    expect(two.find((r) => r.id === "rebalance-capped")?.partners).toEqual(["a", "b"]);
  });

  it("its default rule is today's 0.01% + 0.01 USDC, the figures `flat.ts` names", () => {
    const rule = feeRuleFor();
    expect(rule.id).toBe(DEFAULT_FEE_RULE_ID);
    expect(rule).toMatchObject({ bps: XEBRA_FEE_BPS, cap: null, min: 0n });
    expect(rule.fixed).toBe(XEBRA_FLAT_FEE.deliver);
    expect(rule.fixed).toBe(XEBRA_FLAT_FEE.claim);
  });

  it("refuses tables that would misprice", () => {
    const base: FeeRule = { id: "default", bps: 1n, fixed: 10_000n, cap: null, min: 0n };
    expect(() => checkFeeTable([])).toThrow(/default/);
    expect(() => checkFeeTable([base, { ...base, id: "again" }])).toThrow(/earlier rule/);
    expect(() => checkFeeTable([base, { ...base, to: 6 }, { ...base, to: 6 }])).toThrow(/twice/);
    expect(() => checkFeeTable([{ ...base, fixed: 0n }])).toThrow(/free/);
    expect(() => checkFeeTable([{ ...base, bps: 1_001n }])).toThrow(/10%/);
    expect(() => checkFeeTable([base, { ...base, id: "r", product: "rebalance" }])).toThrow(
      /naming the keys/,
    );
    expect(() =>
      checkFeeTable([base, { ...base, id: "r", product: "rebalance", partners: [] }]),
    ).toThrow(/naming the keys/);
  });
});

describe("priceFee", () => {
  it("reproduces today's numbers for every amount and every off-contract route", () => {
    // Collected rather than asserted one by one: tens of thousands of cases.
    const wrong: string[] = [];
    for (const to of DOMAINS) {
      for (const from of DOMAINS) {
        if (from === to) continue;
        for (const amount of SAMPLE.slice(0, 60)) {
          for (const ctx of [
            { from, to },
            { from, to, product: "transfer" as const, partner: PARTNER },
          ]) {
            const p = priceFee(amount, ctx, SERVER_TABLE);
            if (p.fee !== today(amount) || p.rule !== "default") {
              wrong.push(`${JSON.stringify(ctx)} ${amount}: ${p.fee} by ${p.rule}`);
            }
          }
        }
      }
      for (const amount of SAMPLE) {
        if (flatFeeFor(to, amount) !== today(amount)) wrong.push(`flatFeeFor(${to}, ${amount})`);
      }
      if (flatFeeFor(to) !== 10_000n) wrong.push(`flatFeeFor(${to})`);
    }
    expect(wrong).toEqual([]);
  });

  it("a rebalance without a named market-maker key is priced as the default", () => {
    for (const amount of SAMPLE) {
      for (const partner of [null, OTHER_KEY]) {
        expect(priceFee(amount, { product: "rebalance", partner }, SERVER_TABLE)).toEqual({
          fee: today(amount),
          rule: "default",
        });
      }
      expect(priceFee(amount, { product: "rebalance" }, SERVER_TABLE)).toEqual(priceFee(amount));
      // The shipped table names nobody, so even the market maker's key gets the default there.
      expect(priceFee(amount, { product: "rebalance", partner: PARTNER })).toEqual(
        priceFee(amount),
      );
    }
  });

  it("a rebalance with a named market-maker key: 0.01% capped at 2 USDC, plus 0.01", () => {
    const rebalance = { product: "rebalance" as const, partner: PARTNER, from: 6, to: 3 };
    const price = (amount: bigint) => priceFee(amount, rebalance, SERVER_TABLE);
    // 100,000 USDC Base to Arbitrum: 2.01, not 10.01.
    expect(price(100_000_000_000n)).toEqual({ fee: 2_010_000n, rule: "rebalance-capped" });
    // 1,000 USDC: 0.11, as before.
    expect(price(1_000_000_000n)).toEqual({ fee: 110_000n, rule: "rebalance-capped" });
    // The cap starts to bite at 20,000 USDC.
    expect(price(20_000_000_000n).fee).toBe(2_010_000n);
    expect(price(19_999_990_000n).fee).toBe(2_009_999n);
    expect(price(MAX).fee).toBe(2_010_000n);
    // The same key sending an ordinary transfer pays the default.
    expect(priceFee(MAX, { ...rebalance, product: "transfer" }, SERVER_TABLE).fee).toBe(today(MAX));
    // Never dearer than the default, and never free.
    for (const amount of SAMPLE) {
      const fee = price(amount).fee;
      expect(fee).toBeLessThanOrEqual(today(amount));
      expect(fee).toBeGreaterThanOrEqual(10_000n);
    }
  });

  it("never takes more than a tenth of any amount from 0.11 USDC, under every rule", () => {
    for (const ctx of CONTEXTS) {
      for (const amount of SAMPLE) {
        if (amount < 110_000n) continue;
        expect(priceFee(amount, ctx, SERVER_TABLE).fee * 10n).toBeLessThanOrEqual(amount);
      }
    }
  });

  it("every rule's cap always holds, its minimum too, and no rule is ever free", () => {
    for (const rule of SERVER_TABLE) {
      for (const amount of SAMPLE) {
        const fee = feeUnder(rule, amount);
        const ceiling = rule.fixed + (rule.cap ?? 0n);
        if (rule.cap !== null)
          expect(fee).toBeLessThanOrEqual(ceiling > rule.min ? ceiling : rule.min);
        expect(fee).toBeGreaterThanOrEqual(rule.min);
        expect(fee).toBeGreaterThan(0n);
        // Each unit sent adds at most one unit of fee, which `amountForBurnUnder` relies on.
        expect(feeUnder(rule, amount + 1n) - fee).toBeLessThanOrEqual(1n);
        expect(feeUnder(rule, amount + 1n)).toBeGreaterThanOrEqual(fee);
      }
    }
  });

  it("picks the most specific matching rule, the earlier one on a tie", () => {
    const table: FeeRule[] = [
      { id: "default", bps: 1n, fixed: 10_000n, cap: null, min: 0n },
      { id: "to-base", to: 6, bps: 2n, fixed: 10_000n, cap: null, min: 0n },
      { id: "from-arb", from: 3, bps: 3n, fixed: 10_000n, cap: null, min: 0n },
      {
        id: "two-key-rebalance",
        product: "rebalance",
        partners: [PARTNER, "other"],
        bps: 1n,
        fixed: 10_000n,
        cap: 1n,
        min: 0n,
      },
      {
        id: "one-key-rebalance-to-base",
        product: "rebalance",
        partners: [PARTNER],
        to: 6,
        bps: 1n,
        fixed: 5_000n,
        cap: 1n,
        min: 0n,
      },
    ];
    checkFeeTable(table);
    expect(feeRuleFor({}, table).id).toBe("default");
    expect(feeRuleFor({ to: 6 }, table).id).toBe("to-base");
    // Two rules of one field each: the earlier wins.
    expect(feeRuleFor({ from: 3, to: 6 }, table).id).toBe("to-base");
    expect(feeRuleFor({ product: "rebalance", partner: "other" }, table).id).toBe(
      "two-key-rebalance",
    );
    expect(feeRuleFor({ product: "rebalance", partner: "other", to: 6 }, table).id).toBe(
      "two-key-rebalance",
    );
    expect(feeRuleFor({ product: "rebalance", partner: OTHER_KEY, to: 6 }, table).id).toBe(
      "to-base",
    );
    expect(feeRuleFor({ product: "rebalance", partner: PARTNER, to: 6 }, table).id).toBe(
      "one-key-rebalance-to-base",
    );
    expect(feeRuleFor({ product: "rebalance", partner: null, to: 6 }, table).id).toBe("to-base");
    expect(() => feeRuleFor({}, table.slice(1))).toThrow(/default/);
  });
});

describe("amountForBurnUnder", () => {
  it("is the least amount that leaves at least the burn, under every rule", () => {
    for (const rule of SERVER_TABLE) {
      for (const burn of SAMPLE.slice(0, 150)) {
        const a = amountForBurnUnder(rule, burn);
        expect(a - feeUnder(rule, a)).toBeGreaterThanOrEqual(burn);
        expect(a - 1n - feeUnder(rule, a - 1n)).toBeLessThan(burn);
      }
    }
  });
});
