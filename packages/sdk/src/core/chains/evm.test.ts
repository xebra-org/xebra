import {
  EVM_CHAINS as PINNED,
  EVM_ARC_PEERS as PINNED_PEERS,
  SOLANA_FROM_ARC as PINNED_SOLANA,
  XEBRA_WRAPPERS as PINNED_WRAPPERS,
} from "@xebra/network-config";
import { describe, expect, it } from "vitest";
import {
  ARC_PEERS,
  EVM_ARC_PEERS,
  EVM_CHAINS,
  type EnabledRoutes,
  NO_ROUTES,
  SOLANA_FROM_ARC,
  XEBRA_WRAPPERS,
  evmChainForChainId,
  evmChainForDomain,
  evmDestinationsFrom,
  evmSources,
  hasEvmRoutes,
  parseArcReceivesFrom,
  parseArcSendsTo,
  parseStellarSendsTo,
} from "./evm.js";

describe("EVM_CHAINS", () => {
  it("agrees with the pinned network config field for field, so a copy that drifted fails", () => {
    expect(EVM_CHAINS).toEqual(PINNED);
    expect(EVM_ARC_PEERS).toEqual(PINNED_PEERS);
    expect(SOLANA_FROM_ARC).toEqual(PINNED_SOLANA);
    expect(XEBRA_WRAPPERS).toEqual(PINNED_WRAPPERS);
  });

  it("finds a chain by CCTP domain and by wallet chain id", () => {
    expect(evmChainForDomain(26)?.id).toBe("arc");
    expect(evmChainForDomain(27)).toBeNull();
    expect(evmChainForChainId(8453)?.id).toBe("base");
    expect(evmChainForChainId(11155111)).toBeNull();
  });
});

describe("which routes a build offers", () => {
  const routes = (
    arcSendsTo: EnabledRoutes["arcSendsTo"],
    arcReceivesFrom: EnabledRoutes["arcReceivesFrom"] = [],
  ): EnabledRoutes => ({ arcSendsTo, arcReceivesFrom });

  it("offers nothing until a direction is switched on", () => {
    expect(evmSources(NO_ROUTES)).toEqual([]);
    expect(evmDestinationsFrom("arc", NO_ROUTES)).toEqual([]);
    expect(evmDestinationsFrom("base", NO_ROUTES)).toEqual([]);
    expect(hasEvmRoutes(NO_ROUTES)).toBe(false);
  });

  it("offers Arc to a chain without offering that chain to Arc", () => {
    const outbound = routes(["base", "solana"]);
    expect(evmSources(outbound)).toEqual(["arc"]);
    expect(evmDestinationsFrom("arc", outbound)).toEqual(["base", "solana"]);
    expect(evmDestinationsFrom("base", outbound)).toEqual([]);
    expect(hasEvmRoutes(outbound)).toBe(true);
  });

  it("offers a chain to Arc without offering Arc anywhere", () => {
    const inbound = routes([], ["base"]);
    expect(evmSources(inbound)).toEqual(["base"]);
    expect(evmDestinationsFrom("base", inbound)).toEqual(["arc"]);
    expect(evmDestinationsFrom("arc", inbound)).toEqual([]);
  });

  it("offers both ways when both are on, and never a chain to another chain", () => {
    const both = routes(EVM_ARC_PEERS, EVM_ARC_PEERS);
    expect(evmSources(both)).toEqual([...EVM_ARC_PEERS, "arc"]);
    for (const peer of EVM_ARC_PEERS) {
      expect(evmDestinationsFrom(peer, both)).toEqual(["arc"]);
    }
  });
});

describe("the route lists", () => {
  it("are off when the variable is absent or empty", () => {
    expect(parseArcSendsTo(undefined)).toEqual([]);
    expect(parseArcSendsTo(null)).toEqual([]);
    expect(parseArcReceivesFrom("  ")).toEqual([]);
  });

  it("read a list, in the table's order, forgiving spaces", () => {
    expect(parseArcSendsTo("base, arbitrum")).toEqual(["arbitrum", "base"]);
    expect(parseArcSendsTo("solana,unichain")).toEqual(["unichain", "solana"]);
    expect(parseArcSendsTo("all")).toEqual(ARC_PEERS);
    expect(ARC_PEERS).toHaveLength(15);
    expect(parseArcReceivesFrom("all")).toEqual(EVM_ARC_PEERS);
  });

  it("let Solana be a destination of Arc but never a source", () => {
    expect(parseArcSendsTo("solana")).toEqual(["solana"]);
    expect(() => parseArcReceivesFrom("solana")).toThrow(
      'NEXT_PUBLIC_ARC_RECEIVES_FROM names "solana"',
    );
  });

  it("fail loudly on a name they do not know, on Arc, and on the chains left out", () => {
    for (const left of ["ethereum", "linea", "plume", "edge"]) {
      expect(() => parseArcSendsTo(left)).toThrow(`NEXT_PUBLIC_ARC_SENDS_TO names "${left}"`);
    }
    expect(() => parseArcSendsTo("base,bsae")).toThrow('names "bsae"');
    expect(() => parseArcSendsTo("arc")).toThrow('names "arc"');
    expect(() => parseArcReceivesFrom("1")).toThrow('names "1"');
  });

  it("name Stellar's EVM destinations other than Arc and Solana, which have their own switches", () => {
    expect(parseStellarSendsTo(undefined)).toEqual([]);
    expect(parseStellarSendsTo("all")).toEqual(EVM_ARC_PEERS);
    expect(parseStellarSendsTo("ink, base")).toEqual(["base", "ink"]);
    for (const other of ["arc", "solana", "ethereum"]) {
      expect(() => parseStellarSendsTo(other)).toThrow(
        `NEXT_PUBLIC_STELLAR_SENDS_TO names "${other}"`,
      );
    }
  });
});
