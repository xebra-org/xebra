import { prepare } from "../../../../lib/near-intents/plan";
import { failure, readPlanRequest } from "../_body";

/**
 * Takes a real NEAR Intents quote (it issues a deposit address) and builds the Stellar transaction
 * that sends the user's USDC there through Xebra. Nothing is signed or sent here.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const r = await readPlanRequest(req);
  if (r instanceof Response) return r;
  try {
    return Response.json(await prepare(r));
  } catch (err) {
    return failure(err);
  }
}
