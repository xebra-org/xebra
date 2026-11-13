import { formatUsdc6, parseUsdcAmount } from "@xebra/sdk/core";
import { SolanaSourceError, checkSolanaSend } from "../../../../lib/solana-source/checks";
import { solanaEvmDestination, solanaSends } from "../../../../lib/solana-source/config";
import type { SolanaBurnTarget } from "../../../../lib/solana-source/plan";
import {
  buildSolanaSourceBurn,
  checkSolanaToStellar,
  priceSolanaToEvm,
} from "../../../../lib/solana-source/server";
import { notFound } from "../../../../lib/sui-stellar/config";

/**
 * Builds a Solana burn for the connected wallet to sign. Nothing is signed by the user or sent here.
 *
 * To an EVM chain, Circle's Forwarding Service delivers the mint and the fee is priced here from a
 * fresh quote, with the same rules as every direct EVM route. The page sends the `maxFee` it showed;
 * if the price has gone up since, the burn is refused rather than signed at a fee nobody saw.
 *
 * To Stellar there is no fee: Circle charges nothing for Standard and nothing is forwarded. The
 * recipient's trustline is checked first, and our relayer (or the owner) completes the mint.
 *
 * Xebra takes nothing on these routes: there is no Xebra contract on Solana.
 *
 * The transaction comes back co-signed by a one-time event-account key (Solana's CCTP program
 * writes the message into a new account whose key must sign) and simulated against mainnet, so a
 * burn the program would refuse is refused here. It is good for about a minute: Solana transactions
 * name a recent block.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const sends = solanaSends();
  if (!sends.stellar && sends.evm.length === 0) return notFound();

  let body: {
    sender?: unknown;
    amount?: unknown;
    recipient?: unknown;
    chain?: unknown;
    maxFee?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Send JSON with sender, amount, recipient, chain and maxFee." },
      { status: 400 },
    );
  }
  const sender = typeof body.sender === "string" ? body.sender.trim() : "";
  const recipient = typeof body.recipient === "string" ? body.recipient.trim() : "";
  const amount = typeof body.amount === "string" ? parseUsdcAmount(body.amount) : null;
  const shownMaxFee =
    typeof body.maxFee === "string" && /^\d{1,12}$/.test(body.maxFee) ? BigInt(body.maxFee) : null;

  const toStellar = body.chain === "stellar";
  const chain = toStellar ? null : solanaEvmDestination(body.chain);
  if (toStellar ? !sends.stellar : !chain) {
    return Response.json({ error: "Solana does not send to that chain." }, { status: 400 });
  }

  try {
    checkSolanaSend(sender, amount ?? 0n);
    const units = amount as bigint;
    let target: SolanaBurnTarget;
    let maxFee = 0n;
    let received = units;
    if (chain) {
      target = { kind: "evm", chain, recipient };
      if (shownMaxFee === null) {
        return Response.json(
          { error: "The fee shown was not sent. Reload the page." },
          { status: 400 },
        );
      }
      const plan = await priceSolanaToEvm(chain, units);
      if (plan.maxFee > shownMaxFee) {
        throw new SolanaSourceError(
          `Circle's fee went up to ${formatUsdc6(plan.maxFee)} USDC since it was shown. Check the new amount, then send again.`,
          409,
          "fee_above_limit",
          { maxFee: plan.maxFee },
        );
      }
      maxFee = plan.maxFee;
      received = plan.received;
    } else {
      target = { kind: "stellar", recipient };
      await checkSolanaToStellar(recipient, units);
    }

    const built = await buildSolanaSourceBurn({ sender, amount: units, target, maxFee });
    return Response.json({
      transaction: built.transaction,
      eventAccount: built.eventAccount,
      lastValidBlockHeight: built.lastValidBlockHeight,
      maxFee: maxFee.toString(),
      received: received.toString(),
    });
  } catch (err) {
    if (err instanceof SolanaSourceError) {
      return Response.json(
        {
          error: err.message,
          ...(err.extra.maxFee !== undefined ? { maxFee: err.extra.maxFee.toString() } : {}),
        },
        { status: err.status },
      );
    }
    console.error("solana-source build failed", err);
    return Response.json(
      { error: "Could not prepare the transfer. Try again in a moment." },
      { status: 502 },
    );
  }
}
