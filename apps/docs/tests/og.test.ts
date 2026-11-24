import { describe, expect, it } from "vitest";
import { OG_DESCRIPTION_MAX, clampDescription } from "../lib/og";

describe("clampDescription", () => {
  it("keeps a short description as it is", () => {
    expect(clampDescription("Send USDC from Stellar.")).toBe("Send USDC from Stellar.");
  });

  it("cuts a long one at a word break and ends it with an ellipsis", () => {
    const long = `${"word ".repeat(80)}end`;
    const out = clampDescription(long);
    expect(out.length).toBeLessThanOrEqual(OG_DESCRIPTION_MAX);
    expect(out.endsWith("word…")).toBe(true);
  });

  it("drops trailing punctuation before the ellipsis", () => {
    expect(clampDescription("alpha beta, gamma delta", 13)).toBe("alpha beta…");
  });

  it("cuts a single unbroken run mid-word rather than returning nothing", () => {
    const out = clampDescription("x".repeat(300), 50);
    expect(out).toBe(`${"x".repeat(49)}…`);
  });

  it("collapses whitespace and newlines", () => {
    expect(clampDescription("  one\n  two  ")).toBe("one two");
  });
});
