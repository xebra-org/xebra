import type { CircleHealth } from "@xebra/cctp-client";
import type { Destination, DomainForwardConfig, EnabledRoutes, FeeParams } from "@xebra/sdk/core";

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
  circle(src: number, dst: number): Promise<CircleHealth | null>;
  /** The wrapper's fee and floor. Null if unreadable. */
  feeParams(): Promise<FeeParams | null>;
  /** Circle's account of a burn, as `/api/delivery` answers it. */
  delivery(tx: string, srcDomain: number): Promise<Record<string, unknown> | null>;
  /** Sui to Stellar: switched on, and the per-transfer cap in 6-decimal units (null: none). */
  suiStellar: { enabled: boolean; maxUnits: bigint | null };
}
