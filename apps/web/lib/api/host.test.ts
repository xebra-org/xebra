import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DOCS_API_URL,
  allowedMethods,
  decideApiHost,
  isApiHost,
  methodNotAllowed,
  notFound,
} from "./host";

describe("api.xebra.exchange", () => {
  it("serves /v1 and everything under it", () => {
    expect(decideApiHost("/v1/routes")).toEqual({ action: "pass" });
    expect(decideApiHost("/v1/transfers/stellar/abc")).toEqual({ action: "pass" });
  });

  it("sends the bare host to the API docs", () => {
    expect(decideApiHost("/")).toEqual({ action: "redirect", location: DOCS_API_URL });
  });

  it("serves nothing of the site, the admin panel above all", () => {
    for (const p of [
      "/admin",
      "/admin/keys",
      "/bridge",
      "/api/delivery",
      "/v1x",
      "/v2/routes",
      "/mcp",
    ]) {
      expect(decideApiHost(p)).toEqual({ action: "not-found" });
    }
  });

  it("recognises the host with a port and in any case, and nothing else", () => {
    expect(isApiHost("api.xebra.exchange")).toBe(true);
    expect(isApiHost("API.Xebra.Exchange:443")).toBe(true);
    expect(isApiHost("xebra.exchange")).toBe(false);
    expect(isApiHost("api.xebra.exchange.evil.com")).toBe(false);
    expect(isApiHost(null)).toBe(false);
  });
});

describe("allowedMethods", () => {
  it("names the methods each path answers", () => {
    expect(allowedMethods("/v1/routes")).toEqual(["GET", "HEAD", "OPTIONS"]);
    expect(allowedMethods("/v1/quote")).toEqual(["GET", "HEAD", "OPTIONS"]);
    expect(allowedMethods("/v1/health")).toEqual(["GET", "HEAD", "OPTIONS"]);
    expect(allowedMethods("/v1/openapi.json")).toEqual(["GET", "HEAD", "OPTIONS"]);
    expect(allowedMethods("/v1/transfers/stellar/abc")).toEqual(["GET", "HEAD", "OPTIONS"]);
    expect(allowedMethods("/v1/transfers")).toEqual(["POST", "OPTIONS"]);
    expect(allowedMethods("/v1/claims")).toEqual(["POST", "OPTIONS"]);
  });

  it("knows nothing about a path the API does not have", () => {
    for (const p of [
      "/v1",
      "/v1/nope",
      "/v1/routes/extra",
      "/v1/transfers/stellar",
      "/v1/transfers/stellar/abc/extra",
      "/v1x",
    ]) {
      expect(allowedMethods(p)).toBeNull();
    }
  });
});

describe("problems", () => {
  it("answers a path it does not have as a not_found problem", async () => {
    const res = notFound("The API has no such endpoint. See https://docs.xebra.exchange/api.");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      type: "https://docs.xebra.exchange/errors/not_found",
      title: "Not found",
      status: 404,
      detail: "The API has no such endpoint. See https://docs.xebra.exchange/api.",
      code: "not_found",
    });
  });

  it("answers a known path in the wrong method as a 405 problem that says Allow", async () => {
    const res = methodNotAllowed("GET", allowedMethods("/v1/transfers") ?? []);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, OPTIONS");
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(await res.json()).toEqual({
      type: "https://docs.xebra.exchange/errors/invalid_request",
      title: "Invalid request",
      status: 405,
      detail: "This endpoint does not accept GET.",
      code: "invalid_request",
    });
  });
});

describe("what the middleware loads", () => {
  it("imports nothing at run time, so the SDK stays out of the middleware's bundle", () => {
    const source = readFileSync(new URL("./host.ts", import.meta.url), "utf8");
    const imports = source
      .split(/\r?\n/)
      .filter((line) => /^(import|export)\b.*\bfrom\b/.test(line));
    // The titles are typed against the SDK's codes; a type import is erased before bundling.
    expect(imports).toEqual(['import type { ApiErrorCode } from "@xebra/sdk";']);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
  });
});
