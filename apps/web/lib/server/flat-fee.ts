import { type FlatFeeKind, flatFeeFor, flatFeeKind } from "@xebra/sdk/core";
import { type FeeAddresses, parseFeeAddresses } from "../fee-addresses";

/**
 * Xebra's flat fee for the page's own build routes (`/api/solana-source/build`, `/api/sui-*`,
 * `/api/aptos/build`), decided on the server so a page cannot leave it out. The same figures as
 * `/v1` (`lib/api/service.ts`): the amount a person enters is what leaves the wallet, the burn is
 * the rest.
 */
export class FeeAddressMissing extends Error {
  readonly status = 503;
  constructor(family: keyof FeeAddresses) {
    super(
      `Transfers from ${NAMES[family]} are off for now: Xebra's fee address there is not set up.`,
    );
    this.name = "FeeAddressMissing";
  }
}

const NAMES: Record<keyof FeeAddresses, string> = {
  evm: "EVM chains",
  solana: "Solana",
  sui: "Sui",
  aptos: "Aptos",
};

export interface FlatFee {
  fee: bigint;
  address: string;
  kind: FlatFeeKind;
}

export function flatFeeOn(
  family: keyof FeeAddresses,
  destinationDomain: number,
  /** What leaves the wallet, the amount the person entered; Xebra's fee includes 0.01% of it. */
  amount: bigint,
  addresses: FeeAddresses = serverFeeAddresses(),
): FlatFee {
  const address = addresses[family];
  if (!address) throw new FeeAddressMissing(family);
  return {
    fee: flatFeeFor(destinationDomain, amount),
    address,
    kind: flatFeeKind(destinationDomain),
  };
}

/**
 * Read on each call on the server, so a route never needs the whole build environment (`env.ts`)
 * and tests can stub the variables.
 */
export function serverFeeAddresses(): FeeAddresses {
  return parseFeeAddresses({
    evm: process.env.NEXT_PUBLIC_XEBRA_FEE_ADDRESS_EVM,
    solana: process.env.NEXT_PUBLIC_XEBRA_FEE_ADDRESS_SOLANA,
    sui: process.env.NEXT_PUBLIC_XEBRA_FEE_ADDRESS_SUI,
    aptos: process.env.NEXT_PUBLIC_XEBRA_FEE_ADDRESS_APTOS,
  });
}
