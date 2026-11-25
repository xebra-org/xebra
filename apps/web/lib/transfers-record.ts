/**
 * The public record of Xebra's transfers: `transfers.json`, written hourly from the chains by
 * `scripts/transfers-record.mjs` (the `transfers record` workflow) to the `proof-data` branch.
 * Every row names a transaction anyone can open on an explorer.
 */

export const TRANSFERS_RECORD_URL =
  process.env.TRANSFERS_RECORD_URL ??
  "https://raw.githubusercontent.com/xebra-org/xebra/proof-data/transfers.json";

/** How a row proves Xebra made it. */
export type Proof = "contract" | "fee-in-burn" | "fee-payment";

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
  at: string;
  /** USDC sent, when the chain says it (EVM fee payments do not). */
  amount: number | null;
  xebraFee: number | null;
}

export interface TransfersRecord {
  updatedAt: string;
  /** Sources whose record starts later than their first transfer, with the date it starts. */
  coverage: Record<string, string>;
  totals: { transfers: number; usdcSent: number; xebraFees: number };
  transfers: RecordedTransfer[];
}

export type RecordResult =
  | { ok: true; record: TransfersRecord }
  | { ok: false; reason: "unavailable" | "malformed" };

const PROOFS: readonly Proof[] = ["contract", "fee-in-burn", "fee-payment"];
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
    transfers.push({
      id,
      source,
      to: str(t.to),
      proof,
      ...(typeof t.tagged === "boolean" ? { tagged: t.tagged } : {}),
      sourceTx,
      sourceTxUrl,
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
  return {
    updatedAt: r.updatedAt,
    coverage,
    totals: {
      transfers: transfers.length,
      usdcSent: sum((t) => t.amount),
      xebraFees: sum((t) => t.xebraFee),
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
