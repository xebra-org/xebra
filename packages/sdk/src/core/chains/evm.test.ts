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
  parseEvmMesh,
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

describe("the EVM mesh", () => {
  const mesh = (evmMesh: EnabledRoutes["evmMesh"]): EnabledRoutes => ({
    ...NO_ROUTES,
    evmMesh,
  });

  it("sends from every chain in it to every other chain in it, never to itself", () => {
    const r = mesh(["base", "unichain", "sonic"]);
    expect(evmSources(r)).toEqual(["base", "unichain", "sonic"]);
    expect(evmDestinationsFrom("unichain", r)).toEqual(["base", "sonic"]);
    expect(evmDestinationsFrom("base", r)).toEqual(["unichain", "sonic"]);
    expect(evmDestinationsFrom("arbitrum", r)).toEqual([]);
    expect(hasEvmRoutes(r)).toBe(true);
  });

  it("offers nothing with one chain, since a chain never sends to itself", () => {
    expect(evmSources(mesh(["base"]))).toEqual([]);
    expect(hasEvmRoutes(mesh(["base"]))).toBe(false);
  });

  it("leaves Arc to its own switches, and adds to them without repeating a destination", () => {
    const r: EnabledRoutes = {
      arcSendsTo: ["base"],
      arcReceivesFrom: ["unichain"],
      evmMesh: ["base", "unichain"],
    };
    expect(evmSources(r)).toEqual(["base", "unichain", "arc"]);
    expect(evmDestinationsFrom("unichain", r)).toEqual(["arc", "base"]);
    expect(evmDestinationsFrom("base", r)).toEqual(["unichain"]);
    expect(evmDestinationsFrom("arc", r)).toEqual(["base"]);
  });

  it("is read from NEXT_PUBLIC_EVM_MESH, a list or all, and refuses Arc and Solana", () => {
    expect(parseEvmMesh(undefined)).toEqual([]);
    expect(parseEvmMesh("sonic, base")).toEqual(["base", "sonic"]);
    expect(parseEvmMesh("all")).toEqual(EVM_ARC_PEERS);
    expect(() => parseEvmMesh("arc")).toThrow('NEXT_PUBLIC_EVM_MESH names "arc"');
    expect(() => parseEvmMesh("solana")).toThrow('NEXT_PUBLIC_EVM_MESH names "solana"');
  });

  it("is off for a build that predates it (no evmMesh field)", () => {
    const old = { arcSendsTo: [], arcReceivesFrom: [] } as EnabledRoutes;
    expect(evmSources(old)).toEqual([]);
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
