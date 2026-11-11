import {
  type BurnRecipient,
  type Finality,
  decodeUint256,
  encodeAllowance,
  encodeBalanceOf,
} from "@xebra/cctp-evm";
import { type EvmBurnInput, evmApproveCall, evmBurnCall, evmBurnTarget } from "@xebra/sdk/build";
import { type EvmChain, formatUsdc6 } from "@xebra/sdk/core";
import {
  type Hex,
  ensureChain,
  ethCall,
  readBlockTimestamp,
  readChainId,
  sendTransaction,
  waitForReceipt,
} from "./evm-rpc";
import { formatError } from "./format-error";
import type { Eip1193Provider } from "./wallets/types";

/**
 * Starting a USDC transfer from an EVM chain, by calling Circle's contracts directly or through
 * Xebra's fee wrapper where the chain has one (`via`).
 *
 * Direct, the wallet approves Circle's `TokenMessengerV2` for the amount and calls
 * `depositForBurnWithHook` on it. Through the wrapper it approves the wrapper and calls its
 * `bridge`, which keeps Xebra's fee and makes the same burn itself. Either way Circle's Forwarding
 * Service mints on the destination.
 * There is no relay, so everything that can be checked is checked *before* the burn, which is the
 * one step that cannot be undone:
 *
 *   - the wallet is on the source chain, confirmed and not assumed (`ensureChain`);
 *   - the sender holds the amount;
 *   - the allowance really is the amount after approving (a wallet lets its user lower it);
 *   - the fee has not risen while an approval was confirming;
 *   - the burn succeeds when simulated as the sender.
 *
 * Two prompts, not one: an approval and the burn. A second transfer of the same or a smaller
 * amount after a failed first needs only the burn.
 */

export type EvmBridgeStep =
  | "switching"
  | "checking"
  | "approving"
  | "confirming-approval"
  | "burning";

export const EVM_STEP_LABEL: Record<EvmBridgeStep, (source: string) => string> = {
  switching: (s) => `Switch your wallet to ${s}`,
  checking: () => "Checking your balance",
  approving: () => "Approve the amount in your wallet (1 of 2)",
  "confirming-approval": (s) => `Waiting for ${s} to confirm the approval`,
  burning: () => "Confirm the transfer in your wallet (2 of 2)",
};

/** Long enough for a transaction priced low on a busy chain; the node is the wallet's, not ours. */
const RECEIPT_TIMEOUT_MS = 10 * 60_000;
const RECEIPT_POLL_MS = 2_000;

/**
 * Arc pays gas in the same USDC it is asked to burn. A transfer of the whole balance leaves
 * nothing to pay for itself, so this much is kept back. A margin, not a measurement: two
 * transactions on Arc have cost well under a cent each.
 */
export const ARC_GAS_RESERVE_UNITS = 50_000n;

/** How much USDC `owner` can send from `chain`, leaving gas where gas is USDC. */
export function spendableUsdc(chain: EvmChain, balance: bigint): bigint {
  if (chain.id !== "arc") return balance;
  return balance > ARC_GAS_RESERVE_UNITS ? balance - ARC_GAS_RESERVE_UNITS : 0n;
}

/** USDC held by `owner` on the chain the wallet is on. The caller must have confirmed the chain. */
export async function getUsdcBalance6(
  provider: Eip1193Provider,
  chain: EvmChain,
  owner: string,
): Promise<bigint> {
  return decodeUint256(await ethCall(provider, chain.usdcAddress, encodeBalanceOf(owner)));
}

/** What `owner` has approved `spender` (Circle's messenger, or the wrapper) to take. */
export async function getAllowance(
  provider: Eip1193Provider,
  chain: EvmChain,
  owner: string,
  spender: string,
): Promise<bigint> {
  return decodeUint256(await ethCall(provider, chain.usdcAddress, encodeAllowance(owner, spender)));
}

export interface EvmBridgeRequest {
  provider: Eip1193Provider;
  /** The connected account, which pays and signs. */
  from: string;
  source: EvmChain;
  /** Where it lands: Circle's domain for that chain, and its name for sentences. */
  destination: { cctpDomainId: number; name: string };
  /**
   * A validated address on the destination chain (`checkAddressOn`), or for Solana the resolved
   * USDC token account and, when it does not exist yet, the wallet Circle should open it for.
   */
  recipient: BurnRecipient;
  /** 6-decimal units. */
  amount: bigint;
  /** What Circle may keep, from `planEvmFee`. */
  maxFee: bigint;
  finality: Finality;
  onStep?: (step: EvmBridgeStep) => void;
  /**
   * The fee this transfer needs *now*. Asked only after an approval, since that can take minutes
   * and Circle's quote moves. Returning more than `maxFee` stops the transfer before the burn.
   */
  currentMaxFee?: () => Promise<bigint>;
  /**
   * Send through Xebra's wrapper at this address, paying at most `maxWrapperFee` in all (Circle's
   * fee included). Absent: call Circle directly.
   */
  via?: { address: string; maxWrapperFee: bigint } | null;
}

/** How long a request through the wrapper stays good, from the chain's latest block. */
const WRAPPER_DEADLINE_SECS = 600n;

export interface EvmBridgeResult {
  /** The burn. On chain as soon as this is returned; watch it with `watchBurn`. */
  txHash: Hex;
  approvalTxHash: Hex | null;
}

const NOTHING_BURNED = "Nothing was burned.";

export async function submitEvmBridge(req: EvmBridgeRequest): Promise<EvmBridgeResult> {
  const { provider, from, source, destination, amount, maxFee } = req;
  const via = req.via ?? null;
  const step = (s: EvmBridgeStep) => req.onStep?.(s);
  const burnInput: EvmBurnInput = {
    source,
    destination,
    recipient: req.recipient,
    amount,
    maxFee,
    finality: req.finality,
    via: via ? { address: via.address, maxWrapperFee: via.maxWrapperFee } : null,
  };
  // Who takes the USDC and is called: the wrapper, or Circle's messenger.
  const target = evmBurnTarget(burnInput);
  const encodeBurn = (deadline: bigint) => evmBurnCall(burnInput, deadline).data;

  // Built first: an argument the encoder refuses must fail before any wallet prompt. The deadline
  // is set for real just before the burn, after any approval has confirmed.
  let burn = encodeBurn(0n);

  step("switching");
  await ensureChain(provider, source);

  step("checking");
  const balance = await getUsdcBalance6(provider, source, from);
  if (balance < amount) {
    throw new Error(
      `This wallet holds ${formatUsdc6(balance)} USDC on ${source.name}; the transfer needs ${formatUsdc6(amount)}.`,
    );
  }
  if (spendableUsdc(source, balance) < amount) {
    throw new Error(
      `Arc pays gas in USDC. Leave ${formatUsdc6(ARC_GAS_RESERVE_UNITS)} USDC in the wallet for it and send up to ${formatUsdc6(spendableUsdc(source, balance))}.`,
    );
  }

  let approvalTxHash: Hex | null = null;
  if ((await getAllowance(provider, source, from, target)) < amount) {
    step("approving");
    approvalTxHash = await sendTransaction(provider, {
      from,
      ...evmApproveCall(burnInput),
      chainId: source.chainId,
    });

    step("confirming-approval");
    const outcome = await waitForReceipt(provider, approvalTxHash, {
      timeoutMs: RECEIPT_TIMEOUT_MS,
      pollMs: RECEIPT_POLL_MS,
    });
    if (outcome !== "success") {
      throw new Error(`The approval was reverted on ${source.name}. ${NOTHING_BURNED}`);
    }

    // The wait may have been minutes. The wallet could have moved, the cap could have been
    // lowered in the wallet's own prompt, and Circle's fee could have risen.
    if ((await readChainId(provider)) !== source.chainId) {
      throw new Error(
        `Your wallet left ${source.name} while the approval confirmed. ${NOTHING_BURNED} Switch back and send again; the approval is still in place.`,
      );
    }
    if ((await getAllowance(provider, source, from, target)) < amount) {
      throw new Error(
        `The approval in your wallet was for less than this transfer. ${NOTHING_BURNED} Send again and approve the full ${formatUsdc6(amount)} USDC.`,
      );
    }
    if (req.currentMaxFee) {
      const needed = await req.currentMaxFee();
      if (needed > maxFee) {
        throw new Error(
          `Circle's fee rose while the approval confirmed (${formatUsdc6(maxFee)} to ${formatUsdc6(needed)} USDC). ${NOTHING_BURNED} Review the new fee and send again; the approval is still in place.`,
        );
      }
    }
  }

  if (via) burn = encodeBurn((await readBlockTimestamp(provider)) + WRAPPER_DEADLINE_SECS);

  // A burn that would revert is found here, as the sender, instead of in a wallet warning or,
  // worse, on chain after gas is spent. Through the wrapper this runs every one of its checks.
  try {
    await ethCall(provider, target, burn, from);
  } catch (err) {
    throw new Error(
      `${source.name} says this transfer would fail: ${formatError(err)}. ${NOTHING_BURNED}`,
      { cause: err },
    );
  }

  step("burning");
  const txHash = await sendTransaction(provider, {
    from,
    to: target,
    data: burn,
    chainId: source.chainId,
  });
  return { txHash, approvalTxHash };
}

/**
 * Follows a submitted burn to its receipt. Only the outcome "reverted" changes what the page says:
 * a burn that was sent is otherwise assumed to be on its way, and Circle's own record of it is
 * what the receipt polls.
 */
export function watchBurn(
  provider: Eip1193Provider,
  txHash: string,
): Promise<"success" | "reverted"> {
  return waitForReceipt(provider, txHash, {
    timeoutMs: RECEIPT_TIMEOUT_MS,
    pollMs: RECEIPT_POLL_MS,
  });
}
