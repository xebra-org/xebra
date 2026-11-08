import { StrKey } from "@stellar/stellar-sdk";
import {
  InsufficientUsdcError,
  SUI_ADDRESS,
  buildBurn,
  suiClient,
} from "../../../../lib/sui-stellar/build-burn";
import { formatUsdc, parseUsdcAmount } from "../../../../lib/sui-stellar/cctp";
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
export const dynamic = "force-dynamic";

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
  // G... accounts only for now. A contract recipient has no trustline to check, and the pilot
  // does not need it.
  if (!StrKey.isValidEd25519PublicKey(recipient)) {
    return Response.json(
      { error: "The recipient must be a Stellar account address starting with G." },
      { status: 400 },
    );
  }
  if (amount === null) {
    return Response.json({ error: "Enter an amount of USDC, up to 6 decimals." }, { status: 400 });
  }
  const cap = maxUsdcBase();
  if (cap !== null && amount > cap) {
    return Response.json(
      { error: `The limit is ${formatUsdc(cap)} USDC per transfer.` },
      { status: 422 },
    );
  }

  try {
    const status = await recipientStatus(recipient);
    if (!status.exists) {
      return Response.json(
        {
          error:
            "That Stellar account does not exist yet. It needs XLM to be created and a USDC trustline before it can receive.",
        },
        { status: 422 },
      );
    }
    if (!status.hasTrustline) {
      return Response.json(
        { error: "That Stellar account has no USDC trustline. Add one, then try again." },
        { status: 422 },
      );
    }

    const { transaction } = await buildBurn(suiClient(), {
      sender,
      amount,
      stellarRecipient: recipient,
    });
    return Response.json({
      transaction,
      amount: formatUsdc(amount),
      // Tells the page whether anything will finish the transfer for the user.
      relayer: relayerSecret() !== null,
    });
  } catch (err) {
    if (err instanceof InsufficientUsdcError) {
      return Response.json(
        {
          error: `That Sui address holds ${formatUsdc(err.have)} USDC, less than ${formatUsdc(err.need)}.`,
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
