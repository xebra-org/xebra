import { parseUsdc, parseUsdc6 } from "@xebra/sdk/core";
import { describe, expect, it } from "vitest";
import { unitsToInput } from "./max-amount";

describe("unitsToInput", () => {
  it("writes whole amounts without a decimal point", () => {
    expect(unitsToInput(25_0000000n, 7)).toBe("25");
    expect(unitsToInput(25_000000n, 6)).toBe("25");
  });

  it("keeps every digit of a fractional balance and drops only trailing zeros", () => {
    expect(unitsToInput(1_2345670n, 7)).toBe("1.234567");
    expect(unitsToInput(1n, 7)).toBe("0.0000001");
    expect(unitsToInput(999_999n, 6)).toBe("0.999999");
  });

  it("adds no thousands separators, which the parsers reject", () => {
    expect(unitsToInput(1_234_567_8901234n, 7)).toBe("1234567.8901234");
  });

  it("reads zero and negative as zero", () => {
    expect(unitsToInput(0n, 7)).toBe("0");
    expect(unitsToInput(-5n, 6)).toBe("0");
  });

  it("round-trips through the amount parsers", () => {
    for (const units of [1n, 99n, 1_0000000n, 123_4567891n, 9_999_999_9999999n]) {
      expect(parseUsdc(unitsToInput(units, 7))).toBe(units);
    }
    for (const units of [1n, 99n, 1_000000n, 123_456789n, 9_999_999_999999n]) {
      expect(parseUsdc6(unitsToInput(units, 6))).toBe(units);
    }
  });
});
