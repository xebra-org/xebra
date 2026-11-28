import type { CircleHealth } from "@xebra/cctp-client";
import type { StellarBuildRpc, SuiForwardRecipient, TransferStep } from "@xebra/sdk/build";
import type {
  DeliveredDestination,
  DomainForwardConfig,
  EnabledRoutes,
  EvmChain,
  EvmChainId,
  FeeParams,
  FeeRule,
} from "@xebra/sdk/core";
import type { AptosBuildAnswer } from "../aptos/build";
import type { AptosDestination } from "../aptos/config";
import type { WrapperSettings } from "../evm-wrapper";

/**
 * Everything the service layer reads from the outside world. The real wiring is
 * `lib/api/wiring.ts`; tests pass fakes, so the logic in `service.ts` is tested without a network.
 */

export interface StellarRoutes {
  /**
   * What the bridge page would offer for a send from Stellar right now, less Sui: the API only
   * builds transfers Circle delivers, and Sui is claimed at `/claim`.
   */
  destinations: DeliveredDestination[];
  /** The wrapper's committed domains, or null when the contract could not be read. */
  domains: Map<number, DomainForwardConfig> | null;
}

export interface Deps {
  siteUrl: string;
  evmRoutes: EnabledRoutes;
  stellarRoutes(): Promise<StellarRoutes>;
  /** Circle's quote and health for a route, as `/api/circle-health` answers it. Null if unreadable. */
  circle(src: number, dst: number, newAccount?: boolean): Promise<CircleHealth | null>;
  /** The wrapper's fee and floor. Null if unreadable. */
  feeParams(): Promise<FeeParams | null>;
  /**
   * Xebra's fee wrapper on an EVM chain, when this build sends through it there: its address, or
   * null to call Circle directly. Absent means no EVM wrapper anywhere.
   */
  evmWrapperAddress?(chain: EvmChain): string | null;
  /** That wrapper's live settings, read from the chain. Null when they could not be read. */
  evmWrapperSettings?(chain: EvmChain): Promise<WrapperSettings | null>;
  /** Circle's account of a burn, as `/api/delivery` answers it. */
  delivery(tx: string, srcDomain: number): Promise<Record<string, unknown> | null>;
  /**
   * Sui as a source: switched on, the per-transfer cap in 6-decimal units (null: none), and where
   * else than Stellar it sends through Circle's Forwarding Service (`SUI_SENDS_TO_EVM`,
   * `SUI_SENDS_TO_SOLANA`). Absent `sendsTo` means Stellar only.
   */
  suiStellar: {
    enabled: boolean;
    maxUnits: bigint | null;
    sendsTo?: ReadonlyArray<EvmChainId | "solana">;
  };
  /** A Sui burn's progress, as `/api/sui-stellar/status` answers it. Null if unreadable. */
  suiStatus?(digest: string): Promise<Record<string, unknown> | null>;
  /**
   * Hand an attested Sui burn to Stellar to the relayer, as `/api/sui-stellar/complete` does for
   * the `/sui` page. Idempotent: the relayer re-reads the mint before it sends. Answers the
   * relayer's word (`delivered`, `submitted` with a `hash`, `pending`, `refused` with a `reason`,
   * `failed`, `unavailable`), or `scheduled` while a run started by this call is still going. Null
   * if unreadable. Absent: nothing relays, and an attested burn reads as `needs_claim`.
   */
  suiRelay?(digest: string): Promise<Record<string, unknown> | null>;
  /**
   * Where Solana may send (`SOLANA_SENDS_TO`): EVM chains, delivered by Circle's Forwarding Service,
   * and Stellar, completed by the relayer. Absent or empty: Solana is not a source.
   */
  solanaSource?: { evm: EvmChainId[]; stellar: boolean; maxUnits: bigint | null };
  /** A Solana burn into Stellar, as `/api/solana-source/status` answers it. Null if unreadable. */
  solanaStellarStatus?(tx: string): Promise<Record<string, unknown> | null>;
  /**
   * Aptos as a source: where it may send (`APTOS_SENDS_TO`) and the per-transfer cap. Absent or
   * empty means Aptos is off.
   */
  aptos?: { destinations: readonly AptosDestination[]; maxUnits: bigint | null };
  /**
   * A burn into Stellar from any source the relayer accepts, as `/api/stellar-inbound/status`
   * answers it. Null if unreadable.
   */
  stellarInboundStatus?(tx: string, srcDomain: number): Promise<Record<string, unknown> | null>;
  /** An Aptos burn to Stellar's progress, as `/api/aptos/status` answers it. Null if unreadable. */
  aptosStatus?(tx: string): Promise<Record<string, unknown> | null>;
  /** What building a transaction reads. Absent where nothing is built (the MCP tools). */
  build?: BuildDeps;
  /**
   * Xebra's fee addresses, one per source family, where the flat fee is paid on routes without a
   * Xebra contract. A null entry turns that family's routes off; absent, no flat fee is charged
   * (tests of the older figures only: production always sets it).
   */
  /**
   * The fee table off-contract routes are priced from. Absent: `FEE_TABLE`, which names no
   * market-maker key. Production adds the market-maker price for the keys named in
   * `XEBRA_REBALANCE_KEY_IDS` (`lib/server/fee-table.ts`).
   */
  feeTable?: readonly FeeRule[];
  feeAddresses?: {
    evm: string | null;
    solana: string | null;
    sui: string | null;
    aptos: string | null;
  };
  /**
   * Hyperliquid (HyperCore) as a source (`NEXT_PUBLIC_HYPERLIQUID_SOURCE`). Absent: off. Live
   * wiring in `lib/hyperliquid/live.ts`.
   */
  hyperliquid?: HyperliquidDeps;
}

/** What a withdrawal from Hyperliquid reads. Nothing here signs or sends. */
export interface HyperliquidDeps {
  /**
   * Xebra's fee address on HyperCore (`XEBRA_FEE_ADDRESS_HYPERCORE`). Null turns the route off:
   * it is never served free.
   */
  feeAddress: string | null;
  /** The most one withdrawal may move, 6-decimal units, or null for no cap. */
  maxUnits: bigint | null;
  /**
   * What Circle's `CoreDepositWallet` keeps to deliver a forwarded withdrawal to `domain`
   * (`calculateCrossChainWithdrawalFee(true, domain)`), `"paused"` when Circle has paused the
   * contract, or null when it could not be read.
   */
  forwardFee(domain: number): Promise<bigint | "paused" | null>;
  /**
   * The account's withdrawable USDC on HyperCore (perps `withdrawable`, spot USDC less holds) and
   * whether it has ever sent anything (Hyperliquid charges 1 USDC on an account's first outbound
   * action). Null when it could not be read.
   */
  account(user: string): Promise<{ perps: bigint; spot: bigint; activated: boolean } | null>;
  /**
   * Hyperliquid's activation fee for `from` sending to `address` (`preTransferCheck`): 0 once
   * `address` exists on HyperCore. Null when it could not be read.
   */
  activationFeeTo(address: string, from: string): Promise<bigint | null>;
  /**
   * Circle's burn of a withdrawal on HyperEVM, found by its signer and nonce from the
   * `CrossChainWithdraw` event, `"not_found"` while Hyperliquid has not handed it over, or null
   * when HyperEVM could not be read.
   */
  findBurn(user: string, nonce: number): Promise<{ txHash: string } | "not_found" | null>;
}

export interface BuildDeps {
  /** The Soroban RPC builds simulate against, and the wrapper they call. */
  stellarRpc(): StellarBuildRpc;
  stellarWrapper: { wrapperContractId: string; networkPassphrase: string } | null;
  /** A Stellar account: whether it exists, has a USDC trustline, and its USDC in stroops. */
  stellarAccount(
    address: string,
  ): Promise<{ exists: boolean; hasTrustline: boolean; balance: bigint }>;
  /** A Solana wallet's USDC token account and whether it exists yet. */
  solanaRecipient(
    owner: string,
  ): Promise<{ tokenAccount: string; status: "exists" | "missing" | "unknown" }>;
  /** USDC balance and allowance on an EVM chain, 6-decimal units. */
  evmUsdc(
    chain: EvmChain,
    owner: string,
    spender: string,
  ): Promise<{ balance: bigint; allowance: bigint }>;
  /**
   * Whether EVM sources send through Xebra's wrapper (the page's `NEXT_PUBLIC_ARC_USE_WRAPPER`).
   * Informational: which chains have one, and its terms, come from `Deps.evmWrapperAddress`.
   */
  evmWrapperOn: boolean;
  /** The Sui burn, built against the Sui node. Throws `InsufficientUsdcError` when short. */
  suiBurn(p: {
    sender: string;
    amount: bigint;
    stellarRecipient: string;
    /** Xebra's flat fee, paid in the same transaction. */
    fee?: { address: string; amount: bigint } | undefined;
  }): Promise<TransferStep>;
  /**
   * A Sui burn Circle's Forwarding Service delivers (to an EVM chain or Solana), built against the
   * Sui node. Throws `InsufficientUsdcError` when short.
   */
  suiForwardBurn(p: {
    sender: string;
    amount: bigint;
    recipient: SuiForwardRecipient;
    destinationDomain: number;
    maxFee: bigint;
    destinationName: string;
    fee?: { address: string; amount: bigint } | undefined;
  }): Promise<TransferStep>;
  /** Circle's message and attestation for a burn, as `/api/attestation` answers it. */
  attestation(tx: string, srcDomain: number): Promise<Record<string, unknown> | null>;
  /** Whether the mint on an EVM chain is still open, and would succeed sent by `payer`. */
  evmClaimCheck(
    chain: EvmChain,
    payer: string,
    message: `0x${string}`,
    attestation: `0x${string}`,
  ): Promise<{ state: "open" | "delivered" | "expired" } | { state: "refused"; reason: string }>;
  /** The Solana mint, and opening the recipient's account first when it is missing. */
  solanaClaim(input: {
    message: string;
    attestation: string;
    usdcMint: string;
    sourceDomainId: number;
    payer: string;
    recipientOwner?: string;
  }): Promise<
    | { state: "ready"; setup: string | null; mint: string | null }
    | { state: "needs-owner"; reason: string }
    | { state: "delivered" }
  >;
  /**
   * The Solana burn, built and simulated against Solana's RPC: to an EVM chain at the `maxFee`
   * priced, or to Stellar with none. Throws `ApiError` for every refusal a person can act on.
   */
  solanaBurn?(p: {
    sender: string;
    amount: bigint;
    to: "stellar" | EvmChainId;
    recipient: string;
    maxFee: bigint;
    /** Xebra's flat fee, to `owner`'s USDC account in the same transaction. */
    fee?: { owner: string; amount: bigint };
  }): Promise<TransferStep>;
  /** The Stellar mint of a Solana burn into Stellar, with `payer` paying the fee. */
  solanaStellarClaim?(
    tx: string,
    payer: string,
  ): Promise<{ ok: true; xdr: string } | { ok: false; reason: string; delivered?: boolean }>;
  /**
   * The Aptos burn, built and checked as `/api/aptos/build` builds it (the fee priced again; the
   * burn simulated on mainnet). Absent where Aptos is off.
   */
  aptosBuild?(request: {
    sender: string;
    amount: string;
    to: string;
    recipient: string;
    maxFee?: string;
  }): Promise<AptosBuildAnswer>;
  /** The Stellar mint of an Aptos burn to Stellar, with `payer` paying the fee. */
  aptosClaim?(
    tx: string,
    payer: string,
  ): Promise<{ ok: true; xdr: string } | { ok: false; reason: string; delivered?: boolean }>;
  /** The Stellar mint of a burn from an EVM chain into Stellar, with `payer` paying the fee. */
  stellarInboundClaim?(
    tx: string,
    payer: string,
    srcDomain: number,
  ): Promise<{ ok: true; xdr: string } | { ok: false; reason: string; delivered?: boolean }>;
  /** The Stellar mint of a Sui burn, with `payer` paying the fee. */
  suiClaim(
    digest: string,
    payer: string,
  ): Promise<{ ok: true; xdr: string } | { ok: false; reason: string; delivered?: boolean }>;
}
