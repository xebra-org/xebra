/**
 * Turns the rows every reader found into the record's list and totals. Kept apart from the
 * readers (no network, no chain libraries) so it can be tested on its own.
 */

/** How strongly a row's proof ties it to Xebra; when two rows are one transfer, the stronger stays. */
export const STRENGTH = { contract: 5, "fee-in-burn": 4, relayed: 3, "fee-payment": 2, listed: 1 };

/**
 * One row per transfer, newest first. The same transfer can come from two places (a backfill row
 * and a live one, or a relayed mint and a listed burn): rows that share an id, a burn transaction
 * or a mint transaction are one. Each row gets `to`, the destination's name from `domains`, and an
 * ISO `at`.
 */
export function mergeRows(rows, domains) {
  const kept = new Map(); // id -> row
  const byKey = new Map(); // id, burn or mint transaction -> id of the kept row
  const keysOf = (t) =>
    [t.id, t.sourceTx, t.deliveryTx].filter(Boolean).map((k) => String(k).toLowerCase());
  for (const raw of rows) {
    const t = {
      ...raw,
      at: new Date(raw.at).toISOString(),
      to: raw.domain === null || raw.domain === undefined ? null : (domains[raw.domain] ?? null),
    };
    const twinId = keysOf(t)
      .map((k) => byKey.get(k))
      .find(Boolean);
    const twin = twinId ? kept.get(twinId) : null;
    let winner = t;
    let loser = null;
    if (twin) {
      // The first row read wins a tie, so a backfill row never replaces a live one.
      const stronger = (STRENGTH[t.proof] ?? 0) > (STRENGTH[twin.proof] ?? 0);
      winner = stronger ? t : twin;
      loser = stronger ? twin : t;
      kept.delete(twin.id);
      // The winner takes a mint link only the other had.
      if (!winner.deliveryTx && loser.deliveryTx) {
        winner = { ...winner, deliveryTx: loser.deliveryTx, deliveryTxUrl: loser.deliveryTxUrl };
      }
    }
    kept.set(winner.id, winner);
    for (const k of [...keysOf(winner), ...(loser ? keysOf(loser) : [])]) byKey.set(k, winner.id);
  }
  return [...kept.values()].sort((a, b) => b.at.localeCompare(a.at));
}

const round = (n) => Math.round(n * 1e6) / 1e6;

/** Transfers, USDC sent, Xebra's fees, chains touched and routes used, plus the same per source. */
export function totalsOf(transfers) {
  const bySource = {};
  for (const t of transfers) {
    bySource[t.source] ??= { transfers: 0, usdcSent: 0, xebraFees: 0 };
    bySource[t.source].transfers += 1;
    bySource[t.source].usdcSent = round(bySource[t.source].usdcSent + (t.amount ?? 0));
    bySource[t.source].xebraFees = round(bySource[t.source].xebraFees + (t.xebraFee ?? 0));
  }
  const chains = new Set(transfers.flatMap((t) => [t.source, t.to]).filter(Boolean));
  const routes = new Set(transfers.filter((t) => t.to).map((t) => `${t.source}>${t.to}`));
  return {
    transfers: transfers.length,
    usdcSent: round(transfers.reduce((s, t) => s + (t.amount ?? 0), 0)),
    xebraFees: round(transfers.reduce((s, t) => s + (t.xebraFee ?? 0), 0)),
    chains: chains.size,
    routes: routes.size,
    bySource,
  };
}
