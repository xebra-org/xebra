import type { IntentsToken } from "@xebra/sdk/intents";

/**
 * A small client for NEAR Intents' 1Click API (https://docs.near-intents.org), server-side only so
 * the partner key never reaches a browser.
 *
 * 1Click quotes a swap and, for a real (non-dry) quote, hands back a deposit address: whatever
 * arrives there is swapped by NEAR Intents' solvers and delivered to the recipient. Xebra's part is
 * getting the user's USDC to that address from a chain the solvers do not quote.
 */

const BASE_URL = "https://1click.chaindefuser.com";

/** Set `ONECLICK_JWT` to quote on the partner fee schedule; without it 1Click adds 0.25%. */
function headers(): HeadersInit {
  const jwt = process.env.ONECLICK_JWT?.trim();
  return {
    "content-type": "application/json",
    ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
  };
}

export class OneClickError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: headers(),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // fall through with the raw text
  }
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : `1Click answered ${res.status}`;
    throw new OneClickError(message, res.status);
  }
  return body as T;
}

export interface OneClickToken extends IntentsToken {
  price?: number;
}

let tokenCache: { at: number; tokens: OneClickToken[] } | null = null;

/** Every asset NEAR Intents can swap, cached for five minutes. */
export async function tokens(): Promise<OneClickToken[]> {
  if (tokenCache && Date.now() - tokenCache.at < 300_000) return tokenCache.tokens;
  const list = await call<OneClickToken[]>("/v0/tokens");
  tokenCache = { at: Date.now(), tokens: list };
  return list;
}

export interface QuoteRequest {
  dry: boolean;
  swapType: "EXACT_INPUT" | "FLEX_INPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  depositMode?: "SIMPLE" | "MEMO";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN" | "INTENTS";
  recipient: string;
  recipientType: "DESTINATION_CHAIN" | "INTENTS";
  deadline: string;
}

export interface Quote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  minAmountIn?: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd?: string;
  minAmountOut: string;
  timeEstimate: number;
  deadline?: string;
}

export interface QuoteResponse {
  quote: Quote;
  quoteRequest: QuoteRequest;
  correlationId?: string;
}

export function quote(req: QuoteRequest): Promise<QuoteResponse> {
  return call<QuoteResponse>("/v0/quote", { method: "POST", body: JSON.stringify(req) }, 45_000);
}

export type SwapStatus =
  | "KNOWN_DEPOSIT_TX"
  | "PENDING_DEPOSIT"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export interface StatusResponse {
  status: SwapStatus;
  updatedAt: string;
  swapDetails?: {
    amountIn?: string;
    amountInFormatted?: string;
    amountOut?: string;
    amountOutFormatted?: string;
    originChainTxHashes?: { hash: string; explorerUrl: string }[];
    destinationChainTxHashes?: { hash: string; explorerUrl: string }[];
    refundedAmountFormatted?: string;
  };
}

export function status(depositAddress: string, depositMemo?: string): Promise<StatusResponse> {
  const q = new URLSearchParams({ depositAddress, ...(depositMemo ? { depositMemo } : {}) });
  return call<StatusResponse>(`/v0/status?${q}`);
}
