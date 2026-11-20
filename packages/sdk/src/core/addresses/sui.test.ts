import { describe, expect, it } from "vitest";
import { checkSuiAddress } from "./sui.js";

const WALLET = "0xe56ad8c14ab50d71625eeec43a6227b8d336fe90d737b8bac5dbfc53e853ac11";

describe("checkSuiAddress", () => {
  it("accepts a wallet and returns its 32 bytes", () => {
    const r = checkSuiAddress(` ${WALLET.toUpperCase().replace("0X", "0x")} `);
    expect(r.ok).toBe(true);
    expect(r.bytes?.length).toBe(32);
    expect(r.bytes?.[0]).toBe(0xe5);
    expect(r.bytes?.[31]).toBe(0x11);
  });

  it("is quiet while empty", () => {
    expect(checkSuiAddress("")).toEqual({ ok: false });
  });

  it("refuses an EVM address, a short one, and a system address", () => {
    expect(checkSuiAddress("0x5b38da6a701c568545dcfcb03fcb875f56beddc4").error).toContain("EVM");
    expect(checkSuiAddress("0x1234").error).toContain("64 hex");
    expect(checkSuiAddress(`0x${"0".repeat(63)}6`).error).toContain("system");
    expect(checkSuiAddress(`G${"A".repeat(55)}`).ok).toBe(false);
  });
});
