/**
 * The public API's errors. Every one becomes an RFC 9457 problem response whose `type` is a docs
 * page (`https://docs.xebra.exchange/errors/<code>`), and every `detail` is a sentence a person can
 * act on. The MCP tools show the same `detail` text.
 */
export type ApiErrorCode =
  | "invalid_request"
  | "invalid_amount"
  | "invalid_recipient"
  | "route_unavailable"
  | "amount_below_minimum"
  | "amount_above_maximum"
  | "insufficient_balance"
  | "upstream_unavailable"
  | "not_found"
  | "rate_limited"
  | "unauthorized";

export const ERROR_STATUS: Record<ApiErrorCode, number> = {
  invalid_request: 400,
  invalid_amount: 422,
  invalid_recipient: 422,
  route_unavailable: 422,
  amount_below_minimum: 422,
  amount_above_maximum: 422,
  insufficient_balance: 422,
  upstream_unavailable: 503,
  not_found: 404,
  rate_limited: 429,
  unauthorized: 401,
};

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
