import { buildAptosFeeStep } from "@xebra/sdk/build";
import { EVM_CHAINS, formatUsdcAmount, isEvmChainId, parseUsdcAmount } from "@xebra/sdk/core";
import { buildAptosTransfer } from "../../../../lib/aptos/build";
import { aptosEnabled, notFound } from "../../../../lib/aptos/config";
import { liveAptosBuildDeps } from "../../../../lib/aptos/live";
import { FeeAddressMissing, flatFeeOn } from "../../../../lib/server/flat-fee";

/** The CCTP domain an Aptos transfer goes to, for Xebra's flat fee (delivered or claimed). */
function domainOf(to: unknown): number {
  if (to === "stellar") return 27;
  if (to === "solana") return 5;
  return typeof to === "string" && isEvmChainId(to) ? EVM_CHAINS[to].cctpDomainId : 6;
}

/**
 * Builds a burn on Aptos for the connected wallet to sign: `POST {sender, amount, to, recipient,
 * maxFee}`. Nothing is signed or sent here; see `lib/aptos/build.ts` for every check it makes.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  if (!aptosEnabled()) return notFound();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: "Send JSON with sender, amount, to, recipient and maxFee." },
      { status: 400 },
    );
  }

  try {
    // What the person entered leaves the wallet: the burn is the rest of it after Xebra's flat
    // fee, which is its own transaction (Circle's burn is a fixed script), signed after the burn.
    const entered = typeof body.amount === "string" ? parseUsdcAmount(body.amount) : null;
    const flat = flatFeeOn("aptos", domainOf(body.to), entered ?? 0n);
    if (entered === null || entered <= flat.fee) {
      return Response.json(
        { error: `Send more than Xebra's ${formatUsdcAmount(flat.fee)} USDC fee.` },
        { status: 422 },
      );
    }
    const answer = await buildAptosTransfer(
      { ...body, amount: formatUsdcAmount(entered - flat.fee) },
      liveAptosBuildDeps(),
    );
    if (!("transaction" in answer.body)) {
      return Response.json(answer.body, { status: answer.status });
    }
    const fee = buildAptosFeeStep({ feeAddress: flat.address, fee: flat.fee });
    return Response.json(
      { ...answer.body, xebraFee: flat.fee.toString(), feeTransaction: fee.tx },
      { status: answer.status },
    );
  } catch (err) {
    if (err instanceof FeeAddressMissing) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("aptos build failed", err);
    return Response.json(
      { error: "Could not prepare the transfer. Nothing was burned; try again in a moment." },
      { status: 502 },
    );
  }
}
