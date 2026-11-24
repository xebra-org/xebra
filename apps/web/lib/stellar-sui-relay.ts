import type { DeliveryView } from "./circle-status";

/**
 * The browser's side of Xebra's Sui relayer (`lib/stellar-sui/relayer.ts`). Server-free imports
 * only, so the Stellar form can use it.
 */

const TIMEOUT_MS = 65_000;

/** Whether this deployment pays Sui gas for Stellar to Sui transfers. False on any doubt. */
export async function suiRelayAvailable(): Promise<boolean> {
  try {
    const res = await fetch("/api/stellar-sui/config", { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { relayer?: unknown };
    return body.relayer === true;
  } catch {
    return false;
  }
}

/**
 * Asks the relayer to finish a Stellar to Sui transfer, and answers in the receipt's own terms:
 *
 *  - `pending` / `unknown`: Circle has not signed yet, so `waiting`.
 *  - `submitted` / `delivered`: the USDC is on Sui, with the Sui transaction when we sent it.
 *  - `refused` / `failed`: Xebra cannot finish it, so `claimable`: the receipt then links to
 *    `/claim`, where any Sui wallet still can. The USDC is never stuck on Xebra.
 *
 * A call we could not make at all is `unknown`, which keeps the receipt asking.
 */
export async function relayToSui(txHash: string): Promise<DeliveryView> {
  try {
    const res = await fetch("/api/stellar-sui/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx: txHash }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as {
      status?: string;
      hash?: string;
      reason?: string;
    };
    switch (body.status) {
      case "submitted":
      case "delivered":
        return {
          status: "known",
          state: "delivered",
          forwardTxHash: body.hash ?? null,
          reason: null,
        };
      case "pending":
      case "unknown":
        return { status: "known", state: "waiting", forwardTxHash: null, reason: null };
      case "refused":
      case "failed":
        return {
          status: "known",
          state: "claimable",
          forwardTxHash: null,
          reason: body.reason ?? null,
        };
      default:
        // 404: the relayer was switched off after the box was ticked. Claim by hand instead.
        if (res.status === 404) {
          return { status: "known", state: "claimable", forwardTxHash: null, reason: null };
        }
        return { status: "unknown", reason: `relayer answered ${res.status}` };
    }
  } catch {
    return { status: "unknown", reason: "could not reach the relayer" };
  }
}
