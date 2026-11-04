import { EVM_CHAINS, XEBRA_WRAPPERS } from "../evm-chains";

/**
 * The figures the written pages state, in one place.
 *
 * The bridge itself always reads the live fee from the contract before anyone signs; these are what
 * the pages *say*. They are the parameters both wrappers were deployed with (`deployments/
 * mainnet.json`, held to it by `facts.test.ts`), and they change only through a contract's 48-hour
 * timelock, which is when this file changes too.
 */
export const FEES = {
  /** Xebra's percentage, in basis points of the amount: 10 is 0.10%. */
  bps: 10,
  /** The least Xebra's fee can be, in USDC. Circle's delivery fee is paid out of it. */
  minFeeUsdc: "0.30",
  minTransferUsdc: "1",
  maxTransferUsdc: "100",
  asOf: "2026-10-15",
} as const;

/** Contracts the pages name, with where to inspect them. */
export const CONTRACTS = {
  stellarWrapper: {
    address: "CCPVTWII2TW6VVSVA4JQ2KFHICGBG4QVAHPIGUPSIW3E4VNPUI4Y2WQR",
    explorer:
      "https://stellar.expert/explorer/public/contract/CCPVTWII2TW6VVSVA4JQ2KFHICGBG4QVAHPIGUPSIW3E4VNPUI4Y2WQR",
  },
  arcWrapper: {
    address: XEBRA_WRAPPERS.arc ?? "",
    explorer: `${EVM_CHAINS.arc.explorerUrl}/address/${XEBRA_WRAPPERS.arc ?? ""}`,
  },
} as const;

/**
 * Wrapper v2's caps for Solana and Arc as committed on 2026-09-24 (`deployments/mainnet.json`), in
 * USDC units, for when the contract cannot be read. `facts.test.ts` holds them to that record.
 */
export const RECORDED_STELLAR_CAPS: Record<number, { cap: number; newAccount: number | null }> = {
  5: { cap: 250_000, newAccount: 450_000 },
  26: { cap: 100_000, newAccount: null },
};

/** USDC units (6 decimals) as a figure for a sentence: 250000 -> "0.25". */
export function usdc(units: number): string {
  const whole = Math.floor(units / 1_000_000);
  const frac = String(units % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac.length < 2 ? frac.padEnd(2, "0") : frac}` : `${whole}`;
}
