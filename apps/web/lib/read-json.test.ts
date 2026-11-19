import { describe, expect, it } from "vitest";
import { readJson } from "./read-json";

describe("readJson", () => {
  it("parses JSON 200", async () => {
    const res = new Response(JSON.stringify({ tokenAccount: "sol123", status: "exists" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const result = await readJson<{ tokenAccount: string; status: string }>(res);
    expect(result).toEqual({
      ok: true,
      body: { tokenAccount: "sol123", status: "exists" },
    });
  });

  it("handles JSON 4xx without throwing", async () => {
    const res = new Response(JSON.stringify({ error: "Invalid owner address" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
    const result = await readJson<{ error: string }>(res);
    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: "Invalid owner address" },
    });
  });

  it("handles HTML 502 without throwing", async () => {
    const html = "<!DOCTYPE html><html><body>502 Bad Gateway</body></html>";
    const res = new Response(html, {
      status: 502,
      headers: { "Content-Type": "text/html" },
    });
    const result = await readJson(res);
    expect(result).toEqual({
      ok: false,
      status: 502,
      body: html,
    });
  });

  it("handles empty body without throwing", async () => {
    const res = new Response(null, {
      status: 204,
    });
    const result = await readJson(res);
    expect(result).toEqual({
      ok: false,
      status: 204,
      body: null,
    });
  });

  it("handles empty 200 body gracefully", async () => {
    const res = new Response("", {
      status: 200,
    });
    const result = await readJson(res);
    expect(result).toEqual({
      ok: false,
      status: 200,
      body: null,
    });
  });

  it("allows resolveRecipient to handle HTML 502 without SyntaxError", async () => {
    const html = "<!DOCTYPE html><html><body>502 Bad Gateway</body></html>";
    const res = new Response(html, {
      status: 502,
      headers: { "Content-Type": "text/html" },
    });
    const parsed = await readJson<{ error?: string }>(res);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.status).toBe(502);
      expect(parsed.body).toBe(html);
    }
  });
});
