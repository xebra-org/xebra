import type { CircleHealth, Delivery } from "@xebra/cctp-client";

/**
 * The browser's view of three server routes that call Circle for it: how a burn is getting on,
 * whether it is safe to start one, and (for an expired Fast attestation) asking for a fresh one.
 * All are budgeted server-side (`lib/server/iris.ts`), so polling them cannot get us rate limited.
 *
 * None ever throws. The burn is already on chain by the time the first runs, and a failed status
 * check says nothing about the money; the second must never become a reason a working product
 * refuses to work.
 */

const STATUS_TIMEOUT_MS = 12_000;

export type DeliveryView =
  | ({ status: "known" } & Delivery)
  /** Could not ask. Deliberately not "waiting" — an unanswerable question is not progress. */
  | { status: "unknown"; reason: string };

/**
 * `sourceDomain` names the chain the burn was made on. Omitted for a Stellar burn, which is what a
 * bare hash has always meant.
 */
export async function getDelivery(txHash: string, sourceDomain?: number): Promise<DeliveryView> {
  try {
    const q = new URLSearchParams({ tx: txHash });
    if (sourceDomain !== undefined) q.set("src", String(sourceDomain));
    const res = await fetch(`/api/delivery?${q}`, {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) return { status: "unknown", reason: `status returned ${res.status}` };
    const body = (await res.json()) as DeliveryView;
    if (body.status === "known" && typeof body.state === "string") return body;
    return { status: "unknown", reason: "no answer" };
  } catch {
    return { status: "unknown", reason: "could not reach the status service" };
  }
}

/**
 * Whether Circle looks able to carry a transfer between two CCTP domains right now. The answer
 * carries both speeds (`tiers`), each with its own fee; a Stellar burn only ever uses Standard.
 *
 * Returns `null` when the check itself could not be run. That is not `down`: our own server being
 * unreachable says nothing about Circle, and refusing to send on that basis would make this check a
 * single point of failure for the product.
 */
export async function getRouteHealth(
  sourceDomain: number,
  destinationDomain: number,
  /** Solana only: price Circle opening the recipient's USDC account as well. */
  newAccount = false,
): Promise<CircleHealth | null> {
  try {
    const q = new URLSearchParams({ src: String(sourceDomain), dst: String(destinationDomain) });
    if (newAccount) q.set("newAccount", "1");
    const res = await fetch(`/api/circle-health?${q}`, {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as CircleHealth;
    return body.status === "ok" || body.status === "degraded" || body.status === "down"
      ? body
      : null;
  } catch {
    return null;
  }
}

/**
 * Asks Circle, through our server, to attest an expired message again. Never throws: the answer is
 * either that it was asked, or a sentence about why not.
 */
export async function requestReattest(
  nonce: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await fetch("/api/reattest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
    });
    const body = (await res.json().catch(() => null)) as { reason?: unknown } | null;
    if (res.ok) return { ok: true };
    return {
      ok: false,
      reason: typeof body?.reason === "string" ? body.reason : `the request returned ${res.status}`,
    };
  } catch {
    return { ok: false, reason: "could not reach the server" };
  }
}
