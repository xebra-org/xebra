import { track } from "../../../../lib/near-intents/plan";
import { failure } from "../_body";

/** Both legs of a swap: Xebra's transfer from Stellar, then NEAR Intents' swap at the deposit. */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const depositAddress = url.searchParams.get("depositAddress")?.trim();
  const tx = url.searchParams.get("tx")?.trim() || undefined;
  if (
    !depositAddress ||
    !/^0x[0-9a-fA-F]{40}$|^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(depositAddress)
  ) {
    return Response.json({ error: "Pass the depositAddress from /prepare." }, { status: 400 });
  }
  if (tx && !/^[0-9a-f]{64}$/i.test(tx)) {
    return Response.json({ error: "tx must be a Stellar transaction hash." }, { status: 400 });
  }
  try {
    return Response.json(await track(depositAddress, tx));
  } catch (err) {
    return failure(err, 502);
  }
}
