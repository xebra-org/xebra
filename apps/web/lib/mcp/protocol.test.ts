import { describe, expect, it } from "vitest";
import {
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  SUPPORTED_VERSIONS,
  type Server,
  handleBody,
  handleMessage,
  toolOk,
} from "./protocol";

const server: Server = {
  info: { name: "t", title: "T", version: "1" },
  instructions: "use it",
  tools: [
    {
      name: "echo",
      title: "Echo",
      description: "Echoes.",
      inputSchema: { type: "object" },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      run: async (args) => toolOk(`got ${JSON.stringify(args)}`, { args }),
    },
    {
      name: "boom",
      title: "Boom",
      description: "Throws.",
      inputSchema: { type: "object" },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      run: async () => {
        throw new Error("secret internal detail");
      },
    },
  ],
};

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

describe("initialize", () => {
  it("answers with the client's version when it is known", async () => {
    const res = await handleMessage(rpc("initialize", { protocolVersion: "2025-03-26" }), server);
    expect(res).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-03-26", serverInfo: { name: "t" }, instructions: "use it" },
    });
  });

  it("answers with the newest version for one it does not know", async () => {
    const res = await handleMessage(rpc("initialize", { protocolVersion: "1999-01-01" }), server);
    expect(res).toMatchObject({ result: { protocolVersion: SUPPORTED_VERSIONS[0] } });
  });

  it("advertises tools and nothing else", async () => {
    const res = await handleMessage(rpc("initialize", {}), server);
    expect((res as { result: { capabilities: object } }).result.capabilities).toEqual({
      tools: { listChanged: false },
    });
  });
});

describe("tools", () => {
  it("lists tools without their run function", async () => {
    const res = await handleMessage(rpc("tools/list"), server);
    const tools = (res as { result: { tools: Array<Record<string, unknown>> } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(["echo", "boom"]);
    expect(tools[0]).not.toHaveProperty("run");
    expect(tools[0]).toHaveProperty("inputSchema");
  });

  it("calls a tool", async () => {
    const res = await handleMessage(
      rpc("tools/call", { name: "echo", arguments: { a: 1 } }),
      server,
    );
    expect(res).toMatchObject({
      result: {
        content: [{ type: "text", text: 'got {"a":1}' }],
        structuredContent: { args: { a: 1 } },
      },
    });
  });

  it("treats missing arguments as an empty object", async () => {
    const res = await handleMessage(rpc("tools/call", { name: "echo" }), server);
    expect(res).toMatchObject({ result: { content: [{ text: "got {}" }] } });
  });

  it("rejects an unknown tool and bad arguments as invalid params", async () => {
    expect(await handleMessage(rpc("tools/call", { name: "nope" }), server)).toMatchObject({
      error: { code: INVALID_PARAMS },
    });
    expect(await handleMessage(rpc("tools/call", {}), server)).toMatchObject({
      error: { code: INVALID_PARAMS },
    });
    expect(
      await handleMessage(rpc("tools/call", { name: "echo", arguments: [1] }), server),
    ).toMatchObject({ error: { code: INVALID_PARAMS } });
  });

  it("hides what a throwing tool threw", async () => {
    const res = await handleMessage(rpc("tools/call", { name: "boom" }), server);
    expect(JSON.stringify(res)).not.toContain("secret internal detail");
    expect(res).toMatchObject({ result: { isError: true } });
  });
});

describe("the rest of JSON-RPC", () => {
  it("answers ping", async () => {
    expect(await handleMessage(rpc("ping"), server)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("does not answer a notification", async () => {
    expect(
      await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, server),
    ).toBeNull();
  });

  it("refuses an unknown method and a malformed request", async () => {
    expect(await handleMessage(rpc("resources/list"), server)).toMatchObject({
      error: { code: METHOD_NOT_FOUND },
    });
    expect(await handleMessage({ id: 1, method: "ping" }, server)).toMatchObject({
      error: { code: INVALID_REQUEST },
    });
    expect(await handleMessage("ping", server)).toMatchObject({ error: { code: INVALID_REQUEST } });
    expect(await handleMessage({ jsonrpc: "2.0", id: {}, method: "ping" }, server)).toMatchObject({
      error: { code: INVALID_REQUEST },
    });
  });
});

describe("handleBody", () => {
  it("returns 202 and no body for a lone notification", async () => {
    const res = await handleBody(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      server,
    );
    expect(res).toEqual({ status: 202 });
  });

  it("returns a parse error for bad JSON", async () => {
    const res = await handleBody("{nope", server);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: { code: PARSE_ERROR } });
  });

  it("answers a batch and drops the notifications in it", async () => {
    const res = await handleBody(
      JSON.stringify([
        rpc("ping", undefined, 1),
        { jsonrpc: "2.0", method: "notifications/x" },
        rpc("ping", undefined, 2),
      ]),
      server,
    );
    expect(res.status).toBe(200);
    expect((res.json as unknown[]).length).toBe(2);
  });

  it("refuses an empty or oversized batch", async () => {
    expect((await handleBody("[]", server)).status).toBe(400);
    const many = JSON.stringify(Array.from({ length: 21 }, (_, i) => rpc("ping", undefined, i)));
    expect((await handleBody(many, server)).status).toBe(400);
  });
});
