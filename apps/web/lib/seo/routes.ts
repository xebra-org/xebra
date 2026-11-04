import { stellarDestinations } from "../destinations";
import {
  EVM_CHAINS,
  EVM_CHAIN_IDS,
  type EnabledRoutes,
  type EvmChainId,
  type EvmPeerId,
  SOLANA_FROM_ARC,
  XEBRA_WRAPPERS,
  evmDestinationsFrom,
  evmSources,
} from "../evm-chains";
import type { DomainForwardConfig } from "../forward-fee";
import { RECORDED_STELLAR_CAPS } from "./facts";

/**
 * The routes the site has a page for, and the facts each page states.
 *
 * A route page is a promise that the bridge sends that way, so the list is the bridge's own: the
 * routes around Arc that this build switches on (`NEXT_PUBLIC_ARC_SENDS_TO`/`_RECEIVES_FROM`), and
 * Stellar's, which are Solana, Arc, and each EVM chain the wrapper has committed. That last part is
 * read from the contract, so a Stellar chain gets its page when its 48-hour proposal is committed
 * and never before.
 */

export type Endpoint = "stellar" | "solana" | EvmChainId;

export interface RouteInfo {
  /** `stellar-to-solana`: the page's path segment. */
  slug: string;
  from: Endpoint;
  to: Endpoint;
  /** Through Xebra's Stellar wrapper, Xebra's EVM wrapper, or straight to Circle. */
  via: "stellar-wrapper" | "evm-wrapper" | "circle";
  /** The most Circle may be paid to deliver, in USDC units (6 decimals). */
  deliveryCapUnits: number;
  /** The same when Circle also opens the recipient's Solana account; null where not offered. */
  deliveryCapNewAccountUnits: number | null;
}

export const ENDPOINT_NAMES: Record<Endpoint, string> = {
  stellar: "Stellar",
  solana: "Solana",
  ...(Object.fromEntries(EVM_CHAIN_IDS.map((id) => [id, EVM_CHAINS[id].name])) as Record<
    EvmChainId,
    string
  >),
};

export const routeSlug = (from: Endpoint, to: Endpoint) => `${from}-to-${to}`;

/** 7-decimal stroops, as the Stellar wrapper stores amounts, to 6-decimal USDC units. */
const stroopsToUnits = (stroops: bigint) => Number(stroops / 10n);

/** What this build switches on: the flags `offeredRoutes` reads, passed in so it stays testable. */
export interface SiteFlags {
  arcEnabled: boolean;
  stellarSendsTo: readonly EvmPeerId[];
  evmRoutes: EnabledRoutes;
  /** Transfers out of a chain with a pinned wrapper go through it (`NEXT_PUBLIC_ARC_USE_WRAPPER`). */
  useWrapper: boolean;
}

/** Every route this build offers, given the Stellar wrapper's committed domains (or null). */
export function offeredRoutes(
  stellarDomains: Map<number, DomainForwardConfig> | null,
  flags: SiteFlags,
): RouteInfo[] {
  const routes: RouteInfo[] = [];

  const committed = stellarDomains ? new Set(stellarDomains.keys()) : null;
  for (const d of stellarDestinations({
    arcEnabled: flags.arcEnabled,
    sendsTo: flags.stellarSendsTo,
    committed,
  })) {
    const live = stellarDomains?.get(d.domain);
    const recorded = RECORDED_STELLAR_CAPS[d.domain];
    if (live && !live.forward) continue;
    const cap = live ? stroopsToUnits(live.maxForwardFee) : recorded?.cap;
    if (cap === undefined) continue;
    const newAccount = live
      ? live.accountCreation
        ? stroopsToUnits(live.maxForwardFeeNewAccount)
        : null
      : (recorded?.newAccount ?? null);
    routes.push({
      slug: routeSlug("stellar", d.id),
      from: "stellar",
      to: d.id,
      via: "stellar-wrapper",
      deliveryCapUnits: cap,
      deliveryCapNewAccountUnits: newAccount,
    });
  }

  for (const source of evmSources(flags.evmRoutes)) {
    const viaWrapper = flags.useWrapper && Boolean(XEBRA_WRAPPERS[source]);
    for (const to of evmDestinationsFrom(source, flags.evmRoutes)) {
      const toSolana = to === "solana";
      routes.push({
        slug: routeSlug(source, to),
        from: source,
        to,
        via: viaWrapper ? "evm-wrapper" : "circle",
        deliveryCapUnits: toSolana
          ? SOLANA_FROM_ARC.maxForwardFeeUnits
          : EVM_CHAINS[to].maxForwardFeeUnits,
        deliveryCapNewAccountUnits: toSolana ? SOLANA_FROM_ARC.maxForwardFeeNewAccountUnits : null,
      });
    }
  }
  return routes;
}

/**
 * Every route that could ever get a page, whatever this build offers: Stellar to Solana, Arc and
 * the EVM chains; Arc to the EVM chains and Solana; the EVM chains to Arc. Image routes are built
 * for all of them, so a route that switches on later already has its preview.
 */
export function candidateSlugs(): string[] {
  const evm = EVM_CHAIN_IDS.filter((id) => id !== "arc");
  return [
    routeSlug("stellar", "solana"),
    routeSlug("stellar", "arc"),
    ...evm.map((id) => routeSlug("stellar", id)),
    ...evm.map((id) => routeSlug("arc", id)),
    routeSlug("arc", "solana"),
    ...evm.map((id) => routeSlug(id, "arc")),
  ];
}

/** Parses a slug back into its two ends, or null if it names no candidate route. */
export function parseSlug(slug: string): { from: Endpoint; to: Endpoint } | null {
  if (!candidateSlugs().includes(slug)) return null;
  const [from, to] = slug.split("-to-") as [Endpoint, Endpoint];
  return { from, to };
}
