// A type only, erased before anything is bundled: the middleware loads this file, and it must not
// pull the SDK in with it.
import type { ApiErrorCode } from "@xebra/sdk";

/**
 * What `api.xebra.exchange` serves: the versioned API and nothing else. The same Vercel project
 * answers both hosts, so without this the API host would also serve the site, `/admin` included.
 */
export const API_HOST = "api.xebra.exchange";
export const DOCS_API_URL = "https://docs.xebra.exchange/api";
/**
 * Where each error code's docs page lives: the `type` of every problem. The SDK exports the same
 * string, but the middleware answers with these and must not pull the SDK into its bundle.
 */
const ERROR_TYPE_BASE = "https://docs.xebra.exchange/errors/";

export type HostDecision =
  | { action: "pass" }
  | { action: "redirect"; location: string }
  | { action: "not-found" };

export function decideApiHost(pathname: string): HostDecision {
  if (pathname === "/v1" || pathname.startsWith("/v1/")) return { action: "pass" };
  if (pathname === "/" || pathname === "") return { action: "redirect", location: DOCS_API_URL };
  return { action: "not-found" };
}

export function isApiHost(host: string | null): boolean {
  return (host ?? "").toLowerCase().split(":")[0] === API_HOST;
}

const GET_ONLY = ["GET", "HEAD", "OPTIONS"];
const POST_ONLY = ["POST", "OPTIONS"];

/**
 * The `/v1` routes and the methods each answers. Next answers a known path in the wrong method with
 * a bare 405 and no body, which an SDK client that parses problems reports as `invalid_response`,
 * so the middleware reads this table and says which methods the path does answer.
 */
const ROUTES: ReadonlyArray<{ path: RegExp; allow: readonly string[] }> = [
  { path: /^\/v1\/routes$/, allow: GET_ONLY },
  { path: /^\/v1\/quote$/, allow: GET_ONLY },
  { path: /^\/v1\/health$/, allow: GET_ONLY },
  { path: /^\/v1\/openapi\.json$/, allow: GET_ONLY },
  { path: /^\/v1\/transfers$/, allow: POST_ONLY },
  { path: /^\/v1\/transfers\/[^/]+\/[^/]+$/, allow: GET_ONLY },
  { path: /^\/v1\/claims$/, allow: POST_ONLY },
];

/** The methods `pathname` answers, in `Allow` order, or null when the API has no such path. */
export function allowedMethods(pathname: string): readonly string[] | null {
  return ROUTES.find((r) => r.path.test(pathname))?.allow ?? null;
}

/**
 * Every problem carries CORS, the API being called from browsers, and `no-store`; `http.ts` has the
 * same three, kept apart from it for the middleware's bundle.
 */
const PROBLEM_HEADERS = {
  "Content-Type": "application/problem+json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

/**
 * The title of every problem, by code: the words in the docs' error table
 * (`apps/docs/content/docs/errors/index.mdx`). They are kept here, where nothing is imported at run
 * time, so the middleware's problems and `http.ts`'s say the same thing. Being a full record of the
 * SDK's codes, a code added there without a title here does not compile.
 */
export const TITLES: Record<ApiErrorCode, string> = {
  invalid_request: "Invalid request",
  unauthorized: "Unauthorized",
  not_found: "Not found",
  not_ready: "Not ready",
  already_delivered: "Already delivered",
  invalid_amount: "Invalid amount",
  invalid_recipient: "Invalid recipient",
  route_unavailable: "Route unavailable",
  amount_below_minimum: "Amount below the minimum",
  amount_above_maximum: "Amount above the maximum",
  insufficient_balance: "Insufficient balance",
  fee_above_limit: "Fee above your limit",
  transaction_rejected: "Transaction would be rejected",
  rate_limited: "Rate limited",
  internal_error: "Internal error",
  upstream_unavailable: "Upstream unavailable",
};

function problemBody(code: ApiErrorCode, status: number, detail: string) {
  return { type: `${ERROR_TYPE_BASE}${code}`, title: TITLES[code], status, detail, code };
}

/** A path the API does not have. `not_found` is one of the SDK's codes, so clients know it. */
export function notFound(detail: string): Response {
  return Response.json(problemBody("not_found", 404, detail), {
    status: 404,
    headers: PROBLEM_HEADERS,
  });
}

/**
 * A path the API does have, asked for in a method it does not answer. The SDK has no code for 405,
 * so this is `invalid_request` with the `Allow` header saying what the path takes instead.
 */
export function methodNotAllowed(method: string, allow: readonly string[]): Response {
  return Response.json(
    problemBody("invalid_request", 405, `This endpoint does not accept ${method}.`),
    { status: 405, headers: { ...PROBLEM_HEADERS, Allow: allow.join(", ") } },
  );
}
