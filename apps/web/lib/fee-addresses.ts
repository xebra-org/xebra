/**
 * Xebra's fee addresses, one per source family: where the flat fee (`flatFeeFor`) is paid on
 * routes without a Xebra contract. Public by nature, so read from `NEXT_PUBLIC_` variables: the
 * forms build the same fee transfer the API does.
 *
 * EVM defaults to the Arc wrapper's fee recipient, a plain account (no code on Arc or Base), which
 * can receive on every EVM chain. The others have no default: a family without an address has its
 * routes turned off, never served free.
 */
export const DEFAULT_EVM_FEE_ADDRESS = "0x32e95718A4D9B60F2e4Fb1d371189ac5DD28211A";

export interface FeeAddresses {
  evm: string | null;
  solana: string | null;
  sui: string | null;
  aptos: string | null;
}

const EVM = /^0x[0-9a-fA-F]{40}$/;
const MOVE = /^0x[0-9a-fA-F]{64}$/;

/** A Solana address: base58, 32 to 44 characters. Kept free of `@solana/web3.js` (`env.ts` ships to every page). */
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const solana = (s: string) => SOLANA.test(s);

/** Reads the four variables. A value that is set but malformed fails the build, loudly. */
type Raw = string | null | undefined;

export function parseFeeAddresses(raw: {
  evm?: Raw;
  solana?: Raw;
  sui?: Raw;
  aptos?: Raw;
}): FeeAddresses {
  const pick = (name: string, v: Raw, ok: (s: string) => boolean) => {
    const t = v?.trim();
    if (!t) return null;
    if (!ok(t)) throw new Error(`${name} is not a valid address: ${t}`);
    return t;
  };
  return {
    evm:
      pick("NEXT_PUBLIC_XEBRA_FEE_ADDRESS_EVM", raw.evm, (s) => EVM.test(s)) ??
      DEFAULT_EVM_FEE_ADDRESS,
    solana: pick("NEXT_PUBLIC_XEBRA_FEE_ADDRESS_SOLANA", raw.solana, solana),
    sui: pick("NEXT_PUBLIC_XEBRA_FEE_ADDRESS_SUI", raw.sui, (s) => MOVE.test(s)),
    aptos: pick("NEXT_PUBLIC_XEBRA_FEE_ADDRESS_APTOS", raw.aptos, (s) => MOVE.test(s)),
  };
}
