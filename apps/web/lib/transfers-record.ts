/**
 * The public record of Xebra's transfers: `transfers.json`, written hourly from the chains by
 * `scripts/transfers-record.mjs` (the `transfers record` workflow) to the `proof-data` branch.
 * Every row names a transaction anyone can open on an explorer.
 */

export const TRANSFERS_RECORD_URL =
  process.env.TRANSFERS_RECORD_URL ??
  "https://raw.githubusercontent.com/xebra-org/xebra/proof-data/transfers.json";

/**
 * How a row proves Xebra made it: Xebra's contract recorded it, Xebra's fee was paid in the burn
 * itself or beside it, Xebra's relayer signed the mint, or (`listed`) an early transfer from before
 * any of those existed, checked against Circle's record with its burn and mint linked.
 */
export type Proof = "contract" | "fee-in-burn" | "fee-payment" | "relayed" | "listed";

export interface RecordedTransfer {
  id: string;
  /** The chain the USDC left: "stellar", "arc", "solana", "sui", or an EVM chain id. */
  source: string;
  /** The destination chain, when the chain says it. */
  to: string | null;
  proof: Proof;
  /** Whether the transaction carries Xebra's tag (memo on Solana, ERC-8021 code on EVM). */
  tagged?: boolean;
  sourceTx: string;
  sourceTxUrl: string;
  /** The mint on the destination chain, when the record has it. */
  deliveryTx?: string;
  deliveryTxUrl?: string;
  at: string;
  /** USDC sent, when the chain says it (EVM fee payments do not). */
  amount: number | null;
  xebraFee: number | null;
}

export interface Totals {
  transfers: number;
  usdcSent: number;
  xebraFees: number;
  /** Chains a listed transfer left or reached. */
  chains: number;
  /** Distinct from-to pairs among transfers whose destination is known. */
  routes: number;
}

export interface TransfersRecord {
  updatedAt: string;
  /** Sources whose record starts later than their first transfer, with the date it starts (older files). */
  coverage: Record<string, string>;
  /** Per chain, how many transfers Xebra's contracts counted and how many of them are listed. */
  contracts: Record<string, { counted: number; listed: number }>;
  totals: Totals;
  transfers: RecordedTransfer[];
}

export type RecordResult =
  | { ok: true; record: TransfersRecord }
  | { ok: false; reason: "unavailable" | "malformed" };

const PROOFS: readonly Proof[] = ["contract", "fee-in-burn", "fee-payment", "relayed", "listed"];
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * Keeps only rows the page can show truthfully: a known proof, a transaction and an https explorer
 * link. Anything else in the file is dropped rather than rendered.
 */
export function parseRecord(raw: unknown): TransfersRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.transfers) || typeof r.updatedAt !== "string") return null;
  const transfers: RecordedTransfer[] = [];
  for (const item of r.transfers) {
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    const id = str(t.id);
    const source = str(t.source);
    const sourceTx = str(t.sourceTx);
    const sourceTxUrl = str(t.sourceTxUrl);
    const at = str(t.at);
    const proof = PROOFS.find((p) => p === t.proof);
    if (!id || !source || !sourceTx || !sourceTxUrl || !at || !proof) continue;
    if (!sourceTxUrl.startsWith("https://") || Number.isNaN(Date.parse(at))) continue;
    const deliveryTx = str(t.deliveryTx);
    const deliveryTxUrl = str(t.deliveryTxUrl);
    transfers.push({
      id,
      source,
      to: str(t.to),
      proof,
      ...(typeof t.tagged === "boolean" ? { tagged: t.tagged } : {}),
      sourceTx,
      sourceTxUrl,
      // A mint link is shown only when it is a real https link.
      ...(deliveryTx && deliveryTxUrl?.startsWith("https://") ? { deliveryTx, deliveryTxUrl } : {}),
      at,
      amount: num(t.amount),
      xebraFee: num(t.xebraFee),
    });
  }
  transfers.sort((a, b) => b.at.localeCompare(a.at));
  const sum = (f: (t: RecordedTransfer) => number | null) =>
    Math.round(transfers.reduce((s, t) => s + (f(t) ?? 0), 0) * 1e6) / 1e6;
  const coverage: Record<string, string> = {};
  if (r.coverage && typeof r.coverage === "object") {
    for (const [k, v] of Object.entries(r.coverage as Record<string, unknown>)) {
      if (typeof v === "string" && !Number.isNaN(Date.parse(v))) coverage[k] = v;
    }
  }
  const contracts: TransfersRecord["contracts"] = {};
  if (r.contracts && typeof r.contracts === "object") {
    for (const [k, v] of Object.entries(r.contracts as Record<string, unknown>)) {
      const c = v as Record<string, unknown> | null;
      const counted = num(c?.counted);
      if (counted === null) continue;
      // Listed is counted again from the rows shown, not taken from the file.
      const listed = transfers.filter((t) => t.proof === "contract" && t.source === k).length;
      contracts[k] = { counted, listed };
    }
  }
  const chains = new Set(transfers.flatMap((t) => [t.source, t.to]).filter(Boolean));
  const routes = new Set(transfers.filter((t) => t.to).map((t) => `${t.source}>${t.to}`));
  return {
    updatedAt: r.updatedAt,
    coverage,
    contracts,
    totals: {
      transfers: transfers.length,
      usdcSent: sum((t) => t.amount),
      xebraFees: sum((t) => t.xebraFee),
      chains: chains.size,
      routes: routes.size,
    },
    transfers,
  };
}

/** The record, read again every ten minutes; never throws. */
export async function loadTransfersRecord(
  fetcher: typeof fetch = fetch,
  url = TRANSFERS_RECORD_URL,
): Promise<RecordResult> {
  let raw: unknown;
  try {
    const res = await fetcher(url, { next: { revalidate: 600 } } as RequestInit);
    if (!res.ok) return { ok: false, reason: "unavailable" };
    raw = await res.json();
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  const record = parseRecord(raw);
  return record ? { ok: true, record } : { ok: false, reason: "malformed" };
}
