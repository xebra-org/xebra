import { env } from "../../../lib/env";

/**
 * A pass-through to Solana's JSON-RPC, for the browser.
 *
 * # Why this has to exist
 *
 * Solana's public RPC **blocks browser requests**: it answers the CORS preflight with 200 and then
 * returns **403 on the actual POST** whenever an `Origin` header is present. So a page cannot read
 * an account, fetch a blockhash or send a transaction directly, which is everything the `/claim`
 * page needs to do.
 *
 * `/api/recipient` exists for the same reason and predates this route; it stays because it also
 * encodes the three-state answer the bridge form needs.
 *
 * # What it does and does not allow
 *
 * Only the methods the claim flow uses, by name. An unrestricted proxy would be an open relay to
 * whatever RPC endpoint is configured — including a paid one, whose quota is then anybody's to
 * spend. The list is short on purpose and adding to it should be deliberate.
 *
 * `sendTransaction` is on the list, which sounds alarming and is not: the transaction arrives
 * already signed by the user's wallet, this route cannot alter it without invalidating the
 * signature, and anyone can broadcast a signed Solana transaction from anywhere. Refusing it here
 * would remove no capability from an attacker and would break the claim page.
 */

export const dynamic = "force-dynamic";

const ALLOWED_METHODS = new Set([
  "getAccountInfo",
  "getLatestBlockhash",
  "getFeeForMessage",
  "getSignatureStatuses",
  "getMinimumBalanceForRentExemption",
  "sendTransaction",
  "simulateTransaction",
]);

/** Bodies are a few hundred bytes; anything near this is not a request we want to parse. */
const MAX_BODY_BYTES = 16 * 1024;

async function readBody(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new Error("The body is too large.");
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
        throw new Error("The body is too large.");
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
    throw new Error("invalid JSON");
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await readBody(request);
  } catch (err) {
    const error = err instanceof Error ? err.message : "invalid JSON";
    return Response.json({ error }, { status: 400 });
  }

  // web3.js batches some calls, so an array is a normal request shape, not an attack.
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > 10) {
    return Response.json({ error: "expected between 1 and 10 RPC calls" }, { status: 400 });
  }

  for (const call of calls) {
    const method =
      typeof call === "object" && call !== null
        ? (call as Record<string, unknown>).method
        : undefined;
    if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) {
      return Response.json({ error: `method not allowed: ${String(method)}` }, { status: 403 });
    }
  }

  try {
    const res = await fetch(env.solanaRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 401 || res.status === 403 || res.status >= 500) {
      const text = await res.text().catch(() => "");
      console.error("Solana RPC upstream failure", res.status, text);
      return Response.json({ error: "Solana's network is not answering" }, { status: 502 });
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after") ?? "10";
      const text = await res.text().catch(() => "");
      console.error("Solana RPC rate limited", res.status, text);
      return Response.json(
        { error: "Solana's network is rate limited" },
        {
          status: 429,
          headers: {
            "retry-after": retryAfter,
          },
        },
      );
    }

    // Forwarded verbatim, including an error body: web3.js parses JSON-RPC errors itself and
    // rewriting them here would turn a precise on-chain failure into a vague one.
    return new Response(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("Solana RPC request failed", err);
    return Response.json({ error: "Solana's network is not answering" }, { status: 502 });
  }
}
