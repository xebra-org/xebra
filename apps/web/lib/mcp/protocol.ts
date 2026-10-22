/**
 * The Model Context Protocol, the small part of it a stateless remote server needs.
 *
 * MCP is JSON-RPC 2.0. Over the Streamable HTTP transport a client POSTs one message (or a batch)
 * and a server may answer with plain JSON, which is all this does: no session, no stream, no state
 * held between requests. That is what lets it run as an ordinary route on any instance. Methods
 * handled: `initialize`, `ping`, `tools/list`, `tools/call`, and the `notifications/*` a client
 * sends, which get no reply.
 *
 * It is written out here, not pulled from an SDK, because it is a few dozen lines and the build
 * this runs in has no reason to take a dependency for them. The version negotiation follows the
 * spec: answer with the client's version if this knows it, else with the newest it does.
 */

export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export type JsonSchema = { [key: string]: unknown };

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /** MCP tool hints. Every tool here is read-only: none of them moves money. */
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ServerInfo {
  name: string;
  title: string;
  version: string;
}

export interface Server {
  info: ServerInfo;
  /** Shown to the model once, on connect. Say what the server is for and what it will not do. */
  instructions: string;
  tools: readonly Tool[];
}

type Id = string | number | null;

export type RpcResponse =
  | { jsonrpc: "2.0"; id: Id; result: unknown }
  | { jsonrpc: "2.0"; id: Id; error: { code: number; message: string; data?: unknown } };

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

const fail = (id: Id, code: number, message: string): RpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** What a tool call returns when the tool itself fails, so the model sees it and can recover. */
export const toolError = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export function toolOk(text: string, structured?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/**
 * One message in, one response out, or `null` for a notification (a message with no `id`), which
 * the transport answers with 202 and no body.
 */
export async function handleMessage(message: unknown, server: Server): Promise<RpcResponse | null> {
  if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return fail(null, INVALID_REQUEST, "Not a JSON-RPC 2.0 request.");
  }
  const hasId = "id" in message;
  const id: Id =
    typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
  if (hasId && id === null) return fail(null, INVALID_REQUEST, "id must be a string or number.");
  if (!hasId) return null; // a notification: nothing to answer, whatever it said

  const params = isObject(message.params) ? message.params : {};

  switch (message.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = (SUPPORTED_VERSIONS as readonly string[]).includes(asked)
        ? asked
        : SUPPORTED_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: server.info,
          instructions: server.instructions,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: server.tools.map(({ run: _run, ...tool }) => tool),
        },
      };
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") return fail(id, INVALID_PARAMS, "name is required.");
      const tool = server.tools.find((t) => t.name === name);
      if (!tool) return fail(id, INVALID_PARAMS, `Unknown tool: ${name}`);
      if (params.arguments !== undefined && !isObject(params.arguments)) {
        return fail(id, INVALID_PARAMS, "arguments must be an object.");
      }
      try {
        return { jsonrpc: "2.0", id, result: await tool.run(params.arguments ?? {}) };
      } catch {
        // A tool that throws is ours to fix, not the model's to read. Say little.
        return {
          jsonrpc: "2.0",
          id,
          result: toolError("That lookup failed on our side. Try again in a moment."),
        };
      }
    }
    default:
      return fail(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
  }
}

/** Largest request body accepted. A tool call is a few hundred bytes. */
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * The whole POST: parse, handle one message or a batch, and say what status and body to send.
 * `body` is the raw text so a malformed one is a JSON-RPC error rather than a crash.
 */
export async function handleBody(
  body: string,
  server: Server,
): Promise<{ status: number; json?: RpcResponse | RpcResponse[] }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: 400, json: fail(null, PARSE_ERROR, "Body is not valid JSON.") };
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0 || parsed.length > 20) {
      return { status: 400, json: fail(null, INVALID_REQUEST, "A batch holds 1 to 20 messages.") };
    }
    const out = (await Promise.all(parsed.map((m) => handleMessage(m, server)))).filter(
      (r): r is RpcResponse => r !== null,
    );
    return out.length === 0 ? { status: 202 } : { status: 200, json: out };
  }
  const reply = await handleMessage(parsed, server);
  return reply === null ? { status: 202 } : { status: 200, json: reply };
}
