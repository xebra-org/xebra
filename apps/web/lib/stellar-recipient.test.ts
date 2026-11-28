import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  STELLAR_RECIPIENT_FORMAT,
  readStellarRecipient,
  stellarRecipientHint,
  stellarRecipientProblem,
} from "./stellar-recipient";

const G = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
// G with the id 1234567890, and with the largest id a muxed address can carry.
const M = "MBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMAAAAAAETFQC2KFIW";
const M_MAX = new MuxedAccount(new Account(G, "0"), "18446744073709551615").accountId();
const C = "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL";

describe("readStellarRecipient", () => {
  it("reads a G... account as itself", () => {
    expect(readStellarRecipient(` ${G} `)).toEqual({
      address: G,
      account: G,
      muxed: false,
      id: null,
    });
  });

  it("reads an M... address as its G... account and id, keeping the text for the hook", () => {
    expect(readStellarRecipient(M)).toEqual({
      address: M,
      account: G,
      muxed: true,
      id: "1234567890",
    });
    expect(readStellarRecipient(M_MAX)?.id).toBe("18446744073709551615");
  });

  it("refuses contracts, broken checksums, seeds, lower case and other chains", () => {
    for (const bad of [
      C,
      `${M.slice(0, -1)}A`,
      M.slice(0, 68),
      M.toLowerCase(),
      Keypair.random().secret(),
      "0x1111111111111111111111111111111111111111",
      "",
    ]) {
      expect(readStellarRecipient(bad), bad).toBeNull();
    }
    expect(STELLAR_RECIPIENT_FORMAT).toMatch(/G.*M/);
  });
});

describe("stellarRecipientProblem", () => {
  const g = readStellarRecipient(G);
  const m = readStellarRecipient(M);
  if (!g || !m) throw new Error("fixtures");

  it("is null when the account exists and holds a trustline", () => {
    expect(stellarRecipientProblem(m, { exists: true, hasTrustline: true })).toBeNull();
  });

  it("keeps the old words for a G... account", () => {
    expect(stellarRecipientProblem(g, { exists: true, hasTrustline: false })).toBe(
      "That Stellar account has no USDC trustline. Add one, then try again.",
    );
  });

  it("names the G... account behind an M... address, and points at the exchange", () => {
    const noLine = stellarRecipientProblem(m, { exists: true, hasTrustline: false });
    expect(noLine).toContain(G);
    expect(noLine).toMatch(/exchange/);
    expect(stellarRecipientProblem(m, { exists: false, hasTrustline: false })).toContain(G);
  });
});

describe("stellarRecipientHint", () => {
  it("shows the account and deposit id of a pasted M... address", () => {
    const hint = stellarRecipientHint(M);
    expect(hint).toContain("1234567890");
    expect(hint).toContain(`${G.slice(0, 6)}…${G.slice(-6)}`);
  });

  it("is the plain hint otherwise", () => {
    expect(stellarRecipientHint(G)).toBe(stellarRecipientHint(""));
    expect(stellarRecipientHint("")).toMatch(/Starts with G, or M/);
  });
});
