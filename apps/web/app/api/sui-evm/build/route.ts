import { checkCircle } from "@xebra/cctp-client";
import {
  InsufficientUsdcError,
  SUI_ADDRESS,
  type SuiForwardRecipient,
  buildForwardedBurn,
} from "@xebra/sdk/build";
import {
  bytesToHex,
  checkAddressOn,
  checkSolanaAddress,
  formatUsdc6,
  parseUsdcAmount,
  planEvmFee,
  solanaAddressToBytes32,
} from "@xebra/sdk/core";
import {
  type RouteDestination,
  feeDestination,
  routeDestination,
} from "../../../../lib/route-destination";
import { irisBaseUrl, irisBudget, irisFetch } from "../../../../lib/server/iris";
import { suiClient } from "../../../../lib/sui-stellar/client";
import {
  SUI_CCTP_DOMAIN,
  maxUsdcBase,
  notFound,
  suiEvmDestinations,
  suiSendsToSolana,
} from "../../../../lib/sui-stellar/config";
import { GET as solanaRecipient } from "../../recipient/route";

/**
 * Builds a Sui burn to an EVM chain, or to Solana, for the connected wallet to sign. Nothing is
 * signed or sent here.
 *
 * Circle's Forwarding Service delivers the mint, so nothing of ours has to finish the transfer. The
 * fee is priced here, from a fresh quote, with the same rules as every direct EVM route
 * (`planEvmFee`: Circle's `high` delivery quote, at most the chain's ceiling and a tenth of the
 * amount). The page sends the `maxFee` it showed; if the price has gone up since, the burn is
 * refused rather than signed at a fee the person never saw.
 *
 * Solana: the person names a wallet, and the burn names that wallet's USDC token account, looked
 * up here rather than taken from the page. When the account does not exist yet, Circle opens it
 * during delivery for a higher fee, with its own ceiling, and the hook says so. A lookup that fails
 * stops the build: the price depends on the answer.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const destinations = suiEvmDestinations();
  const toSolana = suiSendsToSolana();
  if (destinations.length === 0 && !toSolana) return notFound();

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
  const evm = destinations.find((c) => c.id === body.chain);
  const chain: RouteDestination | null = evm
    ? routeDestination(evm.id)
    : body.chain === "solana" && toSolana
      ? routeDestination("solana")
      : null;

  if (!chain) {
    return Response.json({ error: "Sui does not send to that chain." }, { status: 400 });
  }
  if (!SUI_ADDRESS.test(sender)) {
    return Response.json({ error: "That is not a Sui address." }, { status: 400 });
  }
  const address = chain.evm ? checkAddressOn(chain.evm, recipient) : checkSolanaAddress(recipient);
  if (!address.ok || !address.bytes) {
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

  // Who the burn mints to. On Solana, the wallet's USDC token account, and whether Circle must
  // open it, which changes the price.
  let burnRecipient: SuiForwardRecipient = recipient;
  let opensAccount = false;
  if (!chain.evm) {
    const found = await resolveSolana(recipient);
    if (!found) {
      return Response.json(
        {
          error:
            "Whether this wallet has a USDC account on Solana could not be checked just now, and the fee depends on it. Nothing was burned; try again shortly.",
        },
        { status: 503 },
      );
    }
    opensAccount = found.status === "missing";
    burnRecipient = {
      kind: "solana",
      tokenAccount: bytesToHex(solanaAddressToBytes32(found.tokenAccount)),
      createAccountFor: opensAccount ? bytesToHex(address.bytes) : undefined,
    };
  }
  const destination = feeDestination(chain, opensAccount);

  const health = await checkCircle({
    baseUrl: irisBaseUrl(),
    sourceDomain: SUI_CCTP_DOMAIN,
    destDomain: chain.cctpDomainId,
    includeRecipientSetup: opensAccount,
    fetch: irisFetch,
    store: irisBudget(),
    maxFeeUnits: destination.maxForwardFeeUnits,
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
  const plan = planEvmFee({ amount, tier, destination });
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
    const { transaction } = await buildForwardedBurn(suiClient(), {
      sender,
      amount,
      recipient: burnRecipient,
      destinationDomain: chain.cctpDomainId,
      maxFee: plan.maxFee,
    });
    return Response.json({
      transaction,
      maxFee: plan.maxFee.toString(),
      received: plan.received.toString(),
      opensAccount,
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

/**
 * A Solana wallet's USDC token account and whether it exists, from the same route the page asks;
 * null when the lookup failed (`unknown` is not `missing`).
 */
async function resolveSolana(
  owner: string,
): Promise<{ tokenAccount: string; status: "exists" | "missing" } | null> {
  try {
    const res = await solanaRecipient(
      new Request(`http://internal/api/recipient?owner=${encodeURIComponent(owner)}`),
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { tokenAccount?: unknown; status?: unknown };
    if (typeof body.tokenAccount !== "string") return null;
    if (body.status !== "exists" && body.status !== "missing") return null;
    return { tokenAccount: body.tokenAccount, status: body.status };
  } catch {
    return null;
  }
}
