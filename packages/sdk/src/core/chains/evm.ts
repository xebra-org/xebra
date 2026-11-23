/**
 * The EVM chains USDC moves between, as the browser knows them.
 *
 * A literal copy of `EVM_CHAINS` in `packages/network-config`, for the reason `lib/env.ts` gives:
 * importing that package into client code drags its whole preset table and validator into the
 * bundle. A second copy is only safe if a test can tell it drifted, and `evm-chains.test.ts`
 * asserts this one equals the pinned table field for field. Change them together, after
 * `pnpm check:evm` has re-read the values from the chains.
 *
 * On these routes the browser calls Circle's contracts directly. There is no Xebra contract to
 * refuse a wrong token or a wrong domain, so these rows are what a transfer is built from.
 */

export type EvmChainId =
  | "avalanche"
  | "optimism"
  | "arbitrum"
  | "base"
  | "polygon"
  | "unichain"
  | "codex"
  | "sonic"
  | "worldchain"
  | "monad"
  | "sei"
  | "xdc"
  | "hyperevm"
  | "ink"
  | "ethereum"
  | "linea"
  | "plume"
  | "edge"
  | "cronos"
  | "plasma"
  | "xlayer"
  | "injective"
  | "morph"
  | "pharos"
  | "arc";

export interface EvmChain {
  id: EvmChainId;
  name: string;
  chainId: number;
  cctpDomainId: number;
  /** The 6-decimal USDC that CCTP burns and mints on this chain. */
  usdcAddress: string;
  tokenMessengerAddress: string;
  messageTransmitterAddress: string;
  /** Never called. Listed so a mint can be refused when it names this contract as recipient. */
  tokenMinterAddress: string;
  /** For handing a wallet a chain it has never seen. Transfers go through the wallet's own node. */
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /** Whether Circle offers Fast Transfer for burns made on this chain. */
  fast: boolean;
  /** The most Circle may be paid to deliver a transfer into this chain, in 6-decimal units. */
  maxForwardFeeUnits: number;
  /** What claiming by hand costs here, said plainly. */
  claimCost: string;
  /** How long a Standard burn made here takes to be attested. Circle's figures, not yet ours. */
  standardEta: string;
}

/** Circle's three contracts, at the one address they have on every chain here. */
const CIRCLE = {
  tokenMessengerAddress: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  messageTransmitterAddress: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  tokenMinterAddress: "0xfd78EE919681417d192449715b2594ab58f5D002",
} as const;

const ETH = { name: "Ether", symbol: "ETH", decimals: 18 } as const;

export const EVM_CHAINS: Record<EvmChainId, EvmChain> = {
  avalanche: {
    id: "avalanche",
    name: "Avalanche",
    chainId: 43114,
    cctpDomainId: 1,
    usdcAddress: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    ...CIRCLE,
    rpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    explorerUrl: "https://snowtrace.io",
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
    fast: false,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little AVAX for gas",
    standardEta: "under a minute",
  },
  optimism: {
    id: "optimism",
    name: "OP Mainnet",
    chainId: 10,
    cctpDomainId: 2,
    usdcAddress: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    ...CIRCLE,
    rpcUrl: "https://optimism-rpc.publicnode.com",
    explorerUrl: "https://optimistic.etherscan.io",
    nativeCurrency: ETH,
    fast: true,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little ETH on OP Mainnet for gas",
    standardEta: "15 to 20 minutes",
  },
  arbitrum: {
    id: "arbitrum",
    name: "Arbitrum",
    chainId: 42161,
    cctpDomainId: 3,
    usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    ...CIRCLE,
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    explorerUrl: "https://arbiscan.io",
    nativeCurrency: ETH,
    fast: true,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little ETH on Arbitrum for gas",
    standardEta: "15 to 20 minutes",
  },
  base: {
    id: "base",
    name: "Base",
    chainId: 8453,
    cctpDomainId: 6,
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ...CIRCLE,
    rpcUrl: "https://mainnet.base.org",
    explorerUrl: "https://basescan.org",
    nativeCurrency: ETH,
    fast: true,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little ETH on Base for gas",
    standardEta: "15 to 20 minutes",
  },
  polygon: {
    id: "polygon",
    name: "Polygon",
    chainId: 137,
    cctpDomainId: 7,
    usdcAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    ...CIRCLE,
    rpcUrl: "https://polygon-bor-rpc.publicnode.com",
    explorerUrl: "https://polygonscan.com",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    fast: false,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little POL for gas",
    standardEta: "under a minute",
  },
  unichain: {
    id: "unichain",
    name: "Unichain",
    chainId: 130,
    cctpDomainId: 10,
    usdcAddress: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
    ...CIRCLE,
    rpcUrl: "https://mainnet.unichain.org",
    explorerUrl: "https://uniscan.xyz",
    nativeCurrency: ETH,
    fast: true,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little ETH on Unichain for gas",
    standardEta: "15 to 20 minutes",
  },
  codex: {
    id: "codex",
    name: "Codex",
    chainId: 81224,
    cctpDomainId: 12,
    usdcAddress: "0xd996633a415985DBd7D6D12f4A4343E31f5037cf",
    ...CIRCLE,
    rpcUrl: "https://rpc.codex.xyz",
    explorerUrl: "https://explorer.codex.xyz",
    nativeCurrency: ETH,
    fast: true,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little ETH on Codex for gas",
    standardEta: "15 to 20 minutes",
  },
  sonic: {
    id: "sonic",
    name: "Sonic",
    chainId: 146,
    cctpDomainId: 13,
    usdcAddress: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
    ...CIRCLE,
    rpcUrl: "https://rpc.soniclabs.com",
    explorerUrl: "https://sonicscan.org",
    nativeCurrency: { name: "Sonic", symbol: "S", decimals: 18 },
    fast: false,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little S for gas",
    standardEta: "under a minute",
  },
  worldchain: {
    id: "worldchain",
    name: "World Chain",
    chainId: 480,
    cctpDomainId: 14,
    usdcAddress: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
    ...CIRCLE,
    rpcUrl: "https://worldchain-mainnet.g.alchemy.com/public",
    explorerUrl: "https://worldscan.org",
    nativeCurrency: ETH,
    fast: true,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little ETH on World Chain for gas",
    standardEta: "15 to 20 minutes",
  },
  monad: {
    id: "monad",
    name: "Monad",
    chainId: 143,
    cctpDomainId: 15,
    usdcAddress: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    ...CIRCLE,
    rpcUrl: "https://rpc.monad.xyz",
    explorerUrl: "https://monadscan.com",
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    fast: false,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little MON for gas",
    standardEta: "under a minute",
  },
  sei: {
    id: "sei",
    name: "Sei",
    chainId: 1329,
    cctpDomainId: 16,
    usdcAddress: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392",
    ...CIRCLE,
    rpcUrl: "https://evm-rpc.sei-apis.com",
    explorerUrl: "https://seitrace.com",
    nativeCurrency: { name: "Sei", symbol: "SEI", decimals: 18 },
    fast: false,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little SEI for gas",
    standardEta: "under a minute",
  },
  xdc: {
    id: "xdc",
    name: "XDC",
    chainId: 50,
    cctpDomainId: 18,
    usdcAddress: "0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1",
    ...CIRCLE,
    rpcUrl: "https://rpc.xdcrpc.com",
    explorerUrl: "https://xdcscan.com",
    nativeCurrency: { name: "XDC", symbol: "XDC", decimals: 18 },
    fast: false,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little XDC for gas",
    standardEta: "under a minute",
  },
  hyperevm: {
    id: "hyperevm",
    name: "HyperEVM",
    chainId: 999,
    cctpDomainId: 19,
    usdcAddress: "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
    ...CIRCLE,
    rpcUrl: "https://rpc.hyperliquid.xyz/evm",
    explorerUrl: "https://hyperevmscan.io",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    fast: false,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little HYPE for gas",
    standardEta: "under a minute",
  },
  ink: {
    id: "ink",
    name: "Ink",
    chainId: 57073,
    cctpDomainId: 21,
    usdcAddress: "0x2D270e6886d130D724215A266106e6832161EAEd",
    ...CIRCLE,
    rpcUrl: "https://rpc-gel.inkonchain.com",
    explorerUrl: "https://explorer.inkonchain.com",
    nativeCurrency: ETH,
    fast: true,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little ETH on Ink for gas",
    standardEta: "about 30 minutes",
  },
  ethereum: {
    id: "ethereum",
    name: "Ethereum",
    chainId: 1,
    cctpDomainId: 0,
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    ...CIRCLE,
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    explorerUrl: "https://etherscan.io",
    nativeCurrency: ETH,
    fast: true,
    maxForwardFeeUnits: 2_500_000,
    claimCost: "ETH on Ethereum for gas, often more than a dollar",
    standardEta: "15 to 20 minutes",
  },
  linea: {
    id: "linea",
    name: "Linea",
    chainId: 59144,
    cctpDomainId: 11,
    usdcAddress: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
    ...CIRCLE,
    rpcUrl: "https://rpc.linea.build",
    explorerUrl: "https://lineascan.build",
    nativeCurrency: ETH,
    fast: true,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little ETH on Linea for gas",
    standardEta: "6 to 32 hours (Linea's finality); Fast takes seconds",
  },
  plume: {
    id: "plume",
    name: "Plume",
    chainId: 98866,
    cctpDomainId: 22,
    usdcAddress: "0x222365EF19F7947e5484218551B56bb3965Aa7aF",
    ...CIRCLE,
    rpcUrl: "https://rpc.plume.org",
    explorerUrl: "https://explorer.plume.org",
    nativeCurrency: { name: "Plume", symbol: "PLUME", decimals: 18 },
    fast: true,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little PLUME for gas",
    standardEta: "15 to 20 minutes",
  },
  edge: {
    id: "edge",
    name: "EDGE",
    chainId: 3343,
    cctpDomainId: 28,
    usdcAddress: "0x98d2919b9A214E6Fa5384AC81E6864bA686Ad74c",
    // EDGE has its own deployment of Circle's contracts, not the address every other chain shares.
    tokenMessengerAddress: "0x98706A006bc632Df31CAdFCBD43F38887ce2ca5c",
    messageTransmitterAddress: "0x5b61381Fc9e58E70EfC13a4A97516997019198ee",
    tokenMinterAddress: "0x338Dfd607855BeEc17f33e539Ac2479853cC8384",
    rpcUrl: "https://edge-mainnet.g.alchemy.com/public",
    explorerUrl: "https://edge-mainnet.explorer.alchemy.com",
    nativeCurrency: ETH,
    fast: true,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little ETH on EDGE for gas",
    standardEta: "15 to 20 minutes",
  },
  cronos: {
    id: "cronos",
    name: "Cronos",
    chainId: 25,
    cctpDomainId: 32,
    usdcAddress: "0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D",
    ...CIRCLE,
    rpcUrl: "https://evm.cronos.org",
    explorerUrl: "https://explorer.cronos.org",
    nativeCurrency: { name: "Cronos", symbol: "CRO", decimals: 18 },
    fast: false,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little CRO for gas",
    standardEta: "under a minute",
  },
  plasma: {
    id: "plasma",
    name: "Plasma",
    chainId: 9745,
    cctpDomainId: 33,
    usdcAddress: "0x2d661C89D812261039AF9764eceaAee884f5F67F",
    ...CIRCLE,
    rpcUrl: "https://rpc.plasma.to",
    explorerUrl: "https://plasmascan.to",
    nativeCurrency: { name: "Plasma", symbol: "XPL", decimals: 18 },
    fast: false,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little XPL for gas",
    standardEta: "under a minute",
  },
  xlayer: {
    id: "xlayer",
    name: "X Layer",
    chainId: 196,
    cctpDomainId: 37,
    usdcAddress: "0xB6CEceAB302E2E4948951eE7843FC24E92933061",
    ...CIRCLE,
    rpcUrl: "https://rpc.xlayer.tech",
    explorerUrl: "https://www.oklink.com/xlayer",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    fast: true,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little OKB for gas",
    standardEta: "15 to 20 minutes",
  },
  injective: {
    id: "injective",
    name: "Injective",
    chainId: 1776,
    cctpDomainId: 29,
    usdcAddress: "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
    ...CIRCLE,
    rpcUrl: "https://sentry.evm-rpc.injective.network",
    explorerUrl: "https://blockscout.injective.network",
    nativeCurrency: { name: "Injective", symbol: "INJ", decimals: 18 },
    fast: false,
    // Circle does not deliver here: a transfer in is claimed, so no delivery fee is ever signed.
    maxForwardFeeUnits: 0,
    claimCost: "a little INJ for gas, to claim it",
    standardEta: "under a minute",
  },
  morph: {
    id: "morph",
    name: "Morph",
    chainId: 2818,
    cctpDomainId: 30,
    usdcAddress: "0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B",
    ...CIRCLE,
    rpcUrl: "https://rpc.morph.network",
    explorerUrl: "https://explorer.morph.network",
    nativeCurrency: ETH,
    fast: true,
    // Circle does not deliver here: a transfer in is claimed, so no delivery fee is ever signed.
    maxForwardFeeUnits: 0,
    claimCost: "a little ETH on Morph for gas, to claim it",
    standardEta: "20 to 30 minutes",
  },
  pharos: {
    id: "pharos",
    name: "Pharos",
    chainId: 1672,
    cctpDomainId: 31,
    usdcAddress: "0xC879C018dB60520F4355C26eD1a6D572cdAC1815",
    ...CIRCLE,
    rpcUrl: "https://rpc.pharos.xyz",
    explorerUrl: "https://pharosscan.xyz",
    nativeCurrency: { name: "Pharos", symbol: "PROS", decimals: 18 },
    fast: false,
    // Circle does not deliver here: a transfer in is claimed, so no delivery fee is ever signed.
    maxForwardFeeUnits: 0,
    claimCost: "a little PROS for gas, to claim it",
    standardEta: "under a minute",
  },
  arc: {
    id: "arc",
    name: "Arc",
    chainId: 5042,
    cctpDomainId: 26,
    usdcAddress: "0x3600000000000000000000000000000000000000",
    ...CIRCLE,
    rpcUrl: "https://rpc.mainnet.arc.io",
    explorerUrl: "https://explorer.arc.io",
    // Arc's gas token is USDC at 18 decimals; the ERC-20 interface above is the same money at 6.
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    fast: false,
    maxForwardFeeUnits: 100_000,
    claimCost: "well under a cent, paid in USDC",
    standardEta: "under a minute",
  },
};

export const EVM_CHAIN_IDS = Object.keys(EVM_CHAINS) as EvmChainId[];

/** The EVM chains that pair with Arc, both ways. Every EVM route has Arc at one end. */
export const EVM_ARC_PEERS = EVM_CHAIN_IDS.filter((id) => id !== "arc");

/**
 * Solana as a destination from Arc. Not an EVM chain: the recipient is a USDC token account, and
 * Circle can open it during delivery for a higher fee with its own ceiling. A copy of
 * `SOLANA_FROM_ARC` in `packages/network-config`, held to it by `evm-chains.test.ts`.
 */
export const SOLANA_FROM_ARC = {
  cctpDomainId: 5,
  maxForwardFeeUnits: 500_000,
  maxForwardFeeNewAccountUnits: 1_000_000,
} as const;

/**
 * Xebra's fee wrapper on each source chain that has one. A copy of `XEBRA_WRAPPERS` in
 * `packages/network-config`, held to it by `evm-chains.test.ts`. A transfer approves this address
 * for the whole amount, so it is never configurable at run time; `NEXT_PUBLIC_ARC_USE_WRAPPER` only
 * chooses whether a pinned one is used.
 */
export const XEBRA_WRAPPERS: Partial<Record<EvmChainId, string>> = {
  // Deployed 2026-10-15, tx 0x5a3855c72d0025f0e7848e538862abf4b4fb2888434e58db79379487e212719d.
  arc: "0x11b30470DAE40B2Fc27b7AA90dc58e6B4fE9f4c3",
};

/** The wrapper a transfer from `chain` goes through in this build, or null to call Circle directly. */
export function wrapperFor(chain: EvmChain, useWrapper: boolean): string | null {
  return useWrapper ? (XEBRA_WRAPPERS[chain.id] ?? null) : null;
}

/** What a build can switch on: an EVM chain both ways with Arc, or Solana as a place Arc sends to. */
export type PeerId = Exclude<EvmChainId, "arc"> | "solana";

/** Where a transfer from an EVM chain can land. */
export type RouteDestinationId = EvmChainId | "solana";

export const ARC_PEERS: readonly PeerId[] = [...EVM_ARC_PEERS, "solana"];

export function isEvmChainId(value: string): value is EvmChainId {
  return Object.hasOwn(EVM_CHAINS, value);
}

export function evmChainForDomain(domain: number): EvmChain | null {
  return Object.values(EVM_CHAINS).find((c) => c.cctpDomainId === domain) ?? null;
}

export function evmChainForChainId(chainId: number): EvmChain | null {
  return Object.values(EVM_CHAINS).find((c) => c.chainId === chainId) ?? null;
}

/** An EVM chain other than Arc. */
export type EvmPeerId = Exclude<EvmChainId, "arc">;

/**
 * Which routes a build offers, one direction at a time, because the two directions are proven
 * separately: Arc -> Base working says nothing about Base -> Arc, which starts on another chain
 * with another wallet. A direction is meant to be switched on once a transfer has gone through it.
 */
export interface EnabledRoutes {
  /** Where Arc may send: EVM chains, and Solana. */
  arcSendsTo: readonly PeerId[];
  /** Which EVM chains may send into Arc. */
  arcReceivesFrom: readonly EvmPeerId[];
  /**
   * EVM chains other than Arc that send to each other: every chain here reaches every other chain
   * here, over Circle's CCTP with its Forwarding Service. Arc keeps its own two switches. Absent
   * (a build from before the mesh) means none.
   */
  evmMesh?: readonly EvmPeerId[];
  /**
   * EVM chains other than Arc that send to Solana, delivered by Circle's Forwarding Service to the
   * recipient's USDC token account, as from Arc. Absent means none.
   */
  evmToSolana?: readonly EvmPeerId[];
  /**
   * EVM chains, Arc included, that send to Stellar. Circle does not deliver into Stellar: the burn
   * names Circle's Stellar forwarder, and Xebra's relayer (or the recipient) completes the mint.
   * Absent means none.
   */
  evmToStellar?: readonly EvmChainId[];
}

export const NO_ROUTES: EnabledRoutes = {
  arcSendsTo: [],
  arcReceivesFrom: [],
  evmMesh: [],
  evmToSolana: [],
  evmToStellar: [],
};

/** The mesh's chains, if there are at least two of them; one chain alone reaches nothing. */
function meshOf(routes: EnabledRoutes): readonly EvmPeerId[] {
  const mesh = routes.evmMesh ?? [];
  return mesh.length >= 2 ? mesh : [];
}

export function hasEvmRoutes(routes: EnabledRoutes): boolean {
  return (
    routes.arcSendsTo.length > 0 ||
    routes.arcReceivesFrom.length > 0 ||
    meshOf(routes).length > 0 ||
    (routes.evmToSolana?.length ?? 0) > 0 ||
    (routes.evmToStellar?.length ?? 0) > 0
  );
}

/** Where USDC can go from `source` in this build. Anything not switched on reaches nothing. */
export function evmDestinationsFrom(
  source: EvmChainId,
  routes: EnabledRoutes,
): RouteDestinationId[] {
  if (source === "arc") return ARC_PEERS.filter((id) => routes.arcSendsTo.includes(id));
  const toArc: RouteDestinationId[] = routes.arcReceivesFrom.includes(source) ? ["arc"] : [];
  const mesh = meshOf(routes);
  const peers = mesh.includes(source) ? mesh.filter((id) => id !== source) : [];
  const toSolana: RouteDestinationId[] = routes.evmToSolana?.includes(source) ? ["solana"] : [];
  return [...toArc, ...peers, ...toSolana];
}

/**
 * The EVM chains a transfer can start from in this build: each chain allowed to send into Arc,
 * and Arc itself when it may send anywhere. Solana is never a source here.
 */
export function evmSources(routes: EnabledRoutes): EvmChainId[] {
  const mesh = meshOf(routes);
  const peers = EVM_ARC_PEERS.filter(
    (id) =>
      routes.arcReceivesFrom.includes(id) ||
      mesh.includes(id) ||
      (routes.evmToSolana?.includes(id) ?? false) ||
      (routes.evmToStellar?.includes(id) ?? false),
  );
  const arcSends = routes.arcSendsTo.length > 0 || (routes.evmToStellar?.includes("arc") ?? false);
  return arcSends ? [...peers, "arc"] : peers;
}

/**
 * Reads one route list: comma-separated chain names, or `all`. Absent or empty means none.
 *
 * A name that is not allowed in this list throws. A typo here must fail the build, not quietly
 * leave a route off, and certainly not switch on something nobody named.
 */
function parseRouteList<T extends string>(
  label: string,
  raw: string | null | undefined,
  allowed: readonly T[],
): T[] {
  const value = (raw ?? "").trim();
  if (value === "") return [];
  if (value === "all") return [...allowed];
  const names = value.split(",").map((s) => s.trim());
  for (const name of names) {
    if (!(allowed as readonly string[]).includes(name)) {
      throw new Error(`${label} names "${name}", which is not one of: ${allowed.join(", ")}, all`);
    }
  }
  return allowed.filter((id) => names.includes(id));
}

/**
 * `NEXT_PUBLIC_EVM_MESH`: EVM chains other than Arc that send to each other, every one to every
 * other. Arc and Solana have their own switches and are refused here.
 */
export function parseEvmMesh(raw: string | null | undefined): EvmPeerId[] {
  return parseRouteList("mesh list", raw, EVM_ARC_PEERS);
}

/**
 * `NEXT_PUBLIC_EVM_TO_SOLANA`: EVM chains other than Arc that send to Solana (Arc has its own
 * switch, `NEXT_PUBLIC_ARC_SENDS_TO`).
 */
export function parseEvmToSolana(raw: string | null | undefined): EvmPeerId[] {
  return parseRouteList("NEXT_PUBLIC_EVM_TO_SOLANA", raw, EVM_ARC_PEERS);
}

/**
 * `NEXT_PUBLIC_EVM_TO_STELLAR`: EVM chains, Arc included, that send to Stellar (completed by Xebra's
 * relayer). `evmDestinationsFrom` does not list Stellar; callers add it from this list.
 */
export function parseEvmToStellar(raw: string | null | undefined): EvmChainId[] {
  return parseRouteList("NEXT_PUBLIC_EVM_TO_STELLAR", raw, EVM_CHAIN_IDS);
}

/** Whether `source` may send to Stellar in this build. */
export function evmSendsToStellar(source: EvmChainId, routes: EnabledRoutes): boolean {
  return routes.evmToStellar?.includes(source) ?? false;
}

/** `NEXT_PUBLIC_ARC_SENDS_TO`: where Arc may send. EVM chains and `solana`. */
export function parseArcSendsTo(raw: string | null | undefined): PeerId[] {
  return parseRouteList("Arc sends-to list", raw, ARC_PEERS);
}

/** `NEXT_PUBLIC_ARC_RECEIVES_FROM`: which EVM chains may send into Arc. */
export function parseArcReceivesFrom(raw: string | null | undefined): EvmPeerId[] {
  return parseRouteList("Arc receives-from list", raw, EVM_ARC_PEERS);
}

/**
 * `NEXT_PUBLIC_STELLAR_SENDS_TO`: which EVM chains other than Arc Stellar may send to, through the
 * wrapper. Arc keeps its own switch (`NEXT_PUBLIC_ARC_ENABLED`) and Solana is always offered.
 */
export function parseStellarSendsTo(raw: string | null | undefined): EvmPeerId[] {
  return parseRouteList("Stellar sends-to list", raw, EVM_ARC_PEERS);
}

export const explorerTxUrl = (chain: EvmChain, hash: string) => `${chain.explorerUrl}/tx/${hash}`;
