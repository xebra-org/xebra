import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileJournal } from "./journal.js";

const HASH = `0x${"ab".repeat(32)}`;
const dir = () => mkdtempSync(join(tmpdir(), "solver-journal-"));

describe("FileJournal", () => {
  it("survives a restart: the fill, the claim and the cursor are all read back", async () => {
    const path = join(dir(), "state.json");
    const first = new FileJournal(path);
    await first.recordFill(HASH, { destTxRef: "5Gy3sig", deliveredAmount: 900_000_000n });
    await first.setCursor("cur-7");

    const second = new FileJournal(path);
    expect(second.getCursor()).toBe("cur-7");
    expect(second.get(HASH)).toEqual({ destTxRef: "5Gy3sig", deliveredAmount: 900_000_000n });

    await second.recordClaim(HASH, "claim-tx");
    expect(new FileJournal(path).get(HASH)?.claimTxRef).toBe("claim-tx");
  });

  it("matches a hash with or without 0x and in any case", async () => {
    const j = new FileJournal(join(dir(), "state.json"));
    await j.recordFill(HASH.toUpperCase().replace("0X", "0x"), {
      destTxRef: "s",
      deliveredAmount: 1n,
    });
    expect(j.get(HASH.replace(/^0x/, ""))?.destTxRef).toBe("s");
  });

  it("starts empty when there is no file", () => {
    const j = new FileJournal(join(dir(), "missing", "state.json"));
    expect(j.get(HASH)).toBeUndefined();
    expect(j.getCursor()).toBeUndefined();
  });

  it("refuses a file it cannot read back, instead of starting empty and delivering twice", () => {
    const path = join(dir(), "state.json");
    writeFileSync(path, "{ not json");
    expect(() => new FileJournal(path)).toThrow();
    writeFileSync(path, JSON.stringify({ cursor: "x" }));
    expect(() => new FileJournal(path)).toThrow(/not a solver state file/);
  });

  it("will not record a claim for a delivery it never saw", async () => {
    const j = new FileJournal(join(dir(), "state.json"));
    await expect(j.recordClaim(HASH, "claim-tx")).rejects.toThrow(/no fill recorded/);
  });

  it("writes valid JSON after every change", async () => {
    const path = join(dir(), "state.json");
    const j = new FileJournal(path);
    await j.recordFill(HASH, { destTxRef: "s", deliveredAmount: 5n });
    expect(JSON.parse(readFileSync(path, "utf8")).entries).toBeTypeOf("object");
  });
});
