import type { CircleHealth } from "@xebra/cctp-client";
import type { StellarBuildRpc, TransferStep } from "@xebra/sdk/build";
import type {
  Destination,
  DomainForwardConfig,
  EnabledRoutes,
  EvmChain,
  FeeParams,
} from "@xebra/sdk/core";

/**
 * Everything the service layer reads from the outside world. The real wiring is
 * `lib/api/wiring.ts`; tests pass fakes, so the logic in `service.ts` is tested without a network.
 */

export interface StellarRoutes {
  /** What the bridge page would offer for a send from Stellar right now. */
  destinations: Destination[];
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
  /** Circle's account of a burn, as `/api/delivery` answers it. */
  delivery(tx: string, srcDomain: number): Promise<Record<string, unknown> | null>;
  /** Sui to Stellar: switched on, and the per-transfer cap in 6-decimal units (null: none). */
  suiStellar: { enabled: boolean; maxUnits: bigint | null };
  /** A Sui burn's progress, as `/api/sui-stellar/status` answers it. Null if unreadable. */
  suiStatus?(digest: string): Promise<Record<string, unknown> | null>;
  /** What building a transaction reads. Absent where nothing is built (the MCP tools). */
  build?: BuildDeps;
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
  /** Whether EVM sources send through Xebra's wrapper (the page's `NEXT_PUBLIC_ARC_USE_WRAPPER`). */
  evmWrapperOn: boolean;
  /** The Sui burn, built against the Sui node. Throws `InsufficientUsdcError` when short. */
  suiBurn(p: { sender: string; amount: bigint; stellarRecipient: string }): Promise<TransferStep>;
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
    | { state: "ready"; setup: string | null; mint: string }
    | { state: "needs-owner"; reason: string }
    | { state: "delivered" }
  >;
  /** The Stellar mint of a Sui burn, with `payer` paying the fee. */
  suiClaim(
    digest: string,
    payer: string,
  ): Promise<{ ok: true; xdr: string } | { ok: false; reason: string; delivered?: boolean }>;
}
