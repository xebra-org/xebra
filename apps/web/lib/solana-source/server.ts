import { Connection, PublicKey } from "@solana/web3.js";
import { checkCircle } from "@xebra/cctp-client";
import {
  type BuiltSolanaBurn,
  InsufficientSolanaUsdcError,
  SolanaBurnRefused,
  buildSolanaBurnTransaction,
} from "@xebra/cctp-solana";
import { type EvmChain, type FeePlan, formatUsdc6, planEvmFee } from "@xebra/sdk/core";
import { env } from "../env";
import { irisBaseUrl, irisBudget, irisFetch } from "../server/iris";
import { recipientStatus } from "../sui-stellar/stellar-side";
import { SolanaSourceError } from "./checks";
import { SOLANA_CCTP_DOMAIN, SOLANA_STELLAR_MIN_UNITS } from "./config";
import { type SolanaBurnTarget, solanaBurnParams } from "./plan";

/**
 * The server half of a transfer that starts on Solana: price it, check what can be checked before
 * anyone signs, and build the burn. Shared by `/api/solana-source/build` and the /v1 API so both
 * refuse the same things in the same words. Nothing here signs for the user or sends anything.
 */

export function solanaConnection(): Connection {
  return new Connection(process.env.SOLANA_RPC_URL?.trim() || env.solanaRpcUrl, "confirmed");
}

/** Circle's Standard delivery quote from Solana to an EVM chain, priced the way every EVM route is. */
export async function priceSolanaToEvm(
  chain: EvmChain,
  amount: bigint,
): Promise<Extract<FeePlan, { ok: true }>> {
  const health = await checkCircle({
    baseUrl: irisBaseUrl(),
    sourceDomain: SOLANA_CCTP_DOMAIN,
    destDomain: chain.cctpDomainId,
    fetch: irisFetch,
    store: irisBudget(),
    maxFeeUnits: chain.maxForwardFeeUnits,
  });
  const tier = health.tiers.standard;
  if (health.status === "down" || !tier) {
    throw new SolanaSourceError(
      `Circle cannot deliver from Solana to ${chain.name} right now${health.reasons[0] ? `: ${health.reasons[0]}` : ""}. Nothing was burned; try again shortly.`,
      503,
      "upstream_unavailable",
    );
  }
  const plan = planEvmFee({ amount, tier, destination: chain });
  if (!plan.ok) {
    throw new SolanaSourceError(
      plan.reason,
      plan.kind === "cap" ? 503 : 422,
      plan.kind === "minimum"
        ? "amount_below_minimum"
        : plan.kind === "maximum"
          ? "amount_above_maximum"
          : plan.kind === "cap"
            ? "upstream_unavailable"
            : "invalid_request",
    );
  }
  return plan;
}

/**
 * The Stellar recipient must exist and hold a USDC trustline, and the amount must be one the relayer
 * completes. Checked before the burn: after it, a missing trustline leaves the USDC waiting at the
 * forwarder until one is added.
 */
export async function checkSolanaToStellar(recipient: string, amount: bigint): Promise<void> {
  if (amount < SOLANA_STELLAR_MIN_UNITS) {
    throw new SolanaSourceError(
      `Send at least ${formatUsdc6(SOLANA_STELLAR_MIN_UNITS)} USDC from Solana to Stellar.`,
      422,
      "amount_below_minimum",
      { minimum: SOLANA_STELLAR_MIN_UNITS },
    );
  }
  if (!/^G[A-Z2-7]{55}$/.test(recipient)) {
    throw new SolanaSourceError(
      "The recipient must be a Stellar account address starting with G.",
      400,
      "invalid_recipient",
    );
  }
  let status: Awaited<ReturnType<typeof recipientStatus>>;
  try {
    status = await recipientStatus(recipient);
  } catch {
    throw new SolanaSourceError(
      "Could not check the Stellar recipient just now. Nothing was burned; try again.",
      502,
      "upstream_unavailable",
    );
  }
  if (!status.exists) {
    throw new SolanaSourceError(
      "That Stellar account does not exist yet. It needs XLM to be created and a USDC trustline before it can receive.",
      422,
      "invalid_recipient",
    );
  }
  if (!status.hasTrustline) {
    throw new SolanaSourceError(
      "That Stellar account has no USDC trustline. Add one, then try again.",
      422,
      "invalid_recipient",
    );
  }
}

/**
 * The burn for the owner's wallet to sign, simulated first. `maxFee` is what the caller priced
 * (zero to Stellar). Maps every refusal to a `SolanaSourceError` a person can act on.
 */
export async function buildSolanaSourceBurn(p: {
  sender: string;
  amount: bigint;
  target: SolanaBurnTarget;
  maxFee: bigint;
  connection?: Connection;
}): Promise<BuiltSolanaBurn> {
  let params: ReturnType<typeof solanaBurnParams>;
  try {
    params = solanaBurnParams(p.target, p.amount, p.maxFee);
  } catch (err) {
    throw new SolanaSourceError(
      err instanceof Error ? err.message : "That transfer cannot be built.",
      400,
      "invalid_recipient",
    );
  }
  try {
    return await buildSolanaBurnTransaction(p.connection ?? solanaConnection(), {
      owner: new PublicKey(p.sender),
      params,
    });
  } catch (err) {
    if (err instanceof InsufficientSolanaUsdcError) {
      throw new SolanaSourceError(
        `That Solana wallet holds ${formatUsdc6(err.have)} USDC, less than ${formatUsdc6(err.need)}.`,
        422,
        "insufficient_balance",
        { have: err.have, need: err.need },
      );
    }
    if (err instanceof SolanaBurnRefused) {
      console.warn("solana burn simulation refused", err.message, err.logs.slice(-8));
      throw new SolanaSourceError(
        `${err.message} Nothing was burned.`,
        422,
        "transaction_rejected",
      );
    }
    console.error("solana burn build failed", err);
    throw new SolanaSourceError(
      "Solana's RPC could not be reached to prepare the transfer. Try again in a moment.",
      502,
      "upstream_unavailable",
    );
  }
}
