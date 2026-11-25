import { stellarSuiRelayOn } from "../../../../lib/stellar-sui/relayer";

/**
 * Whether Xebra pays the Sui gas for Stellar to Sui transfers here, so the Stellar form knows to
 * offer the "Pay the Sui network fee for me" box. Always 200; nothing secret.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(
    { relayer: stellarSuiRelayOn() },
    { headers: { "cache-control": "no-store" } },
  );
}
