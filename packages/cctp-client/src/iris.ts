/**
 * Thin client for Circle's Iris attestation API (CCTP V2). Injectable `fetchImpl` so callers
 * (and this package's own tests) never depend on a live network call.
 */

export interface IrisMessage {
  message: `0x${string}`;
  attestation: `0x${string}` | null;
  eventNonce: string;
  status: "pending_confirmations" | "complete";
}

export interface IrisClientOptions {
  /** Request timeout in milliseconds. Defaults to 15,000ms. */
  timeoutMs?: number;
}

export interface IrisClient {
  /** Fetches CCTP messages emitted by `transactionHash` on `sourceDomainId`. Attestation is
   *  `null` until Circle's attestation service has signed off — poll until `status === "complete"`. */
  getMessages(
    sourceDomainId: number,
    transactionHash: string,
    options?: { timeoutMs?: number },
  ): Promise<IrisMessage[]>;
}

export type IrisErrorCode = "not_found" | "rate_limited" | "upstream" | "timeout";

export class IrisApiError extends Error {
  constructor(
    public readonly status: number,
    body: string,
    public readonly code: IrisErrorCode = status === 404
      ? "not_found"
      : status === 429
        ? "rate_limited"
        : status === 0 || status === 408 || status === 504
          ? "timeout"
          : "upstream",
  ) {
    super(`Iris API error ${status} (${code}): ${body}`);
    this.name = "IrisApiError";
  }
}

export function createIrisClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  options: IrisClientOptions = {},
): IrisClient {
  const defaultTimeoutMs = options.timeoutMs ?? 15_000;
  return {
    async getMessages(sourceDomainId, transactionHash, getOpts) {
      const timeoutMs = getOpts?.timeoutMs ?? defaultTimeoutMs;
      const signal = AbortSignal.timeout(timeoutMs);
      const encodedHash = encodeURIComponent(transactionHash);
      const url = `${baseUrl}/v2/messages/${sourceDomainId}?transactionHash=${encodedHash}`;
      let res: Response;
      try {
        res = await fetchImpl(url, { signal });
      } catch (err) {
        if (
          signal.aborted ||
          (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
        ) {
          throw new IrisApiError(0, `Iris lookup timed out after ${timeoutMs}ms`, "timeout");
        }
        throw err;
      }
      if (!res.ok) {
        const body = await res.text();
        const code: IrisErrorCode =
          res.status === 404 ? "not_found" : res.status === 429 ? "rate_limited" : "upstream";
        throw new IrisApiError(res.status, body, code);
      }
      const body = (await res.json()) as { messages?: IrisMessage[] };
      return body.messages ?? [];
    },
  };
}
