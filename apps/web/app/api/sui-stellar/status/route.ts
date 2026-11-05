import { SUI_DIGEST, readAttestation } from "../../../../lib/sui-stellar/attestation";
import { notFound, suiStellarEnabled } from "../../../../lib/sui-stellar/config";

/** Circle's attestation state for a Sui burn: unknown, pending, or complete. Public data. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!suiStellarEnabled()) return notFound();
  const digest = new URL(request.url).searchParams.get("digest")?.trim() ?? "";
  if (!SUI_DIGEST.test(digest)) {
    return Response.json({ error: "That is not a Sui transaction digest." }, { status: 400 });
  }
  try {
    const att = await readAttestation(digest);
    return Response.json(
      att.state === "complete"
        ? { state: "complete" }
        : att.state === "pending"
          ? { state: "pending" }
          : { state: "unknown", reason: att.reason },
    );
  } catch {
    return Response.json({ state: "unknown", reason: "Circle did not answer" }, { status: 502 });
  }
}
