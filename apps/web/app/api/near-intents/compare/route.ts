import { compare } from "../../../../lib/near-intents/plan";
import { failure, readPlanRequest } from "../_body";

/** Prices a Stellar USDC swap through NEAR Intents both ways: direct, and with Xebra's leg. */
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const r = await readPlanRequest(req);
  if (r instanceof Response) return r;
  try {
    return Response.json(await compare(r));
  } catch (err) {
    return failure(err);
  }
}
