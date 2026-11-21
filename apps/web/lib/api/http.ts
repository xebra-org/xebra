import { ERROR_TYPE_BASE } from "@xebra/sdk";
import { logFailure } from "../server/log";
import { ApiError } from "./errors";
import { TITLES } from "./host";
import { extraToWire } from "./wire";

/**
 * The HTTP edge of the public API: read the input, check it against the SDK's schema, run, check
 * the output against its schema, and answer. Every failure is an RFC 9457 problem; nothing escapes
 * as a bare 500 page or a stack trace.
 */

/** What this needs from a zod schema, without depending on zod's own types here. */
export interface Parser<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
}

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
  "Access-Control-Max-Age": "86400",
};

/** Bodies are a few hundred bytes; anything near this is not a request we want to parse. */
const MAX_BODY_BYTES = 16 * 1024;
/** Fields whose problems are about the amount, which a caller fixes differently from a typo. */
const AMOUNT_FIELDS = new Set(["amount", "maxTotalFee"]);

/** What an id may look like. Vercel's are regions and a token joined by `::`, about 50 characters. */
const REQUEST_ID = /^[A-Za-z0-9:._-]{1,200}$/;

/**
 * An id for one request. The problem it is answered with carries it, and so does the line we log
 * for it, so a report from an integrator can be matched to that line.
 *
 * It is Vercel's own id for the request (`x-vercel-id`) when there is one, which is also what
 * Vercel's request log is searched by. Anywhere else, a local server or a test, it is a random
 * one. A value that does not look like an id is not used: away from Vercel the header is whatever
 * the caller sent, and it is echoed back.
 */
export function requestId(req?: Request): string {
  const sent = req?.headers.get("x-vercel-id");
  return sent && REQUEST_ID.test(sent) ? sent : crypto.randomUUID();
}

/** The `instance` of a problem (RFC 9457): a URI for this one occurrence of it. */
function instanceOf(id: string): string {
  return `urn:xebra:request:${id}`;
}

export function problem(
  err: ApiError,
  headers: Record<string, string> = {},
  id: string = requestId(),
): Response {
  return Response.json(
    {
      type: `${ERROR_TYPE_BASE}${err.code}`,
      // Every code has a title (`host.ts`, where the middleware can read it too).
      title: TITLES[err.code],
      status: err.status,
      detail: err.detail,
      code: err.code,
      ...extraToWire(err.extra),
      // Last, so no extra field can replace it: the header and the log line carry the same id.
      instance: instanceOf(id),
    },
    {
      status: err.status,
      headers: {
        ...CORS,
        // A browser lets a script read only a short list of response headers; this is not on it.
        "Access-Control-Expose-Headers": "X-Request-Id",
        "X-Request-Id": id,
        "Content-Type": "application/problem+json",
        "Cache-Control": "no-store",
        ...(err.status === 503 ? { "Retry-After": "10" } : {}),
        ...headers,
      },
    },
  );
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

function invalid(issues: Array<{ path: PropertyKey[]; message: string }>): ApiError {
  const amountIssue = issues.find((i) => AMOUNT_FIELDS.has(String(i.path[0])));
  if (amountIssue) {
    return new ApiError(
      "invalid_amount",
      `${String(amountIssue.path[0])}: ${amountIssue.message}.`,
    );
  }
  const detail = issues
    .slice(0, 5)
    .map((i) => (i.path.length > 0 ? `${i.path.map(String).join(".")}: ${i.message}` : i.message))
    .join("; ");
  return new ApiError("invalid_request", `${detail}.`);
}

async function readBody(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new ApiError("invalid_request", "The body is too large.");
  // Read in chunks and stop at the cap: a chunked upload declares no length.
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError("invalid_request", "The body is too large.");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError("invalid_request", "The body is not valid JSON.");
  }
}

export async function handle<I, O>(
  req: Request,
  opts: {
    /** Where the input comes from. Path parameters are passed in `params`. */
    from: "none" | "query" | "body" | "params";
    params?: Record<string, string>;
    input?: Parser<I>;
    run(input: I): Promise<O>;
    output: Parser<O>;
    /** `Cache-Control` for a success. */
    cache?: string;
  },
): Promise<Response> {
  try {
    let raw: unknown = {};
    if (opts.from === "query") raw = Object.fromEntries(new URL(req.url).searchParams);
    if (opts.from === "body") raw = await readBody(req);
    if (opts.from === "params") raw = opts.params ?? {};
    let input = raw as I;
    if (opts.input) {
      const parsed = opts.input.safeParse(raw);
      if (!parsed.success) throw invalid(parsed.error.issues);
      input = parsed.data;
    }

    const result = await opts.run(input);
    const checked = opts.output.safeParse(result);
    if (!checked.success) {
      // Our bug, not the caller's: say so plainly, and log what was wrong.
      console.error("v1 response failed its schema", req.url, checked.error.issues);
      throw new ApiError("internal_error", "The answer failed our own checks. Nothing was sent.");
    }
    return Response.json(checked.data, {
      headers: { ...CORS, "Cache-Control": opts.cache ?? "no-store" },
    });
  } catch (err) {
    const id = requestId(req);
    const answer =
      err instanceof ApiError
        ? err
        : new ApiError("internal_error", "Something went wrong on our side. Nothing was sent.");
    // One line for every 5xx, with the id the caller was given, so quoting `instance` or
    // `X-Request-Id` finds it. An error we did not raise ourselves is logged with its stack.
    if (answer.status >= 500) {
      logFailure(
        new URL(req.url).pathname,
        err,
        {
          instance: instanceOf(id),
          code: answer.code,
          status: answer.status,
          url: req.url,
          ...(err instanceof Error && !(err instanceof ApiError) ? { stack: err.stack } : {}),
        },
        req,
      );
    }
    return problem(answer, {}, id);
  }
}
