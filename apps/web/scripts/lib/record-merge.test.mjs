import { describe, expect, it } from "vitest";
import { mergeRows, totalsOf } from "./record-merge.mjs";

const DOMAINS = { 5: "solana", 8: "sui", 15: "monad", 27: "stellar" };
const row = (over = {}) => ({
  id: "stellar:0xab",
  source: "stellar",
  proof: "contract",
  sourceTx: "a09a",
  sourceTxUrl: "https://stellar.expert/explorer/public/tx/a09a",
  at: "2026-10-01T14:58:32Z",
  domain: 5,
  amount: 100,
  xebraFee: 0.138352,
  ...over,
});

describe("merging the record's rows", () => {
  it("names the destination and writes every time the same way", () => {
    const [t] = mergeRows([row()], DOMAINS);
    expect(t.to).toBe("solana");
    expect(t.at).toBe("2026-10-01T14:58:32.000Z");
  });

  it("keeps the first of two rows with one id, so a backfill row never replaces a live one", () => {
    const out = mergeRows([row({ amount: 100 }), row({ amount: 1 })], DOMAINS);
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(100);
  });

  it("treats rows that share a burn or a mint as one transfer and keeps the stronger proof", () => {
    const listed = row({
      id: "sui:37cR",
      source: "sui",
      proof: "listed",
      sourceTx: "37cR",
      domain: 27,
      amount: 1,
      deliveryTx: "6717",
      deliveryTxUrl: "https://stellar.expert/explorer/public/tx/6717",
    });
    const relayed = row({
      id: "stellar-mint:6717",
      source: "sui",
      proof: "relayed",
      sourceTx: "6717",
      deliveryTx: "6717",
      domain: 27,
      amount: 1,
    });
    const out = mergeRows([listed, relayed], DOMAINS);
    expect(out).toHaveLength(1);
    expect(out[0].proof).toBe("relayed");
    // A third row for the same burn still finds the kept one.
    expect(mergeRows([listed, relayed, { ...listed, id: "sui:other" }], DOMAINS)).toHaveLength(1);
  });

  it("keeps the mint link the weaker twin had", () => {
    const contract = row();
    const listed = row({
      id: "stellar:a09a",
      proof: "listed",
      deliveryTx: "55dw",
      deliveryTxUrl: "https://solscan.io/tx/55dw",
    });
    const [t] = mergeRows([listed, contract], DOMAINS);
    expect(t.proof).toBe("contract");
    expect(t.deliveryTxUrl).toBe("https://solscan.io/tx/55dw");
  });

  it("sorts newest first and counts transfers, USDC, chains and routes", () => {
    const rows = mergeRows(
      [
        row(),
        row({
          id: "sui:F7",
          source: "sui",
          sourceTx: "F7",
          domain: 15,
          amount: 5,
          at: "2026-11-11T14:17:03Z",
        }),
        row({
          id: "base:0x1",
          source: "base",
          sourceTx: "0x1",
          domain: null,
          amount: null,
          xebraFee: 0.01,
          at: "2026-11-20T00:00:00Z",
        }),
      ],
      DOMAINS,
    );
    expect(rows.map((t) => t.id)).toEqual(["base:0x1", "sui:F7", "stellar:0xab"]);
    expect(totalsOf(rows)).toMatchObject({
      transfers: 3,
      usdcSent: 105,
      chains: 5, // stellar, solana, sui, monad, base
      routes: 2,
    });
  });
});
