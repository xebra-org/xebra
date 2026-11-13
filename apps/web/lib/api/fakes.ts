import { Account, Keypair, Networks } from "@stellar/stellar-sdk";
import type { CircleHealth } from "@xebra/cctp-client";
import type { TransferStep } from "@xebra/sdk/build";
import { type DomainForwardConfig, stellarDestination } from "@xebra/sdk/core";
import type { WrapperSettings } from "../evm-wrapper";
import type { BuildDeps, Deps } from "./deps";

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

export const WRAPPER = "CCPVTWII2TW6VVSVA4JQ2KFHICGBG4QVAHPIGUPSIW3E4VNPUI4Y2WQR";

/** An EVM fee wrapper at 0.05%, at least 0.10 USDC, 1 to 100 USDC, sending to Base (6). */
export const WRAPPER_SETTINGS: WrapperSettings = {
  address: "0x11b30470DAE40B2Fc27b7AA90dc58e6B4fE9f4c3",
  paused: false,
  feeBps: 5,
  minFee: 100_000n,
  minTransfer: 1_000_000n,
  maxTransfer: 100_000_000n,
  maxFastFeeBps: 5,
  domains: new Map([
    [6, { maxForwardFee: 100_000n, accountCreation: false, maxForwardFeeNewAccount: 0n }],
  ]),
};
export const SENDER = Keypair.random().publicKey();
export const STELLAR_RECIPIENT = Keypair.random().publicKey();
export const EVM_SENDER = "0x3333333333333333333333333333333333333333";
export const SUI_SENDER = `0x${"5".repeat(64)}`;
export const TOKEN_ACCOUNT = "8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6";

export const SUI_STEP: TransferStep = {
  id: "burn",
  chain: "sui",
  description: "burn",
  tx: { kind: "sui", json: "{}" },
  expiresAt: null,
};

export function buildDeps(over: Partial<BuildDeps> = {}): BuildDeps {
  return {
    stellarRpc: () => ({
      getAccount: async (id) => new Account(id, "100"),
      getLatestLedger: async () => ({ sequence: 65_400_000 }),
      prepareTransaction: async (tx) => tx,
    }),
    stellarWrapper: { wrapperContractId: WRAPPER, networkPassphrase: Networks.PUBLIC },
    stellarAccount: async () => ({ exists: true, hasTrustline: true, balance: 10_000_000_000n }),
    solanaRecipient: async () => ({ tokenAccount: TOKEN_ACCOUNT, status: "exists" }),
    evmUsdc: async () => ({ balance: 1_000_000_000n, allowance: 0n }),
    evmWrapperOn: false,
    suiBurn: async () => SUI_STEP,
    attestation: async () => ({
      status: "complete",
      message: "0x01",
      attestation: "0x02",
      destinationDomain: 6,
      sourceDomainId: 27,
      usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    }),
    evmClaimCheck: async () => ({ state: "open" }),
    solanaClaim: async () => ({ state: "ready", setup: null, mint: "bWludA==" }),
    suiClaim: async () => ({ ok: true, xdr: "AAAA" }),
    ...over,
  };
}
