export type ReadJsonResult<T> =
  | { ok: true; body: T }
  | { ok: false; status: number; body: unknown };

/**
 * Safely parses a fetch Response as JSON.
 * Returns `{ ok: true, body }` when the response is 2xx and contains valid JSON.
 * Returns `{ ok: false, status, body }` when the response is not 2xx, empty, or not valid JSON
 * (such as an HTML error page from a gateway outage).
 * It never throws on a non-JSON body.
 */
export async function readJson<T = unknown>(res: Response): Promise<ReadJsonResult<T>> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { ok: false, status: res.status, body: null };
  }

  if (!text || text.trim() === "") {
    return { ok: false, status: res.status, body: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: res.status, body: text };
  }

  if (!res.ok) {
    return { ok: false, status: res.status, body: parsed };
  }

  return { ok: true, body: parsed as T };
}
