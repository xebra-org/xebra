import type { PlanRequest } from "../../../lib/near-intents/plan";

/** Reads the four fields both POST routes take, or explains what is missing. */
export async function readPlanRequest(req: Request): Promise<PlanRequest | Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Send JSON." }, { status: 400 });
  }
  const fields = ["amount", "sender", "destinationAsset", "recipient"] as const;
  for (const f of fields) {
    if (typeof body[f] !== "string" || !(body[f] as string).trim()) {
      return Response.json({ error: `Missing ${f}.` }, { status: 400 });
    }
  }
  return {
    amount: (body.amount as string).trim(),
    sender: (body.sender as string).trim(),
    destinationAsset: (body.destinationAsset as string).trim(),
    recipient: (body.recipient as string).trim(),
  };
}

export function failure(err: unknown, status = 422): Response {
  return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status });
}
