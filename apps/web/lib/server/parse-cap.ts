import { parseUsdcAmount } from "@xebra/sdk/core";

/** The variables already reported as unreadable, so each is said once per server instance. */
const reported = new Set<string>();

/**
 * A per-transfer cap read from an env value, in USDC base units.
 *
 *  - unset or empty: `null`, which means no cap;
 *  - a positive amount written the way the API writes one (`250`, `0.5`): that cap;
 *  - anything else: `0n`. A cap of zero refuses every transfer, and that is the safe reading of a
 *    limit someone set and we cannot read. `"1,000"` and `"$500"` used to mean no cap at all.
 *
 * `name` is the variable, for the one line this logs when the value cannot be read. The value is
 * printed, since seeing `"1,000"` is what tells an operator what to fix, and a cap is not a secret.
 */
export function parseCap(name: string, raw: string | undefined): bigint | null {
  const value = raw?.trim();
  if (!value) return null;
  const units = parseUsdcAmount(value);
  if (units !== null) return units;
  if (!reported.has(name)) {
    reported.add(name);
    console.error(
      `${name}=${JSON.stringify(value)} is not a positive amount of USDC, so every transfer it caps is refused until it is fixed. Write it as plain digits with at most six decimals, like 250 or 0.5, or leave it unset for no cap.`,
    );
  }
  return 0n;
}
