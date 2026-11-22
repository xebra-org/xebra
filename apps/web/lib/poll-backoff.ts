import type { ClassifiedError } from "./wallet-error";

/**
 * Timeouts and polling backoff shared by the bridge forms (Solana, Aptos).
 *
 * Two rules keep these safe with real money:
 * - Only a request made before anything is handed to the wallet may say "Nothing was sent" when it
 *   times out. `fetchBeforeSigning` is for that request alone (the build fetch); a timeout after
 *   signing or broadcasting stays with the wallet-error classifier, which says "check your wallet".
 * - A status poll that keeps failing is not a failed transfer: the page keeps asking, more slowly,
 *   and says it cannot reach the status service.
 */

/** How long the build request may take before the form gives up on it. */
export const BUILD_TIMEOUT_MS = 15_000;

/** Consecutive failed polls before the "can't reach the status service" notice shows. */
export const POLL_FAILURE_THRESHOLD = 5;
export const POLL_BASE_MS = 5000;
export const POLL_MAX_MS = 30_000;

/** The delay before the next poll: the base interval, doubled per consecutive failure, capped. */
export function nextPollDelay(
  consecutiveFailures: number,
  baseMs = POLL_BASE_MS,
  maxMs = POLL_MAX_MS,
): number {
  if (consecutiveFailures <= 0) return baseMs;
  const backoff = baseMs * 2 ** Math.min(consecutiveFailures, 4);
  return Math.min(backoff, maxMs);
}

export function shouldShowPollNotice(
  consecutiveFailures: number,
  threshold = POLL_FAILURE_THRESHOLD,
): boolean {
  return consecutiveFailures >= threshold;
}

/** What the form shows when the build request timed out. Nothing was signed, so nothing was sent. */
export const BUILD_TIMED_OUT: ClassifiedError = {
  kind: "timeout",
  message: "Xebra did not answer in time. Nothing was sent.",
  maybeSent: false,
  raw: "build request timed out",
};

function isAbort(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    ((err as { name: unknown }).name === "TimeoutError" ||
      (err as { name: unknown }).name === "AbortError")
  );
}

/** `body` is null when the answer was not JSON (a proxy's HTML error page, say). */
export type BeforeSigning<T> =
  | { timedOut: true }
  | { timedOut: false; res: Response; body: T | null };

/**
 * POSTs JSON and reads the JSON answer under one timeout. Use it only for a request made before
 * anything is signed: `timedOut: true` is the one case where the form may say nothing was sent.
 * Any other failure (a network error, say) is thrown, for the caller's usual error handling.
 */
export async function fetchBeforeSigning<T>(
  url: string,
  payload: unknown,
  ms = BUILD_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<BeforeSigning<T>> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ms),
    });
    let body: T | null = null;
    try {
      body = (await res.json()) as T;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
    return { timedOut: false, res, body };
  } catch (err) {
    if (isAbort(err)) return { timedOut: true };
    throw err;
  }
}
