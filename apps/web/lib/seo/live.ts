import { cache } from "react";
import { getWrapperDomains } from "../cctp-bridge";
import { env } from "../env";
import { XEBRA_WRAPPERS } from "../evm-chains";
import type { DomainForwardConfig } from "../forward-fee";
import { type Doc, buildDocs } from "./docs";
import { type Faq, faqFor } from "./faq";
import { type SiteFlags, offeredRoutes } from "./routes";

/**
 * The written pages as this deployment serves them: this build's flags, and the Stellar wrapper's
 * destinations read from the contract. Server-only; the builders it feeds are pure.
 */

export const SITE_FLAGS: SiteFlags = {
  arcEnabled: env.arcEnabled,
  stellarSendsTo: env.stellarSendsTo,
  evmRoutes: env.evmRoutes,
  useWrapper: env.arcUseWrapper,
};

/** Whether transfers out of Arc go through Xebra's contract (and pay its fee) in this build. */
export const ARC_VIA_WRAPPER = env.arcUseWrapper && Boolean(XEBRA_WRAPPERS.arc);

/**
 * The Stellar wrapper's committed destinations and their caps. Null when the contract could not be
 * read in time: the pages then offer only Solana and Arc, whose caps are on record.
 */
export async function readStellarDomains(): Promise<Map<number, DomainForwardConfig> | null> {
  if (!env.cctpWrapperContractId) return null;
  try {
    return await Promise.race([
      getWrapperDomains({
        wrapperContractId: env.cctpWrapperContractId,
        sorobanRpcUrl: env.sorobanRpcUrl,
        networkPassphrase: env.stellarNetworkPassphrase,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
    ]);
  } catch {
    return null;
  }
}

/** Every page, cached per render pass so a page, its metadata and its JSON-LD read the contract once. */
export const getDocs = cache(async (): Promise<Doc[]> => {
  const routes = offeredRoutes(await readStellarDomains(), SITE_FLAGS);
  return buildDocs(routes, ARC_VIA_WRAPPER);
});

export async function getDoc(path: string): Promise<Doc | undefined> {
  return (await getDocs()).find((d) => d.path === path);
}

export function siteFaq(): Faq[] {
  return faqFor(ARC_VIA_WRAPPER);
}
