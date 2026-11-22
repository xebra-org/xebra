const SECRET_KEY = /secret|key|token|seed/i;

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value) || depth >= 4) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k)) continue;
    out[k] = sanitizeValue(v, seen, depth + 1);
  }
  return out;
}

function sanitizeCtx(ctx: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!ctx || typeof ctx !== "object") return {};
  const seen = new WeakSet<object>();
  seen.add(ctx);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (SECRET_KEY.test(k)) continue;
    out[k] = sanitizeValue(v, seen, 1);
  }
  return out;
}

function describeThrown(err: unknown): { message: string; name: string | null; cause: unknown } {
  if (err instanceof Error) {
    const rawCause = (err as { cause?: unknown }).cause;
    return {
      message: err.message,
      name: err.name || "Error",
      cause: rawCause !== undefined ? sanitizeValue(rawCause, new WeakSet()) : null,
    };
  }
  if (typeof err === "string") {
    return { message: err, name: null, cause: null };
  }
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    const msg =
      typeof rec.message === "string"
        ? rec.message
        : typeof rec.error === "string"
          ? rec.error
          : JSON.stringify(sanitizeValue(err, new WeakSet()));
    const name = typeof rec.name === "string" ? rec.name : null;
    const cause = rec.cause !== undefined ? sanitizeValue(rec.cause, new WeakSet()) : null;
    return { message: msg ?? "Unknown error", name, cause };
  }
  return {
    message: err === undefined ? "undefined" : String(err),
    name: null,
    cause: null,
  };
}

/**
 * Emits one structured JSON line via `console.error` for server failures without leaking secrets
 * (`secret`, `key`, `token`, `seed`) and without ever throwing.
 */
export function logFailure(
  route: string,
  err: unknown,
  ctx?: Record<string, unknown>,
  request?: Request,
): void {
  try {
    let request_id: string | null = null;
    try {
      request_id = request?.headers?.get("x-vercel-id") ?? null;
    } catch {
      request_id = null;
    }
    const { message, name, cause } = describeThrown(err);
    const safeCtx = sanitizeCtx(ctx);
    const payload = {
      ...safeCtx,
      route,
      request_id,
      message,
      name,
      cause,
    };
    console.error(JSON.stringify(payload));
  } catch {
    // Logging must never crash the caller.
  }
}
