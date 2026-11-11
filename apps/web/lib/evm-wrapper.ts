import type { WrapperTerms } from "@xebra/sdk/core";

/**
 * Xebra's fee wrapper on an EVM chain, as the page needs it: the contract's live settings, read
 * through `/api/evm-wrapper` (which refuses a wrapper not pointed at Circle's pinned contracts), and
 * narrowed to one destination for `planWrapperFee`.
 */

/** What `/api/evm-wrapper` answers: amounts as decimal strings, since JSON has no bigint. */
export interface WrapperState {
  address: string;
  paused: boolean;
  params: {
    feeBps: number;
    minFee: string;
    minTransfer: string;
    maxTransfer: string;
    maxFastFeeBps: number;
  };
  domains: Array<{
    domain: number;
    evmStyle: boolean;
    maxForwardFee: string;
    accountCreation: boolean;
    maxForwardFeeNewAccount: string;
  }>;
}

export interface WrapperSettings {
  address: string;
  paused: boolean;
  feeBps: number;
  minFee: bigint;
  minTransfer: bigint;
  maxTransfer: bigint;
  maxFastFeeBps: number;
  domains: Map<number, NonNullable<WrapperTerms["domain"]>>;
}

/**
 * The wrapper's settings on the chain with this CCTP domain. Null when they could not be read:
 * that is not "no fee", and the page must not offer a transfer it cannot price.
 */
export async function getWrapperSettings(sourceDomain: number): Promise<WrapperSettings | null> {
  try {
    const res = await fetch(`/api/evm-wrapper?src=${sourceDomain}`);
    if (!res.ok) return null;
    return parseWrapperState((await res.json()) as WrapperState);
  } catch {
    return null;
  }
}

export function parseWrapperState(state: WrapperState): WrapperSettings {
  return {
    address: state.address,
    paused: state.paused,
    feeBps: state.params.feeBps,
    minFee: BigInt(state.params.minFee),
    minTransfer: BigInt(state.params.minTransfer),
    maxTransfer: BigInt(state.params.maxTransfer),
    maxFastFeeBps: state.params.maxFastFeeBps,
    domains: new Map(
      state.domains.map((d) => [
        d.domain,
        {
          maxForwardFee: BigInt(d.maxForwardFee),
          accountCreation: d.accountCreation,
          maxForwardFeeNewAccount: BigInt(d.maxForwardFeeNewAccount),
        },
      ]),
    ),
  };
}

/** The settings that price a transfer to one destination. */
export function termsFor(settings: WrapperSettings, destinationDomain: number): WrapperTerms {
  return {
    paused: settings.paused,
    feeBps: settings.feeBps,
    minFee: settings.minFee,
    minTransfer: settings.minTransfer,
    maxTransfer: settings.maxTransfer,
    maxFastFeeBps: settings.maxFastFeeBps,
    domain: settings.domains.get(destinationDomain) ?? null,
  };
}
