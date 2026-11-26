import { type FlatFeeKind, flatFeeKind, priceFee } from "@xebra/sdk/core";
import { type FeeAddresses, parseFeeAddresses } from "../fee-addresses";

/**
 * Xebra's flat fee for the page's own build routes (`/api/solana-source/build`, `/api/sui-*`,
 * `/api/aptos/build`), decided on the server so a page cannot leave it out. Priced by the same
 * function and table as `/v1` (`priceFee`, `FEE_TABLE`): the amount a person enters is what leaves
 * the wallet, the burn is the rest. The page carries no API key, so it is always an ordinary
 * transfer at the default rule's price.
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
  /** The fee-table rule that priced it. */
  rule: string;
}

/** The CCTP domain each non-EVM family burns on; an EVM source has one per chain. */
const FAMILY_DOMAIN: Partial<Record<keyof FeeAddresses, number>> = { solana: 5, sui: 8, aptos: 9 };

export function flatFeeOn(
  family: keyof FeeAddresses,
  destinationDomain: number,
  /** What leaves the wallet, the amount the person entered; Xebra's fee includes 0.01% of it. */
  amount: bigint,
  addresses: FeeAddresses = serverFeeAddresses(),
): FlatFee {
  const address = addresses[family];
  if (!address) throw new FeeAddressMissing(family);
  const from = FAMILY_DOMAIN[family];
  const price = priceFee(amount, {
    product: "transfer",
    partner: null,
    ...(from !== undefined ? { from } : {}),
    to: destinationDomain,
  });
  return {
    fee: price.fee,
    address,
    kind: flatFeeKind(destinationDomain),
    rule: price.rule,
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
