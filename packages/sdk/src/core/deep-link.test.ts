import { describe, expect, it } from "vitest";
import { buildDeepLink, hasDeepLink, parseDeepLink } from "./deep-link.js";

describe("parseDeepLink", () => {
  it("reads every field of a full link", () => {
    expect(
      parseDeepLink(
        "?from=stellar&to=base&amount=25.5&recipient=0x1111111111111111111111111111111111111111",
      ),
    ).toEqual({
      from: "stellar",
      to: "base",
      amount: "25.5",
      recipient: "0x1111111111111111111111111111111111111111",
    });
  });

  it("accepts Solana as a destination and an EVM chain as a source", () => {
    expect(parseDeepLink("from=arc&to=solana")).toEqual({ from: "arc", to: "solana" });
  });

  it("is case-insensitive on chain names", () => {
    expect(parseDeepLink("from=STELLAR&to=Monad")).toEqual({ from: "stellar", to: "monad" });
  });

  it("drops chains it does not know, and never takes solana as a source", () => {
    expect(parseDeepLink("from=solana&to=bitcoin")).toEqual({});
    expect(parseDeepLink("to=constructor&from=__proto__")).toEqual({});
  });

  it("drops amounts that are not a plain positive decimal", () => {
    for (const bad of [
      "0",
      "0.0",
      "-5",
      "1e6",
      "1,000",
      "0x10",
      "1.1234567",
      "abc",
      " ",
      "9".repeat(13),
    ]) {
      expect(parseDeepLink(`amount=${encodeURIComponent(bad)}`)).toEqual({});
    }
    expect(parseDeepLink("amount=0.000001")).toEqual({ amount: "0.000001" });
  });

  it("drops a recipient with whitespace or an absurd length", () => {
    expect(parseDeepLink(`recipient=${encodeURIComponent("0xabc def")}`)).toEqual({});
    expect(parseDeepLink(`recipient=${"a".repeat(101)}`)).toEqual({});
  });

  it("returns nothing for an empty or malformed query", () => {
    expect(parseDeepLink("")).toEqual({});
    expect(parseDeepLink("%%%")).toEqual({});
  });
});

describe("buildDeepLink", () => {
  it("round-trips through parseDeepLink", () => {
    const link = { from: "stellar", to: "base", amount: "12", recipient: "0xabc" } as const;
    const url = new URL(buildDeepLink("https://xebra.exchange", link));
    expect(parseDeepLink(url.search)).toEqual(link);
    expect(url.hash).toBe("#bridge");
  });

  it("omits what is not set and tolerates a trailing slash on the origin", () => {
    expect(buildDeepLink("https://xebra.exchange/", { to: "monad" })).toBe(
      "https://xebra.exchange/?to=monad#bridge",
    );
    expect(buildDeepLink("https://xebra.exchange", {})).toBe("https://xebra.exchange/#bridge");
  });
});

describe("hasDeepLink", () => {
  it("is true only when something was set", () => {
    expect(hasDeepLink({})).toBe(false);
    expect(hasDeepLink({ amount: "1" })).toBe(true);
  });
});
