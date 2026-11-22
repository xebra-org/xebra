import { OneClickError } from "../../../lib/near-intents/oneclick";
import type { PlanRequest } from "../../../lib/near-intents/plan";

/**
 * Reads the fields both POST routes take, or explains what is missing. `from` is optional and
 * means Stellar when absent, so callers from before it existed keep working.
 */
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
  if (body.from !== undefined && (typeof body.from !== "string" || !body.from.trim())) {
    return Response.json({ error: "from must name a chain, e.g. arc." }, { status: 400 });
  }
  return {
    ...(typeof body.from === "string" ? { from: body.from.trim() } : {}),
    amount: (body.amount as string).trim(),
    sender: (body.sender as string).trim(),
    destinationAsset: (body.destinationAsset as string).trim(),
    recipient: (body.recipient as string).trim(),
  };
}

function isTimeout(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return true;
    if (/timeout/i.test(err.message)) return true;
  }
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    if (err.name === "TimeoutError") return true;
  }
  return false;
}

export function failure(err: unknown, _status?: number): Response {
  if (err instanceof OneClickError) {
    const status = err.status >= 500 ? 502 : 422;
    return Response.json({ error: err.message }, { status });
  }

  if (isTimeout(err)) {
    return Response.json(
      { error: err instanceof Error ? err.message : "The operation was aborted due to timeout" },
      { status: 504 },
    );
  }

  console.error("near intents failed", err);
  return Response.json({ error: "An unexpected error occurred." }, { status: 500 });
}
