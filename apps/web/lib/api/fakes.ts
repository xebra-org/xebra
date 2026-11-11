import type { CircleHealth } from "@xebra/cctp-client";
import { type DomainForwardConfig, stellarDestination } from "@xebra/sdk/core";
import type { Deps } from "./deps";

/** Fakes shared by the service and MCP tests: one route table, one Circle answer, no network. */

export const RECIPIENT = "0x5b38da6a701c568545dcfcb03fcb875f56beddc4";
export const SOLANA_WALLET = "4UXmtLwyV5tRyzuCFtQccrHkepyVDnL29GLsg5LwFN82";
export const STELLAR_TX = "a".repeat(64);
export const EVM_TX = `0x${"b".repeat(64)}`;

export const health = (over: Partial<CircleHealth> = {}, high = 20_000): CircleHealth =>
  ({
    status: "ok",
    reasons: [],
    checkedAt: 0,
    quote: { low: high, med: high, high },
    tiers: {
      standard: { finalityThreshold: 2000, low: high, med: high, high, minimumFeePpb: 0 },
      fast: { finalityThreshold: 1000, low: high, med: high, high, minimumFeePpb: 130_000 },
    },
    slowestMs: 10,
    budget: {},
    ...over,
  }) as unknown as CircleHealth;

export const cfg = (maxForwardFee = 2_500_000n): DomainForwardConfig => ({
  forward: true,
  maxForwardFee,
  accountCreation: false,
  maxForwardFeeNewAccount: 0n,
});

export function deps(over: Partial<Deps> = {}): Deps {
  return {
    siteUrl: "https://xebra.exchange",
    evmRoutes: { arcSendsTo: ["base"], arcReceivesFrom: [] },
    stellarRoutes: async () => ({
      destinations: [stellarDestination("solana"), stellarDestination("base")],
      domains: new Map([
        [5, cfg()],
        [6, cfg()],
      ]),
    }),
    circle: async () => health(),
    feeParams: async () => ({ feeBps: 10n, minFee: 3_000_000n }),
    delivery: async () => ({
      status: "known",
      state: "forwarding",
      forwardTxHash: null,
      reason: null,
    }),
    suiStellar: { enabled: false, maxUnits: null },
    ...over,
  };
}
