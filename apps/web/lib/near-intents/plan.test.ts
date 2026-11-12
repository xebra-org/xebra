import { describe, expect, it } from "vitest";
import { toUnits } from "./plan";

describe("toUnits", () => {
  it("scales a decimal amount to a token's base units", () => {
    expect(toUnits("24.7", 6)).toBe("24700000");
    expect(toUnits("25", 7)).toBe("250000000");
    expect(toUnits("0.000001", 6)).toBe("1");
  });

  it("drops digits beyond the token's precision instead of rounding up", () => {
    expect(toUnits("1.2345678", 6)).toBe("1234567");
  });

  it("refuses anything that is not a plain decimal", () => {
    expect(() => toUnits("1e6", 6)).toThrow();
    expect(() => toUnits("-1", 6)).toThrow();
    expect(() => toUnits("", 6)).toThrow();
  });
});
