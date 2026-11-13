import { track } from "../../../../lib/near-intents/plan";
import { failure } from "../_body";

/**
 * Both legs of a swap: Xebra's transfer from the source chain (`from`, default Stellar), then NEAR
 * Intents' swap at the deposit.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const depositAddress = url.searchParams.get("depositAddress")?.trim();
  const tx = url.searchParams.get("tx")?.trim() || undefined;
  const from = url.searchParams.get("from")?.trim() || "stellar";
  if (
    !depositAddress ||
    !/^0x[0-9a-fA-F]{40}$|^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(depositAddress)
  ) {
    return Response.json({ error: "Pass the depositAddress from /prepare." }, { status: 400 });
  }
  const stellar = from === "stellar";
  if (tx && !(stellar ? /^[0-9a-f]{64}$/i : /^0x[0-9a-f]{64}$/i).test(tx)) {
    return Response.json(
      { error: stellar ? "tx must be a Stellar transaction hash." : "tx must be a 0x hash." },
      { status: 400 },
    );
  }
  try {
    return Response.json(await track(depositAddress, tx, from));
  } catch (err) {
    return failure(err, 502);
  }
}
