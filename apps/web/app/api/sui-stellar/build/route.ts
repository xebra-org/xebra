import { InsufficientUsdcError, SUI_ADDRESS, buildBurn } from "@xebra/sdk/build";
import { formatUsdcAmount, parseUsdcAmount } from "@xebra/sdk/core";
import { FeeAddressMissing, flatFeeOn } from "../../../../lib/server/flat-fee";
import {
  STELLAR_RECIPIENT_FORMAT,
  readStellarRecipient,
  stellarRecipientProblem,
} from "../../../../lib/stellar-recipient";
import { suiClient } from "../../../../lib/sui-stellar/client";
import {
  maxUsdcBase,
  notFound,
  relayerSecret,
  suiStellarEnabled,
} from "../../../../lib/sui-stellar/config";
import { recipientStatus } from "../../../../lib/sui-stellar/stellar-side";

/**
 * Builds the Sui burn for the connected wallet to sign. Nothing is signed or sent here.
 *
 * Refusals happen first, and each is a plain sentence the page shows as it is:
 * a mistyped recipient, an unfunded or trustline-less Stellar account (the USDC could not land),
 * an amount over the cap, or a Sui balance that cannot cover it.
 */
const STELLAR_DOMAIN = 27;

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  if (!suiStellarEnabled()) return notFound();

  let body: { sender?: unknown; amount?: unknown; recipient?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Send JSON with sender, amount and recipient." },
      { status: 400 },
    );
  }
  const sender = typeof body.sender === "string" ? body.sender.trim() : "";
  const recipient = typeof body.recipient === "string" ? body.recipient.trim() : "";
  const amount = typeof body.amount === "string" ? parseUsdcAmount(body.amount) : null;

  if (!SUI_ADDRESS.test(sender)) {
    return Response.json({ error: "That is not a Sui address." }, { status: 400 });
  }
  // A G... account or an M... deposit address; no contracts: a contract recipient has no
  // trustline to check, and the pilot does not need it.
  const into = readStellarRecipient(recipient);
  if (!into) return Response.json({ error: STELLAR_RECIPIENT_FORMAT }, { status: 400 });
  if (amount === null) {
    return Response.json({ error: "Enter an amount of USDC, up to 6 decimals." }, { status: 400 });
  }
  const cap = maxUsdcBase();
  if (cap !== null && amount > cap) {
    return Response.json(
      { error: `The limit is ${formatUsdcAmount(cap)} USDC per transfer.` },
      { status: 422 },
    );
  }

  try {
    // What the person entered leaves the wallet; Xebra's flat fee is paid out of it in the burn's
    // own transaction (Stellar is delivered by Xebra's relayer: the delivered fee).
    const flat = flatFeeOn("sui", STELLAR_DOMAIN, amount);
    const burn = amount - flat.fee;
    if (burn <= 0n) {
      return Response.json(
        { error: `Send more than Xebra's ${formatUsdcAmount(flat.fee)} USDC fee.` },
        { status: 422 },
      );
    }
    // The trustline is the G... account's; an M... address goes into the hook whole.
    const problem = stellarRecipientProblem(into, await recipientStatus(into.account));
    if (problem) return Response.json({ error: problem }, { status: 422 });

    const { transaction } = await buildBurn(suiClient(), {
      sender,
      amount: burn,
      stellarRecipient: recipient,
      fee: { address: flat.address, amount: flat.fee },
    });
    return Response.json({
      transaction,
      // What is burned and reaches the recipient; the fee is on top, out of what was entered.
      amount: formatUsdcAmount(burn),
      xebraFee: formatUsdcAmount(flat.fee),
      // Tells the page whether anything will finish the transfer for the user.
      relayer: relayerSecret() !== null,
    });
  } catch (err) {
    if (err instanceof FeeAddressMissing) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof InsufficientUsdcError) {
      return Response.json(
        {
          error: `That Sui address holds ${formatUsdcAmount(err.have)} USDC, less than ${formatUsdcAmount(err.need)}.`,
        },
        { status: 422 },
      );
    }
    console.error("sui-stellar build failed", err);
    return Response.json(
      { error: "Could not prepare the transfer. Try again in a moment." },
      { status: 502 },
    );
  }
}
