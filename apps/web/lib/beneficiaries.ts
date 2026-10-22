/**
 * Recipients someone has sent to before, with a name they chose, kept in this browser.
 *
 * There is no account and no server: the list lives in `localStorage` and never leaves the device,
 * so clearing site data (or another browser) starts it empty, and the page works the same without
 * it. Every function here is pure over a list; only `readBeneficiaries` / `writeBeneficiaries`
 * touch storage, and both swallow its failures (private windows, blocked storage, a full quota).
 *
 * A saved row is a convenience, not a trust anchor. Picking one only fills the recipient field, and
 * the same address checks, unsafe-recipient list and Solana account lookup run as for a typed one.
 */
export type BeneficiaryFamily = "evm" | "solana";

export interface Beneficiary {
  id: string;
  /** What the sender calls them. Empty until named; the picker then shows the short address. */
  name: string;
  address: string;
  family: BeneficiaryFamily;
  /** Epoch ms of the last transfer to, or pick of, this recipient. Orders the list. */
  lastUsedAt: number;
}

export const STORAGE_KEY = "xebra.beneficiaries.v1";
export const MAX_BENEFICIARIES = 50;
export const MAX_NAME_LENGTH = 40;

const SHAPE: Record<BeneficiaryFamily, RegExp> = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};

/** Whether `address` is even shaped like one of this family. The form's own check is the real one. */
export const looksLikeAddress = (family: BeneficiaryFamily, address: string): boolean =>
  SHAPE[family].test(address);

/** EVM addresses are case-insensitive (the case is only a checksum); Solana's are not. */
const keyOf = (family: BeneficiaryFamily, address: string): string =>
  `${family}:${family === "evm" ? address.toLowerCase() : address}`;

export const cleanName = (name: string): string =>
  name.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);

/** `0x1234…abcd`, for a recipient with no name. */
export const shortAddress = (address: string): string =>
  address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

export const labelOf = (b: Beneficiary): string => b.name || shortAddress(b.address);

/** Newest first, for one family. */
export function forFamily(list: readonly Beneficiary[], family: BeneficiaryFamily): Beneficiary[] {
  return list.filter((b) => b.family === family).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

export function findBeneficiary(
  list: readonly Beneficiary[],
  family: BeneficiaryFamily,
  address: string,
): Beneficiary | undefined {
  const key = keyOf(family, address.trim());
  return list.find((b) => keyOf(b.family, b.address) === key);
}

/**
 * Note a recipient that was just used. A known one keeps its name and moves to the top; a new one
 * is added unnamed. An address that is not even shaped right is ignored. The oldest fall off at
 * the cap.
 */
export function remember(
  list: readonly Beneficiary[],
  input: { family: BeneficiaryFamily; address: string; now: number; name?: string },
): Beneficiary[] {
  const address = input.address.trim();
  if (!looksLikeAddress(input.family, address)) return [...list];
  const known = findBeneficiary(list, input.family, address);
  const name = input.name === undefined ? undefined : cleanName(input.name);
  if (known) {
    return list.map((b) =>
      b.id === known.id ? { ...b, lastUsedAt: input.now, ...(name ? { name } : {}) } : b,
    );
  }
  const added: Beneficiary = {
    id: `${input.now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: name ?? "",
    address,
    family: input.family,
    lastUsedAt: input.now,
  };
  return [added, ...list].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, MAX_BENEFICIARIES);
}

export function rename(list: readonly Beneficiary[], id: string, name: string): Beneficiary[] {
  const next = cleanName(name);
  return list.map((b) => (b.id === id ? { ...b, name: next } : b));
}

export function remove(list: readonly Beneficiary[], id: string): Beneficiary[] {
  return list.filter((b) => b.id !== id);
}

/** Read what storage held, keeping only rows that are whole. Anything else is dropped, not fixed. */
export function parseStored(raw: string | null): Beneficiary[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: Beneficiary[] = [];
  for (const row of data) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (r.family !== "evm" && r.family !== "solana") continue;
    if (typeof r.id !== "string" || typeof r.address !== "string") continue;
    if (!looksLikeAddress(r.family, r.address)) continue;
    const key = keyOf(r.family, r.address);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: r.id,
      name: typeof r.name === "string" ? cleanName(r.name) : "",
      address: r.address,
      family: r.family,
      lastUsedAt:
        typeof r.lastUsedAt === "number" && Number.isFinite(r.lastUsedAt) ? r.lastUsedAt : 0,
    });
  }
  return out.sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, MAX_BENEFICIARIES);
}

export function readBeneficiaries(): Beneficiary[] {
  try {
    return parseStored(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

/** Returns whether it was stored. A page that cannot store still works; it just forgets. */
export function writeBeneficiaries(list: readonly Beneficiary[]): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}
