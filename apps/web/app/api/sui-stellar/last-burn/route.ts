import { notFound, suiStellarEnabled } from "../../../../lib/sui-stellar/config";
import { SUI_ADDRESS, lastBurn } from "../../../../lib/sui-stellar/last-burn";

/**
 * The newest CCTP burn a Sui address has sent: `{ burn: { digest, destinationDomain } | null }`.
 * The Sui page reads it before signing and again after a wallet error, to tell a transfer that went
 * through anyway from one that did not. Public data; 502 when Sui does not answer.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!suiStellarEnabled()) return notFound();
  const sender = new URL(request.url).searchParams.get("sender")?.trim() ?? "";
  if (!SUI_ADDRESS.test(sender)) {
    return Response.json({ error: "That is not a Sui address." }, { status: 400 });
  }
  try {
    return Response.json({ burn: await lastBurn(sender) });
  } catch {
    return Response.json({ error: "Sui did not answer" }, { status: 502 });
  }
}
