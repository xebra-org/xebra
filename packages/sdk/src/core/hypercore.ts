import { formatUsdcAmount } from "./amounts.js";
import { EVM_CHAINS, EVM_CHAIN_IDS, type EvmChainId } from "./chains/evm.js";
import { type FeeRule, amountForBurnUnder, feeUnder } from "./fees/table.js";

/**
 * Withdrawing USDC from Hyperliquid (HyperCore) through Circle.
 *
 * The user signs one gas-free Hyperliquid action, `sendToEvmWithData`, naming a CCTP domain and a
 * recipient. HyperCore debits the balance and hands the USDC to Circle's `CoreDepositWallet` on
 * HyperEVM, which burns it with CCTP (HyperEVM is CCTP domain 19) and, because the action carries no
 * custom hook, asks Circle's Forwarding Service to mint it on the destination. There is no Xebra
 * contract on this route: Xebra's fee is a second signed action, a plain USDC send on HyperCore.
 *
 * Sources: Circle's how-tos "Withdraw USDC from HyperCore to EVM chains" / "…to Solana" and
 * `circlefin/hyperevm-circle-contracts` (`CoreDepositWallet.coreReceiveWithData`). Pure; nothing
 * here reads the network.
 */

export const HYPERCORE = {
  /** The CCTP domain the burn happens on: HyperEVM, where `CoreDepositWallet` lives. */
  burnDomain: 19,
  /** Circle's `CoreDepositWallet` proxy on HyperEVM, the contract that burns a withdrawal. */
  coreDepositWallet: "0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24",
  exchangeUrl: "https://api.hyperliquid.xyz/exchange",
  infoUrl: "https://api.hyperliquid.xyz/info",
  evmRpcUrl: "https://rpc.hyperliquid.xyz/evm",
  /** HyperCore's spot USDC, as `spotSend` names it (`spotMeta`: index 0, read 2026-11-28). */
  spotUsdcToken: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
  /** Hyperliquid's one-time fee on a new account's first outbound action. */
  activationFee: 1_000_000n,
  /** What Circle's own examples pass; ignored on a forwarded withdrawal. */
  gasLimit: 200_000,
  /** The least a withdrawal is let deliver: below this the fees are the whole transfer. */
  minReceived: 10_000n,
} as const;

/** Where a HyperCore withdrawal can land in this phase. */
export type HyperliquidDestination = EvmChainId | "solana";

/**
 * EVM domains Circle's Forwarding Service does not deliver to. A withdrawal there would need
 * someone to mint it by hand; this phase does not offer them.
 */
const NOT_DELIVERED: readonly EvmChainId[] = ["injective", "morph", "pharos"];

/**
 * Every chain a HyperCore withdrawal reaches with Circle delivering it: every EVM chain Circle
 * forwards to (Arc included), and Solana. HyperEVM is not one: it is the burn's own chain, and
 * Hyperliquid moves USDC there itself for nothing.
 */
export const HYPERLIQUID_DESTINATIONS: readonly HyperliquidDestination[] = [
  ...EVM_CHAIN_IDS.filter((id) => id !== "hyperevm" && !NOT_DELIVERED.includes(id)),
  "solana",
];

export function isHyperliquidDestination(id: string): id is HyperliquidDestination {
  return (HYPERLIQUID_DESTINATIONS as readonly string[]).includes(id);
}

export function hyperliquidDestinationDomain(to: HyperliquidDestination): number {
  return to === "solana" ? 5 : EVM_CHAINS[to].cctpDomainId;
}

/**
 * Why a withdrawal from Hyperliquid cannot go to `to`, in words for the person asking, or null when
 * it can. Stellar is refused outright: Circle's Hyperliquid contract cannot meet Stellar's delivery
 * rules, and Circle says USDC sent that way stays stuck for good.
 */
export function hyperliquidRefusal(to: string): { reason: string } | null {
  if (isHyperliquidDestination(to)) return null;
  switch (to) {
    case "stellar":
      return {
        reason:
          "Hyperliquid cannot send USDC straight to Stellar: it would be stuck for good, and nobody could get it back. For now, move it to your HyperEVM wallet or to a chain like Base first, then send it to Stellar from there. A two-step route through Xebra is coming.",
      };
    case "sui":
    case "aptos":
      return {
        reason: `Withdrawals from Hyperliquid to ${to === "sui" ? "Sui" : "Aptos"} are not open yet. Nobody has shown they arrive safely, so Xebra will not send real money that way until a test has.`,
      };
    case "hyperevm":
      return {
        reason:
          "To move USDC to your own HyperEVM wallet, use Hyperliquid's own transfer: it costs nothing and does not need Circle.",
      };
    case "injective":
    case "morph":
    case "pharos":
      return {
        reason: `Circle does not deliver to ${EVM_CHAINS[to].name}, so a withdrawal from Hyperliquid would wait there for someone to claim it by hand. It is not offered.`,
      };
    default:
      return { reason: `Hyperliquid withdrawals do not go to ${to}.` };
  }
}

export type HyperliquidPlan =
  | {
      ok: true;
      /** Xebra's fee, sent as its own signed action. */
      xebraFee: bigint;
      /** What Circle keeps to deliver it, read from `CoreDepositWallet`. */
      forwardFee: bigint;
      /** Hyperliquid's one-time fee on a new account's first withdrawal, or 0. */
      activationFee: bigint;
      /** The `amount` of the signed `sendToEvmWithData`: what Circle burns. */
      withdraw: bigint;
      /** What lands on the destination. */
      received: bigint;
      total: bigint;
      /** The least this route takes right now. */
      minimum: bigint;
    }
  | { ok: false; kind: "minimum" | "amount"; reason: string; minimum: bigint };

/**
 * Splits `amount`, everything that leaves the user's Hyperliquid balance, into Xebra's fee,
 * Hyperliquid's activation fee (on a first withdrawal) and the withdrawal itself, of which Circle
 * keeps `forwardFee`. Refuses an amount the fees would swallow: Circle's contract reverts a
 * withdrawal no larger than its fee.
 */
export function planHyperliquidWithdrawal(p: {
  amount: bigint;
  rule: FeeRule;
  forwardFee: bigint;
  activationFee: bigint;
}): HyperliquidPlan {
  // The least amount that leaves `minReceived` once every fee is out of it. Xebra's fee is taken
  // from the amount first, so this is the amount whose remainder covers the other fees too.
  const minimum = amountForBurnUnder(
    p.rule,
    p.forwardFee + p.activationFee + HYPERCORE.minReceived,
  );
  if (p.amount <= 0n) {
    return { ok: false, kind: "amount", reason: "The amount must be more than zero.", minimum };
  }
  const xebraFee = feeUnder(p.rule, p.amount);
  const withdraw = p.amount - xebraFee - p.activationFee;
  const received = withdraw - p.forwardFee;
  if (p.amount < minimum || received < HYPERCORE.minReceived) {
    return {
      ok: false,
      kind: "minimum",
      reason: `Fees would take all of this withdrawal. Withdraw at least ${formatUsdcAmount(minimum)} USDC.`,
      minimum,
    };
  }
  return {
    ok: true,
    xebraFee,
    forwardFee: p.forwardFee,
    activationFee: p.activationFee,
    withdraw,
    received,
    total: xebraFee + p.forwardFee + p.activationFee,
    minimum,
  };
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TRANSFER_ID = /^(0x[0-9a-fA-F]{40}):([0-9]{1,16})$/;

/**
 * A HyperCore withdrawal has no transaction hash of its own until Circle burns it on HyperEVM, so
 * it is named by its signer and its nonce (the `nonce` it was signed with, in milliseconds), which
 * `CoreDepositWallet` echoes in its `CrossChainWithdraw` event.
 */
export function formatTransferId(user: string, nonce: number): string {
  if (!EVM_ADDRESS.test(user)) throw new Error("user must be a 0x address");
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("nonce must be a whole number");
  return `${user.toLowerCase()}:${nonce}`;
}

export function parseTransferId(id: string): { user: string; nonce: number } | null {
  const m = TRANSFER_ID.exec(id.trim());
  if (!m?.[1] || !m[2]) return null;
  const nonce = Number(m[2]);
  if (!Number.isSafeInteger(nonce)) return null;
  return { user: m[1].toLowerCase(), nonce };
}
