import { checkCircle } from "@xebra/cctp-client";
import { checkAddressOn } from "../../../../lib/evm-address";
import { planEvmFee } from "../../../../lib/evm-forward-fee";
import { irisBaseUrl, irisBudget, irisFetch } from "../../../../lib/server/iris";
import {
  InsufficientUsdcError,
  SUI_ADDRESS,
  buildEvmBurn,
  suiClient,
} from "../../../../lib/sui-stellar/build-burn";
import { parseUsdcAmount } from "../../../../lib/sui-stellar/cctp";
import {
  SUI_CCTP_DOMAIN,
  maxUsdcBase,
  notFound,
  suiEvmDestinations,
} from "../../../../lib/sui-stellar/config";
import { formatUsdc6 } from "../../../../lib/usdc6";

/**
 * Builds a Sui burn to an EVM chain for the connected wallet to sign. Nothing is signed or sent here.
 *
 * Circle's Forwarding Service delivers the mint, so nothing of ours has to finish the transfer. The
 * fee is priced here, from a fresh quote, with the same rules as every direct EVM route
 * (`planEvmFee`: Circle's `high` delivery quote, at most the chain's ceiling and a tenth of the
 * amount). The page sends the `maxFee` it showed; if the price has gone up since, the burn is
 * refused rather than signed at a fee the person never saw.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const destinations = suiEvmDestinations();
  if (destinations.length === 0) return notFound();

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
  const chain = destinations.find((c) => c.id === body.chain);

  if (!chain) {
    return Response.json({ error: "Sui does not send to that chain." }, { status: 400 });
  }
  if (!SUI_ADDRESS.test(sender)) {
    return Response.json({ error: "That is not a Sui address." }, { status: 400 });
  }
  const address = checkAddressOn(chain, recipient);
  if (!address.ok) {
    return Response.json(
      { error: address.error ?? `That is not a ${chain.name} address.` },
      { status: 400 },
    );
  }
  if (amount === null || amount <= 0n) {
    return Response.json({ error: "Enter an amount of USDC, up to 6 decimals." }, { status: 400 });
  }
  if (shownMaxFee === null) {
    return Response.json(
      { error: "The fee shown was not sent. Reload the page." },
      { status: 400 },
    );
  }
  const cap = maxUsdcBase();
  if (cap !== null && amount > cap) {
    return Response.json(
      { error: `The limit is ${formatUsdc6(cap)} USDC per transfer.` },
      { status: 422 },
    );
  }

  const health = await checkCircle({
    baseUrl: irisBaseUrl(),
    sourceDomain: SUI_CCTP_DOMAIN,
    destDomain: chain.cctpDomainId,
    fetch: irisFetch,
    store: irisBudget(),
    maxFeeUnits: chain.maxForwardFeeUnits,
  });
  const tier = health.tiers.standard;
  if (health.status === "down" || !tier) {
    return Response.json(
      {
        error: `Circle cannot deliver to ${chain.name} right now${health.reasons[0] ? `: ${health.reasons[0]}` : ""}. Nothing was burned; try again shortly.`,
      },
      { status: 503 },
    );
  }
  const plan = planEvmFee({ amount, tier, destination: chain });
  if (!plan.ok) return Response.json({ error: plan.reason }, { status: 422 });
  if (plan.maxFee > shownMaxFee) {
    return Response.json(
      {
        error: `Circle's fee went up to ${formatUsdc6(plan.maxFee)} USDC since it was shown. Check the new amount, then send again.`,
        maxFee: plan.maxFee.toString(),
      },
      { status: 409 },
    );
  }

  try {
    const { transaction } = await buildEvmBurn(suiClient(), {
      sender,
      amount,
      evmRecipient: recipient,
      destinationDomain: chain.cctpDomainId,
      maxFee: plan.maxFee,
    });
    return Response.json({
      transaction,
      maxFee: plan.maxFee.toString(),
      received: plan.received.toString(),
    });
  } catch (err) {
    if (err instanceof InsufficientUsdcError) {
      return Response.json(
        {
          error: `That Sui address holds ${formatUsdc6(err.have)} USDC, less than ${formatUsdc6(err.need)}.`,
        },
        { status: 422 },
      );
    }
    console.error("sui-evm build failed", err);
    return Response.json(
      { error: "Could not prepare the transfer. Try again in a moment." },
      { status: 502 },
    );
  }
}
