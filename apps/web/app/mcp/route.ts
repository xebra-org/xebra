import { MAX_BODY_BYTES, handleBody } from "../../lib/mcp/protocol";
import { server } from "../../lib/mcp/server";

/**
 * Xebra's MCP server: `https://xebra.exchange/mcp`, Streamable HTTP, stateless, no sign-in.
 *
 * It answers only public facts (routes, prices, a transfer's status) and builds links. It holds no
 * key and cannot sign or send: the person signs on the site, in their own wallet. That is why it
 * asks for no authentication, and why CORS is open: browser-based assistants call it directly, and
 * there is no cookie or credential here for another site to borrow.
 *
 * POST takes a JSON-RPC message (or a batch). GET and DELETE are 405, which the spec allows for a
 * server that offers no event stream and no sessions (`lib/mcp/protocol.ts`).
 */

export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers":
    "content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-session-id",
  "access-control-max-age": "86400",
} as const;

const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return new Response("Request too large", { status: 413, headers: { ...CORS } });
  }
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) {
    return new Response("Request too large", { status: 413, headers: { ...CORS } });
  }
  const { status, json } = await handleBody(body, server);
  return json
    ? Response.json(json, { status, headers: { ...CORS, ...NO_STORE } })
    : new Response(null, { status, headers: { ...CORS, ...NO_STORE } });
}

const notAllowed = () =>
  new Response("This server answers POST requests only.", {
    status: 405,
    headers: { ...CORS, allow: "POST, OPTIONS" },
  });

export const GET = notAllowed;
export const DELETE = notAllowed;

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { ...CORS } });
}
