import { type DestinationId, isEvmChainId } from "@xebra/sdk/core";

/**
 * The Stellar transfer this browser is following, kept so a refresh or a closed tab does not lose
 * it. Without this the burn hash lived only in the page's memory, and the one way back to a transfer
 * (above all to Sui, which nobody delivers and which ends at `/claim`) was digging the hash out of a
 * wallet's history.
 *
 * Saved the moment the wallet hands back the hash, before Stellar confirms it: a burn that lands
 * while the tab is closing must not be lost. Cleared when Stellar refuses it, when Circle reports it
 * delivered, or when the person starts over. Only public facts are kept: the hash, the chain, the
 * address it goes to, and the transaction's time bound.
 */

export const STELLAR_TRANSFER_KEY = "xebra.stellar.transfer";

/**
 * Older records are dropped instead of re-checked. A restored transfer is first looked up on Horizon,
 * and a Horizon that has pruned an old transaction answers 404, which after the time bound reads as
 * "not sent": the one wrong thing this must never say about a burn that went through.
 */
export const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

const TX_HASH = /^[0-9a-fA-F]{64}$/;
/** The longest address any destination takes is Sui's: 0x and 64 hex. */
const MAX_RECIPIENT_LENGTH = 128;

export interface RememberedStellarTransfer {
  tx: string;
  to: DestinationId;
  /** The address the person typed, to show again. */
  recipient: string;
  /** When it was signed, ms since epoch. */
  at: number;
  /** The signed transaction's upper time bound, ms since epoch, when it has one. */
  deadlineMs?: number;
  /**
   * Sui with "pay the Sui network fee for me": the page asks Xebra's relayer, and asking is what
   * makes it finish the transfer. Kept so a transfer that comes back after a refresh asks it again.
   */
  relayed?: boolean;
}

function isDestinationId(v: unknown): v is DestinationId {
  return typeof v === "string" && (v === "solana" || v === "sui" || isEvmChainId(v));
}

/** A stored record, checked field by field. Anything else is treated as nothing stored. */
export function parseStellarTransfer(
  raw: string | null,
  nowMs: number,
): RememberedStellarTransfer | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.tx !== "string" || !TX_HASH.test(r.tx)) return null;
  if (!isDestinationId(r.to)) return null;
  if (typeof r.recipient !== "string" || r.recipient.length > MAX_RECIPIENT_LENGTH) return null;
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
  if (nowMs - r.at > MAX_AGE_MS) return null;
  const out: RememberedStellarTransfer = {
    tx: r.tx.toLowerCase(),
    to: r.to,
    recipient: r.recipient,
    at: r.at,
  };
  if (typeof r.deadlineMs === "number" && Number.isFinite(r.deadlineMs)) {
    out.deadlineMs = r.deadlineMs;
  }
  if (r.relayed === true) out.relayed = true;
  return out;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Saves the transfer, or forgets it with `null`. False when the browser would not store it (private
 * mode, blocked storage): the transfer still works, it just cannot be picked up again here.
 */
export function rememberStellarTransfer(
  t: RememberedStellarTransfer | null,
  storage: Storage | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    if (t) storage.setItem(STELLAR_TRANSFER_KEY, JSON.stringify(t));
    else storage.removeItem(STELLAR_TRANSFER_KEY);
    return true;
  } catch {
    return false;
  }
}

/** The Stellar transfer this browser was following, if any. */
export function recallStellarTransfer(
  storage: Storage | null = browserStorage(),
  nowMs: number = Date.now(),
): RememberedStellarTransfer | null {
  if (!storage) return null;
  try {
    return parseStellarTransfer(storage.getItem(STELLAR_TRANSFER_KEY), nowMs);
  } catch {
    return null;
  }
}
