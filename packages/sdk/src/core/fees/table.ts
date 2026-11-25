/**
 * Xebra's fee table for the routes that run without a Xebra contract (EVM, Solana, Sui and Aptos
 * sources), and the one function that prices a transfer from it. The `/v1` API and the page's own
 * build routes both price through `priceFee`, on the server, so what a person is shown is what
 * they sign.
 *
 * A rule matches on the product (`transfer` or `rebalance`), the caller's API key (`partner`), and
 * the CCTP source and destination domains. A field a rule leaves out matches anything. The most
 * specific matching rule wins; the default rule, which sets nothing, is today's 0.01% + 0.01 USDC.
 *
 * The Arc and Stellar contracts take their own fee on-chain and are not priced here.
 * All amounts are 6-decimal USDC units.
 */

/** What a request is for. A rebalance is a market maker moving its own USDC between chains. */
export type FeeProduct = "transfer" | "rebalance";

export const FEE_PRODUCTS: readonly FeeProduct[] = ["transfer", "rebalance"];

export interface FeeRule {
  /** Named in the quote that this rule priced, so revenue can be read per rule. */
  id: string;
  /** Left out: any product. */
  product?: FeeProduct;
  /**
   * Left out: any caller, with or without an API key. `"any"`: any caller with a valid API key.
   * Any other value: that one key, by its id.
   */
  partner?: string;
  /** CCTP domain the burn is made on. Left out: any. */
  from?: number;
  /** CCTP domain the USDC arrives on. Left out: any. */
  to?: number;
  /** The percentage part, in basis points of the amount: 1 is 0.01%. Rounded down. */
  bps: bigint;
  /** The fixed part, added to the percentage part. */
  fixed: bigint;
  /** The most the percentage part comes to, or null for no cap. The fixed part is on top. */
  cap: bigint | null;
  /** The least the whole fee comes to. */
  min: bigint;
}

export const DEFAULT_FEE_RULE_ID = "default";
/** `partner` on a rule that any caller with a valid API key matches. */
export const ANY_PARTNER = "any";

/**
 * The table. Changes go through review, with tests (`table.test.ts`). Every rule must keep the
 * table valid (`checkFeeTable`): one default rule, never free, rebalance prices behind a key.
 */
export const FEE_TABLE: readonly FeeRule[] = [
  // Today's price for every transfer: 0.01% of the amount plus 0.01 USDC.
  { id: DEFAULT_FEE_RULE_ID, bps: 1n, fixed: 10_000n, cap: null, min: 0n },
  // A market maker rebalancing its own USDC, with its API key: 0.01% capped at 2 USDC a move, plus
  // the same 0.01. 100,000 USDC costs 2.01 instead of 10.01; 1,000 USDC costs 0.11 either way.
  {
    id: "rebalance-capped",
    product: "rebalance",
    partner: ANY_PARTNER,
    bps: 1n,
    fixed: 10_000n,
    cap: 2_000_000n,
    min: 0n,
  },
];

/** Who is asking and for what. Everything left out is an ordinary transfer from anyone. */
export interface FeeContext {
  /** Default "transfer". */
  product?: FeeProduct;
  /** The id of the caller's valid API key, or null/absent without one. */
  partner?: string | null;
  from?: number;
  to?: number;
}

export interface FeePrice {
  /** Xebra's fee, in 6-decimal units. */
  fee: bigint;
  /** The id of the rule that priced it. */
  rule: string;
}

function matches(rule: FeeRule, ctx: FeeContext): boolean {
  if (rule.product !== undefined && rule.product !== (ctx.product ?? "transfer")) return false;
  if (rule.partner !== undefined) {
    const partner = ctx.partner ?? null;
    if (partner === null) return false;
    if (rule.partner !== ANY_PARTNER && rule.partner !== partner) return false;
  }
  if (rule.from !== undefined && rule.from !== ctx.from) return false;
  if (rule.to !== undefined && rule.to !== ctx.to) return false;
  return true;
}

/** How specific a rule is: one point per field it sets, two for one named key. */
function specificity(rule: FeeRule): number {
  return (
    (rule.product !== undefined ? 1 : 0) +
    (rule.partner === undefined ? 0 : rule.partner === ANY_PARTNER ? 1 : 2) +
    (rule.from !== undefined ? 1 : 0) +
    (rule.to !== undefined ? 1 : 0)
  );
}

/** The rule that prices `ctx`: the most specific match, the earlier one on a tie. */
export function feeRuleFor(ctx: FeeContext = {}, table: readonly FeeRule[] = FEE_TABLE): FeeRule {
  let best: FeeRule | null = null;
  for (const rule of table) {
    if (!matches(rule, ctx)) continue;
    if (best === null || specificity(rule) > specificity(best)) best = rule;
  }
  if (!best) throw new Error("The fee table has no rule for this transfer: it needs a default.");
  return best;
}

/** What one rule charges on `amount`. With no amount, the fixed part (or the minimum) alone. */
export function feeUnder(rule: FeeRule, amount = 0n): bigint {
  let pct = amount > 0n ? (amount * rule.bps) / 10_000n : 0n;
  if (rule.cap !== null && pct > rule.cap) pct = rule.cap;
  const fee = rule.fixed + pct;
  return fee < rule.min ? rule.min : fee;
}

/**
 * Xebra's fee for sending `amount` (what leaves the wallet), and the rule that priced it. The
 * burn is the amount less this fee.
 */
export function priceFee(
  amount: bigint,
  ctx: FeeContext = {},
  table: readonly FeeRule[] = FEE_TABLE,
): FeePrice {
  const rule = feeRuleFor(ctx, table);
  return { fee: feeUnder(rule, amount), rule: rule.id };
}

/**
 * The least amount to send under `rule` so that at least `burn` is left once the fee is taken out
 * of it. `amount - fee` never falls as the amount rises (each unit adds at most one unit of fee),
 * so a binary search finds it.
 */
export function amountForBurnUnder(rule: FeeRule, burn: bigint): bigint {
  const left = (a: bigint) => a - feeUnder(rule, a);
  let lo = burn > 0n ? burn : 0n;
  if (left(lo) >= burn) return lo;
  // Comfortably enough: the fee is at most fixed + min + a tenth (`checkFeeTable` bounds bps).
  let hi = 2n * (lo + rule.fixed + rule.min) + 1n;
  while (left(hi) < burn) hi *= 2n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (left(mid) >= burn) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Refuses a table that would price something wrong: no default rule (one that sets no match
 * field), duplicate ids or match sets, a rule that could be free, a percentage over 10%, a negative
 * figure, or a rebalance price anyone could claim without an API key.
 */
export function checkFeeTable(table: readonly FeeRule[]): void {
  const ids = new Set<string>();
  const shapes = new Set<string>();
  let defaults = 0;
  for (const r of table) {
    if (ids.has(r.id)) throw new Error(`Fee rule ${r.id} appears twice.`);
    ids.add(r.id);
    const shape = JSON.stringify([r.product, r.partner, r.from, r.to]);
    if (shapes.has(shape)) throw new Error(`Fee rule ${r.id} matches what an earlier rule does.`);
    shapes.add(shape);
    if (specificity(r) === 0) defaults += 1;
    if (r.bps < 0n || r.fixed < 0n || r.min < 0n || (r.cap !== null && r.cap < 0n)) {
      throw new Error(`Fee rule ${r.id} has a negative figure.`);
    }
    if (r.bps > 1_000n) throw new Error(`Fee rule ${r.id} takes more than 10%.`);
    if (r.fixed <= 0n && r.min <= 0n) throw new Error(`Fee rule ${r.id} could be free.`);
    if (r.product === "rebalance" && r.partner === undefined) {
      throw new Error(`Fee rule ${r.id} prices rebalances without an API key.`);
    }
  }
  if (defaults !== 1) throw new Error("The fee table needs exactly one default rule.");
}
