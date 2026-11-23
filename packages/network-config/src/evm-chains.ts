import { CCTP_DOMAIN, PRESETS } from "./networks.js";

/**
 * The EVM chains USDC moves between over CCTP without a Xebra contract in the path, and the one
 * non-EVM chain, Solana, that Arc sends to the same way.
 *
 * On these routes the browser calls Circle's `TokenMessengerV2` directly, so there is no wrapper
 * to bound a fee, fix the hook or refuse a domain. Everything a transfer rests on is in this
 * table instead, which is why it is pinned by a test and re-read from the chains by
 * `scripts/check-evm-cctp.sh`.
 *
 * # Which chains
 *
 * Circle's Forwarding Service delivers from Arc to domains 0, 1, 2, 3, 5, 6, 7, 10, 11, 12, 13, 14,
 * 15, 16, 18, 19, 21, 22 and 28, as Iris answered on 2026-10-14
 * (`GET /v2/burn/USDC/fees/26/{d}?forward=true`), and refuses every other domain. All of those are
 * here except four, left out on purpose:
 *
 * - Ethereum (0): delivery there costs about 1.4 USDC, so the smallest sensible transfer is about
 *   fifteen dollars.
 * - Linea (11): a Standard transfer from Linea takes 6 to 32 hours.
 * - Plume (22) and EDGE (28): Circle publishes no Standard timing for either, and EDGE runs its own
 *   deployment of Circle's contracts with an explorer we could not reach.
 *
 * Each EVM chain here also forwards *into* Arc, so they are offered both ways. Solana is a
 * destination only: sending from Solana needs a Solana signer, which these routes do not have.
 *
 * # Provenance
 *
 * Read from the live chains with `cast`, not from documentation (2026-10-09 and 2026-10-14):
 *
 * - Arc's `TokenMessengerV2.remoteTokenMessengers(d)` names each chain's messenger. On every chain
 *   here it is the same address as Arc's, and so are the transmitter and minter. That is
 *   convenient and also the hazard: a call made on the wrong chain reaches a real Circle contract
 *   and returns a plausible answer. Not every Circle chain shares them (EDGE does not), so each
 *   row still names its own three.
 * - Domain ids are each chain's `MessageTransmitterV2.localDomain()`.
 * - Each chain's `TokenMinterV2.getLocalToken(26, <Arc USDC>)` returns its USDC, and Arc's maps
 *   it back. Every one is a 6-decimal token whose symbol is `USDC`.
 *
 * `rpcUrl` is a public endpoint used for two things only: handing a wallet a chain it has never
 * seen (`wallet_addEthereumChain`) and the read-only check script. No transfer is read or sent
 * through it; the wallet's own node does that.
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
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /**
   * Whether Circle offers Fast Transfer for burns made on this chain: where Iris prices the 1000
   * row above zero. Where finality is already quick there is nothing to speed up.
   */
  fast: boolean;
  /**
   * The most Circle may be paid to deliver a transfer *into* this chain, in 6-decimal units.
   * Circle keeps the whole `maxFee`, so this is the ceiling on what a bad quote can cost.
   */
  maxForwardFeeUnits: number;
  /** What claiming by hand costs here, said plainly. */
  claimCost: string;
  /**
   * How long a Standard burn made here takes to be attested. Circle's published figures where we
   * could read them (Ink, Codex, Monad, HyperEVM); the rest by the kind of chain (an Ethereum
   * rollup waits for Ethereum, the others finalise in seconds). Replace with what
   * `scripts/test-evm-arc-forwarding-mainnet.sh` measures.
   */
  standardEta: string;
}

/** Circle's three contracts, at the one address they have on every chain here. */
const CIRCLE = {
  tokenMessengerAddress: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  messageTransmitterAddress: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  tokenMinterAddress: "0xfd78EE919681417d192449715b2594ab58f5D002",
} as const;

const ETH = { name: "Ether", symbol: "ETH", decimals: 18 } as const;

const arc = PRESETS.mainnet.arc;

export const EVM_CHAINS: Record<EvmChainId, EvmChain> = {
  avalanche: {
    id: "avalanche",
    name: "Avalanche",
    chainId: 43114,
    cctpDomainId: CCTP_DOMAIN.avalanche,
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
    cctpDomainId: CCTP_DOMAIN.optimism,
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
    cctpDomainId: CCTP_DOMAIN.arbitrum,
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
    cctpDomainId: CCTP_DOMAIN.base,
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
    cctpDomainId: CCTP_DOMAIN.polygon,
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
    cctpDomainId: CCTP_DOMAIN.unichain,
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
    cctpDomainId: CCTP_DOMAIN.codex,
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
    cctpDomainId: CCTP_DOMAIN.sonic,
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
    cctpDomainId: CCTP_DOMAIN.worldchain,
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
    cctpDomainId: CCTP_DOMAIN.monad,
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
    cctpDomainId: CCTP_DOMAIN.sei,
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
    cctpDomainId: CCTP_DOMAIN.xdc,
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
    cctpDomainId: CCTP_DOMAIN.hyperevm,
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
    cctpDomainId: CCTP_DOMAIN.ink,
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
  // Built from the preset, so Arc has one source of truth however it is reached.
  ethereum: {
    id: "ethereum",
    name: "Ethereum",
    chainId: 1,
    cctpDomainId: CCTP_DOMAIN.ethereum,
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
    cctpDomainId: CCTP_DOMAIN.linea,
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
    cctpDomainId: CCTP_DOMAIN.plume,
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
    cctpDomainId: CCTP_DOMAIN.edge,
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
    cctpDomainId: CCTP_DOMAIN.cronos,
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
    cctpDomainId: CCTP_DOMAIN.plasma,
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
    cctpDomainId: CCTP_DOMAIN.xlayer,
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
    cctpDomainId: CCTP_DOMAIN.injective,
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
    cctpDomainId: CCTP_DOMAIN.morph,
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
    cctpDomainId: CCTP_DOMAIN.pharos,
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
    chainId: arc.chainId,
    cctpDomainId: arc.cctpDomainId,
    usdcAddress: arc.usdcAddress,
    tokenMessengerAddress: arc.tokenMessengerAddress,
    messageTransmitterAddress: arc.messageTransmitterAddress,
    tokenMinterAddress: CIRCLE.tokenMinterAddress,
    rpcUrl: arc.rpcUrl,
    explorerUrl: arc.explorerUrl,
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
 * Solana as a destination from Arc. Not an EVM chain, so not in the table above: the recipient is
 * a USDC token account, and Circle can open it during delivery (the 65-byte hook) for a higher fee
 * that has its own ceiling.
 */
export const SOLANA_FROM_ARC = {
  cctpDomainId: CCTP_DOMAIN.solana,
  maxForwardFeeUnits: 500_000,
  maxForwardFeeNewAccountUnits: 1_000_000,
} as const;

/**
 * Xebra's fee wrapper (`contracts/arc-evm`, `XebraCctpWrapper`) on each source chain that has one.
 *
 * Pinned like Circle's addresses, because a transfer approves it for the whole amount: an address
 * here changes only by a commit, after `scripts/deploy-arc-wrapper.sh` has recorded the deployment
 * in `deployments/mainnet.json` (a test holds the two together).
 */
export const XEBRA_WRAPPERS: Partial<Record<EvmChainId, string>> = {
  // Deployed 2026-10-15, tx 0x5a3855c72d0025f0e7848e538862abf4b4fb2888434e58db79379487e212719d.
  arc: "0x11b30470DAE40B2Fc27b7AA90dc58e6B4fE9f4c3",
};

export interface EvmRoute {
  from: EvmChainId;
  to: EvmChainId;
}

/** Each peer to Arc, and Arc to each peer. Nothing else between EVM chains is offered. */
export const EVM_ROUTES: EvmRoute[] = EVM_ARC_PEERS.flatMap((peer) => [
  { from: peer, to: "arc" as const },
  { from: "arc" as const, to: peer },
]);

export function evmChainForDomain(domain: number): EvmChain | null {
  return Object.values(EVM_CHAINS).find((c) => c.cctpDomainId === domain) ?? null;
}

export function isEvmRoute(sourceDomain: number, destinationDomain: number): boolean {
  return EVM_ROUTES.some(
    (r) =>
      EVM_CHAINS[r.from].cctpDomainId === sourceDomain &&
      EVM_CHAINS[r.to].cctpDomainId === destinationDomain,
  );
}

/** Arc to Solana, the one route here whose destination is not an EVM chain. */
export function isArcToSolana(sourceDomain: number, destinationDomain: number): boolean {
  return (
    sourceDomain === EVM_CHAINS.arc.cctpDomainId &&
    destinationDomain === SOLANA_FROM_ARC.cctpDomainId
  );
}
