import { type ApiErrorCode, ERROR_STATUS } from "@xebra/sdk";

export type { ApiErrorCode };

/**
 * The public API's errors. Every one becomes an RFC 9457 problem response whose `type` is a docs
 * page (`https://docs.xebra.exchange/errors/<code>`), and every `detail` is a sentence a person can
 * act on. The MCP tools show the same `detail` text. The codes and their statuses are the SDK's,
 * so the server, the spec and the client cannot disagree.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ApiErrorCode,
    readonly detail: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail);
    this.name = "ApiError";
    this.status = ERROR_STATUS[code];
  }
}
