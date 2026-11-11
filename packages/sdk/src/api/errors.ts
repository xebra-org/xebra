/**
 * Every error code the public API answers with, and its HTTP status. Each code has a docs page at
 * `https://docs.xebra.exchange/errors/<code>`, which is the `type` of the problem response.
 */
export const ERROR_STATUS = {
  invalid_request: 400,
  unauthorized: 401,
  not_found: 404,
  not_ready: 409,
  already_delivered: 409,
  invalid_amount: 422,
  invalid_recipient: 422,
  route_unavailable: 422,
  amount_below_minimum: 422,
  amount_above_maximum: 422,
  insufficient_balance: 422,
  fee_above_limit: 422,
  transaction_rejected: 422,
  rate_limited: 429,
  internal_error: 500,
  upstream_unavailable: 503,
} as const;

export type ApiErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_CODES = Object.keys(ERROR_STATUS) as ApiErrorCode[];

export const ERROR_TYPE_BASE = "https://docs.xebra.exchange/errors/";
