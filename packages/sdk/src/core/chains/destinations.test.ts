import { describe, expect, it } from "vitest";
import { stellarDestination, stellarDestinations } from "./destinations.js";
import { EVM_ARC_PEERS, EVM_CHAINS } from "./evm.js";

/** Mainnet on 2026-10-14: the wrapper has Solana (5) and Arc (26) committed, nothing else. */
const LIVE = new Set([5, 26]);
const ids = (list: { id: string }[]) => list.map((d) => d.id);

describe("stellarDestinations", () => {
  it("offers Solana and Arc only, today, even with every chain named", () => {
    expect(
      ids(stellarDestinations({ arcEnabled: true, sendsTo: EVM_ARC_PEERS, committed: LIVE })),
    ).toEqual(["solana", "arc"]);
  });

  it("offers a named chain the moment the wrapper commits its domain", () => {
    const withBase = new Set([...LIVE, EVM_CHAINS.base.cctpDomainId]);
    expect(
      ids(stellarDestinations({ arcEnabled: true, sendsTo: EVM_ARC_PEERS, committed: withBase })),
    ).toEqual(["solana", "arc", "base"]);
  });

  it("does not offer a committed chain the build does not name", () => {
    const withBase = new Set([...LIVE, EVM_CHAINS.base.cctpDomainId]);
    expect(
      ids(stellarDestinations({ arcEnabled: true, sendsTo: ["ink"], committed: withBase })),
    ).toEqual(["solana", "arc"]);
  });

  it("offers no further chain while the contract's list is unknown", () => {
    expect(
      ids(stellarDestinations({ arcEnabled: true, sendsTo: EVM_ARC_PEERS, committed: null })),
    ).toEqual(["solana", "arc"]);
  });

  it("keeps Arc behind its own switch, and Solana always", () => {
    expect(ids(stellarDestinations({ arcEnabled: false, sendsTo: [], committed: LIVE }))).toEqual([
      "solana",
    ]);
  });

  it("lists the chains in the table's order", () => {
    const all = new Set(Object.values(EVM_CHAINS).map((c) => c.cctpDomainId));
    expect(
      ids(stellarDestinations({ arcEnabled: true, sendsTo: EVM_ARC_PEERS, committed: all })),
    ).toEqual(["solana", "arc", ...EVM_ARC_PEERS]);
  });
});

describe("stellarDestination", () => {
  it("describes an EVM chain from its row, and checks addresses against that chain", () => {
    const base = stellarDestination("base");
    expect(base.domain).toBe(6);
    expect(base.needsAccountResolution).toBe(false);
    expect(base.addressLabel).toBe("Base address");
    expect(base.checkAddress(EVM_CHAINS.base.usdcAddress).ok).toBe(false);
    expect(base.explorerTxUrl("0xab")).toBe(`${EVM_CHAINS.base.explorerUrl}/tx/0xab`);
  });

  it("keeps Solana's account resolution and Arc's explorer", () => {
    expect(stellarDestination("solana").needsAccountResolution).toBe(true);
    expect(stellarDestination("solana").evm).toBeNull();
    expect(stellarDestination("arc").explorerTxUrl("0xab")).toBe("https://explorer.arc.io/tx/0xab");
  });
});
