import { describe, expect, it } from "vitest";
import { DOCS_API_URL, decideApiHost, isApiHost } from "./host";

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
