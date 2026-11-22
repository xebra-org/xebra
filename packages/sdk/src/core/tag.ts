/**
 * How a transaction says Xebra built it, readable by anyone from the chain alone.
 *
 * - **EVM**: an ERC-8021 attribution suffix appended to the calldata. Contracts read their
 *   arguments by offset and never look past them, so the suffix changes nothing the call does; it
 *   costs 16 gas per byte. Layout, read from the end: `codes || codesLength (1 byte) ||
 *   schemaId (1 byte, 0) || marker (16 bytes, 0x8021 repeated)`. Schema 0 codes are 7-bit ASCII
 *   joined by commas; ERC-8021 (a draft) counts a code as valid once it is registered in a code
 *   registry, such as Base's builder codes.
 * - **Solana**: an SPL Memo with the same text, in the burn's own transaction.
 */

type Hex = `0x${string}`;

export const XEBRA_TAG = "xebra";

const MARKER = "80218021802180218021802180218021";
const SCHEMA_0 = "00";

/** The ERC-8021 schema 0 suffix for `codes`, as hex without `0x`. */
export function attributionSuffix(codes: readonly string[] = [XEBRA_TAG]): string {
  if (codes.length === 0) throw new RangeError("At least one code is needed.");
  for (const c of codes) {
    if (c === "" || /[^\x20-\x7e]/.test(c) || c.includes(",")) {
      throw new RangeError(`Not a valid attribution code: "${c}"`);
    }
  }
  const joined = codes.join(",");
  if (joined.length > 255) throw new RangeError("Attribution codes are longer than 255 bytes.");
  const ascii = Array.from(joined, (ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return `${ascii}${joined.length.toString(16).padStart(2, "0")}${SCHEMA_0}${MARKER}`;
}

/** `data` with Xebra's attribution suffix appended. */
export function withAttribution(data: Hex, codes: readonly string[] = [XEBRA_TAG]): Hex {
  return `${data}${attributionSuffix(codes)}` as Hex;
}

/** The schema 0 codes at the end of `data`, or null when it carries no ERC-8021 suffix. */
export function readAttribution(data: string): string[] | null {
  const hex = data.replace(/^0x/, "").toLowerCase();
  if (hex.length < 36 || !hex.endsWith(MARKER)) return null;
  const head = hex.slice(0, -MARKER.length);
  if (head.slice(-2) !== SCHEMA_0) return null;
  const length = Number.parseInt(head.slice(-4, -2), 16);
  const codesHex = head.slice(-4 - length * 2, -4);
  if (codesHex.length !== length * 2) return null;
  const bytes = (codesHex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16));
  // Schema 0 codes are printable 7-bit ASCII; anything else is not a suffix this reads.
  if (bytes.length === 0 || bytes.some((b) => b < 0x20 || b > 0x7e)) return null;
  return String.fromCharCode(...bytes).split(",");
}

/** Whether `data` (EVM calldata) says Xebra built it. */
export function isXebraTagged(data: string): boolean {
  return readAttribution(data)?.includes(XEBRA_TAG) ?? false;
}
