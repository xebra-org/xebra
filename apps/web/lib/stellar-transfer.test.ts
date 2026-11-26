import { describe, expect, it } from "vitest";
import {
  MAX_AGE_MS,
  type RememberedStellarTransfer,
  STELLAR_TRANSFER_KEY,
  parseStellarTransfer,
  recallStellarTransfer,
  rememberStellarTransfer,
} from "./stellar-transfer";

const TX = "04d2687602447b63b186354dd77fbd25c0c98a1247dc20888d11c2074256805d";
const NOW = 1_795_000_000_000;

function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => {
      data.delete(k);
    },
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

const record: RememberedStellarTransfer = {
  tx: TX,
  to: "sui",
  recipient: "0xc38bb6275219b5c559d1c098622c3b3c2f883772cf1ae7038e58ad661e86285e",
  at: NOW - 60_000,
  deadlineMs: NOW + 540_000,
};

describe("rememberStellarTransfer / recallStellarTransfer", () => {
  it("brings back a saved transfer exactly as it was saved", () => {
    const s = memoryStorage();
    expect(rememberStellarTransfer(record, s)).toBe(true);
    expect(recallStellarTransfer(s, NOW)).toEqual(record);
  });

  it("forgets the transfer when cleared", () => {
    const s = memoryStorage();
    rememberStellarTransfer(record, s);
    expect(rememberStellarTransfer(null, s)).toBe(true);
    expect(s.data.has(STELLAR_TRANSFER_KEY)).toBe(false);
    expect(recallStellarTransfer(s, NOW)).toBeNull();
  });

  it("says so when the browser will not store anything, instead of throwing", () => {
    const blocked = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(rememberStellarTransfer(record, blocked)).toBe(false);
  });

  it("returns nothing when storage itself cannot be read", () => {
    const blocked = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(recallStellarTransfer(blocked, NOW)).toBeNull();
  });

  it("keeps an EVM and a Solana destination too", () => {
    const s = memoryStorage();
    for (const to of ["base", "solana"] as const) {
      rememberStellarTransfer({ ...record, to }, s);
      expect(recallStellarTransfer(s, NOW)?.to).toBe(to);
    }
  });

  it("drops a record older than the limit, so an old hash is never re-checked against a Horizon that no longer keeps it", () => {
    const s = memoryStorage();
    rememberStellarTransfer({ ...record, at: NOW - MAX_AGE_MS - 1 }, s);
    expect(recallStellarTransfer(s, NOW)).toBeNull();
  });
});

describe("parseStellarTransfer", () => {
  it("refuses anything that is not a whole record", () => {
    const bad = [
      null,
      "",
      "not json",
      "null",
      "[]",
      JSON.stringify({ ...record, tx: "abc" }),
      JSON.stringify({ ...record, tx: TX.toUpperCase().replace(/./, "Z") }),
      JSON.stringify({ ...record, to: "mars" }),
      JSON.stringify({ ...record, recipient: 7 }),
      JSON.stringify({ ...record, recipient: "x".repeat(200) }),
      JSON.stringify({ ...record, at: "yesterday" }),
    ];
    for (const raw of bad) expect(parseStellarTransfer(raw, NOW)).toBeNull();
  });

  it("accepts an upper-case hash and stores it lower-case", () => {
    const raw = JSON.stringify({ ...record, tx: TX.toUpperCase() });
    expect(parseStellarTransfer(raw, NOW)?.tx).toBe(TX);
  });

  it("ignores a deadline that is not a number rather than refusing the record", () => {
    const raw = JSON.stringify({ ...record, deadlineMs: "soon" });
    const parsed = parseStellarTransfer(raw, NOW);
    expect(parsed?.tx).toBe(TX);
    expect(parsed && "deadlineMs" in parsed).toBe(false);
  });

  it("keeps a relayed Sui transfer relayed, so a refresh still asks the relayer to finish it", () => {
    const raw = JSON.stringify({ ...record, to: "sui", relayed: true });
    expect(parseStellarTransfer(raw, NOW)?.relayed).toBe(true);
  });

  it("treats anything but true as not relayed", () => {
    for (const relayed of ["true", 1, null]) {
      const parsed = parseStellarTransfer(JSON.stringify({ ...record, relayed }), NOW);
      expect(parsed?.tx).toBe(TX);
      expect(parsed && "relayed" in parsed).toBe(false);
    }
  });
});
