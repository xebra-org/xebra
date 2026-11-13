import { buildAptosTransfer } from "../../../../lib/aptos/build";
import { aptosEnabled, notFound } from "../../../../lib/aptos/config";
import { liveAptosBuildDeps } from "../../../../lib/aptos/live";

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
    const answer = await buildAptosTransfer(body, liveAptosBuildDeps());
    return Response.json(answer.body, { status: answer.status });
  } catch (err) {
    console.error("aptos build failed", err);
    return Response.json(
      { error: "Could not prepare the transfer. Nothing was burned; try again in a moment." },
      { status: 502 },
    );
  }
}
