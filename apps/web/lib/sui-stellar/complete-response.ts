import { IrisUnavailable } from "@xebra/cctp-client";
import type { CompleteResult } from "./stellar-side";

/**
 * Maps a `completeBurn` outcome to its HTTP status and optional `Retry-After` header.
 *
 *  - 200 `delivered` or `submitted`: the mint is on Stellar, or on its way there.
 *  - 202 `pending` or `unknown`: nothing is wrong and nothing has happened yet, so ask again. That
 *    covers Circle not having attested or indexed the burn, and a completion already under way.
 *  - 422 `refused`: this burn cannot be completed as it stands.
 *  - 502 `failed`: the mint was sent and did not land.
 *  - 503 `pending` with `retryAfterMs`: something we depend on asked us to wait, and `Retry-After`
 *    says for how long.
 */
export function completeResultResponse(result: CompleteResult): Response {
  const retryAfter = result.status === "pending" ? result.retryAfterMs : undefined;
  const status =
    result.status === "refused"
      ? 422
      : result.status === "failed"
        ? 502
        : retryAfter !== undefined
          ? 503
          : result.status === "pending" || result.status === "unknown"
            ? 202
            : 200;
  const headers =
    retryAfter !== undefined
      ? { "Retry-After": String(Math.max(1, Math.ceil(retryAfter / 1000))) }
      : undefined;
  return Response.json(result, { status, ...(headers ? { headers } : {}) });
}

/**
 * What a complete route answers when `completeBurn` throws.
 *
 * Circle's lookups being paused (our own Iris budget, or a 429 from Circle) is not a failed
 * transfer: the attestation was never read, so nothing was tried. It answers 503 with `Retry-After`
 * and `status: "pending"`. The status matters to the pages as much as the code does: they stop
 * polling and show the transfer as stuck on `failed`, and keep asking on `pending`.
 */
export function completeErrorResponse(err: unknown): Response {
  if (err instanceof IrisUnavailable) {
    return completeResultResponse({
      status: "pending",
      retryAfterMs: err.retryAfterMs,
      reason: "Circle lookups are paused for a moment. Try again shortly.",
    });
  }
  return Response.json(
    { status: "failed", reason: "Could not complete the transfer. It is safe to try again." },
    { status: 502 },
  );
}
