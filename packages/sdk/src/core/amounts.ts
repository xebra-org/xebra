/**
 * USDC amounts, in three families whose names differ on purpose:
 *
 * - `parseUsdc6` / `formatUsdc6`: 6-decimal units (EVM chains, Sui, Solana, CCTP messages, Circle's
 *   fee quotes), parsed from what a person typed and formatted for display ("1,250.50").
 * - `parseUsdcAmount` / `formatUsdcAmount`: the same 6-decimal units as a canonical string with no
 *   separators and no padding ("1250.5"). This is the wire format of the public API.
 * - `parseUsdc` / `formatUsdc`: Stellar stroops, 7 decimals, for the Soroban wrapper and the SAC.
 *
 * A number passed between stroops and 6-decimal units is wrong by a factor of ten in a way no type
 * would catch, so the names make the unit visible where the mistake would be made.
 */

export const UNITS_PER_USDC = 1_000_000n;

/** USDC has 6 decimals on Sui, EVM chains and in the CCTP message. Stellar's SAC uses 7. */
export const USDC_DECIMALS = 6;

/** Parses USDC typed by a human ("12.5") into 6-decimal units, rejecting more than 6 decimals. */
export function parseUsdc6(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new Error("Enter an amount in USDC, for example 25.00");
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > 6) {
    throw new Error("USDC has at most 6 decimal places here");
  }
  return BigInt(whole || "0") * UNITS_PER_USDC + BigInt(`${fraction}000000`.slice(0, 6));
}

/** Formats 6-decimal units for display. Trims trailing zeros but always keeps at least 2 decimals. */
export function formatUsdc6(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / UNITS_PER_USDC;
  const fraction = (abs % UNITS_PER_USDC).toString().padStart(6, "0").replace(/0+$/, "");
  const padded = fraction.length < 2 ? fraction.padEnd(2, "0") : fraction;
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}.${padded}`;
}

/** Parses a canonical decimal USDC amount ("1", "1.5", "0.000001") into base units, or null. */
export function parseUsdcAmount(input: string): bigint | null {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!m) return null;
  const whole = m[1] ?? "0";
  const frac = (m[2] ?? "").padEnd(USDC_DECIMALS, "0");
  const value = BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac || "0");
  return value > 0n ? value : null;
}

export function formatUsdcAmount(base: bigint): string {
  const whole = base / 10n ** BigInt(USDC_DECIMALS);
  const frac = (base % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, "0");
  const trimmed = frac.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : `${whole}`;
}

/** Stellar token amounts are 7-decimal fixed point. */
export const STROOPS_PER_USDC = 10_000_000n;

/** Parses USDC typed by a human ("12.5") into stroops, rejecting more than 7 decimals. */
export function parseUsdc(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new Error("Enter an amount in USDC, for example 25.00");
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > 7) {
    throw new Error("USDC on Stellar has at most 7 decimal places");
  }
  return BigInt(whole || "0") * STROOPS_PER_USDC + BigInt(`${fraction}0000000`.slice(0, 7));
}

/** Formats stroops for display. Trims trailing zeros but always keeps at least 2 decimals. */
export function formatUsdc(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_USDC;
  const fraction = (abs % STROOPS_PER_USDC).toString().padStart(7, "0").replace(/0+$/, "");
  const padded = fraction.length < 2 ? fraction.padEnd(2, "0") : fraction;
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}.${padded}`;
}
