import { describe, expect, it } from "vitest";
import {
  type Beneficiary,
  MAX_BENEFICIARIES,
  MAX_NAME_LENGTH,
  cleanName,
  findBeneficiary,
  forFamily,
  labelOf,
  parseStored,
  remember,
  remove,
  rename,
} from "./beneficiaries";

const EVM = "0x1111111111111111111111111111111111111111";
const EVM_UPPER = "0x111111111111111111111111111111111111111F";
const EVM_LOWER = EVM_UPPER.toLowerCase();
const SOL = "4UXmtLwyV5tRyzuCFtQccrHkepyVDnL29GLsg5LwFN82";

describe("remember", () => {
  it("adds a new recipient unnamed", () => {
    const list = remember([], { family: "evm", address: EVM, now: 10 });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ address: EVM, family: "evm", name: "", lastUsedAt: 10 });
  });

  it("keeps the name and moves a known recipient up, whatever the case of an EVM address", () => {
    let list = remember([], { family: "evm", address: EVM_UPPER, now: 1, name: "Mum" });
    list = remember(list, { family: "evm", address: EVM, now: 2 });
    list = remember(list, { family: "evm", address: EVM_LOWER, now: 3 });
    expect(list.filter((b) => b.family === "evm")).toHaveLength(2);

    const again = remember(list, { family: "evm", address: EVM_LOWER, now: 9 });
    expect(again).toHaveLength(2);
    const mum = findBeneficiary(again, "evm", EVM_UPPER);
    expect(mum).toMatchObject({ name: "Mum", lastUsedAt: 9 });
  });

  it("treats a Solana address as case-sensitive", () => {
    const list = remember([], { family: "solana", address: SOL, now: 1 });
    expect(findBeneficiary(list, "solana", SOL.toLowerCase())).toBeUndefined();
  });

  it("ignores an address that is not shaped like its family", () => {
    expect(remember([], { family: "evm", address: SOL, now: 1 })).toEqual([]);
    expect(remember([], { family: "solana", address: EVM, now: 1 })).toEqual([]);
    expect(remember([], { family: "evm", address: "0x123", now: 1 })).toEqual([]);
  });

  it("drops the oldest past the cap", () => {
    let list: Beneficiary[] = [];
    for (let i = 0; i < MAX_BENEFICIARIES + 5; i++) {
      const address = `0x${i.toString(16).padStart(40, "0")}`;
      list = remember(list, { family: "evm", address, now: i + 1 });
    }
    expect(list).toHaveLength(MAX_BENEFICIARIES);
    expect(list[0]?.lastUsedAt).toBe(MAX_BENEFICIARIES + 5);
    expect(list.at(-1)?.lastUsedAt).toBe(6);
  });
});

describe("names", () => {
  it("trims, collapses spaces and caps the length", () => {
    expect(cleanName("  My   other\twallet ")).toBe("My other wallet");
    expect(cleanName("x".repeat(100))).toHaveLength(MAX_NAME_LENGTH);
  });

  it("renames by id and can clear a name", () => {
    const [b] = remember([], { family: "evm", address: EVM, now: 1 });
    if (!b) throw new Error("expected one row");
    const named = rename([b], b.id, " Ada ");
    expect(named[0]?.name).toBe("Ada");
    expect(rename(named, b.id, "")[0]?.name).toBe("");
  });

  it("labels an unnamed recipient by its short address", () => {
    const [b] = remember([], { family: "evm", address: EVM, now: 1 });
    if (!b) throw new Error("expected one row");
    expect(labelOf(b)).toBe("0x1111…1111");
    expect(labelOf({ ...b, name: "Ada" })).toBe("Ada");
  });
});

describe("remove and forFamily", () => {
  it("removes by id and lists one family newest first", () => {
    let list = remember([], { family: "evm", address: EVM, now: 1 });
    list = remember(list, { family: "solana", address: SOL, now: 2 });
    list = remember(list, { family: "evm", address: EVM_LOWER, now: 3 });
    expect(forFamily(list, "evm").map((b) => b.lastUsedAt)).toEqual([3, 1]);
    const [first] = forFamily(list, "evm");
    if (!first) throw new Error("expected a row");
    expect(remove(list, first.id)).toHaveLength(2);
  });
});

describe("parseStored", () => {
  it("round-trips what remember wrote", () => {
    const list = remember([], { family: "evm", address: EVM, now: 5, name: "Ada" });
    expect(parseStored(JSON.stringify(list))).toEqual(list);
  });

  it("survives empty, malformed and wrong-shaped storage", () => {
    expect(parseStored(null)).toEqual([]);
    expect(parseStored("")).toEqual([]);
    expect(parseStored("{not json")).toEqual([]);
    expect(parseStored('{"a":1}')).toEqual([]);
    expect(parseStored('[1,null,"x",{}]')).toEqual([]);
  });

  it("drops rows with a bad address or family, and duplicates", () => {
    const rows = [
      { id: "1", name: "ok", address: EVM_UPPER, family: "evm", lastUsedAt: 2 },
      { id: "2", name: "dup", address: EVM_LOWER, family: "evm", lastUsedAt: 1 },
      { id: "3", name: "bad", address: "nope", family: "evm", lastUsedAt: 3 },
      { id: "4", name: "alien", address: EVM, family: "sui", lastUsedAt: 4 },
    ];
    const out = parseStored(JSON.stringify(rows));
    expect(out.map((b) => b.id)).toEqual(["1"]);
  });
});
