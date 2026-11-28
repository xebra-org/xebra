import { pickDestinations } from "../../../../lib/near-intents/destinations";
import * as oneclick from "../../../../lib/near-intents/oneclick";
import { failure } from "../_body";

/**
 * The destinations /near-intents offers (`WANTED` in lib/near-intents/destinations.ts), looked up
 * in NEAR Intents' live token list so an asset id is never stale. An entry Intents stops listing
 * simply drops out.
 */
export const dynamic = "force-dynamic";

export type { Destination } from "../../../../lib/near-intents/destinations";

export async function GET(): Promise<Response> {
  try {
    const destinations = pickDestinations(await oneclick.tokens());
    return Response.json({ destinations }, { headers: { "cache-control": "s-maxage=300" } });
  } catch (err) {
    return failure(err);
  }
}
