import { describe, expect, it } from "vitest";
import { XebraError } from "../errors.js";
import { fromUnits } from "../intents/rebalance.js";
import {
  formatUsdc6,
  formatUsdcAmount,
  parseUsdc,
  parseUsdc6,
  parseUsdcAmount,
} from "./amounts.js";

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("parseUsdc6", () => {
  it("reads whole and fractional amounts into 6-decimal units", () => {
    expect(parseUsdc6("25")).toBe(25_000_000n);
    expect(parseUsdc6("0.000001")).toBe(1n);
    expect(parseUsdc6("12.5")).toBe(12_500_000n);
    expect(parseUsdc6(".5")).toBe(500_000n);
    expect(parseUsdc6(" 3. ")).toBe(3_000_000n);
  });

  it("refuses a seventh decimal instead of rounding money", () => {
    const err = thrown(() => parseUsdc6("12.1234567"));
    expect(err).toBeInstanceOf(XebraError);
    expect((err as XebraError).code).toBe("invalid_amount");
    expect((err as XebraError).message).toBe(
      'amount must be a decimal with at most 6 places, got "12.1234567"',
    );
  });

  it("refuses anything that is not a plain number", () => {
    for (const bad of ["", ".", "1e3", "-5", "1,000", "abc", "1.2.3"]) {
      const err = thrown(() => parseUsdc6(bad));
      expect(err, bad).toBeInstanceOf(XebraError);
      expect((err as XebraError).code, bad).toBe("invalid_amount");
    }
  });
});

describe("formatUsdc6", () => {
  it("keeps at least two decimals and no trailing zeros beyond them", () => {
    expect(formatUsdc6(25_000_000n)).toBe("25.00");
    expect(formatUsdc6(12_500_000n)).toBe("12.50");
    expect(formatUsdc6(16_778n)).toBe("0.016778");
    expect(formatUsdc6(1_234_567_890_000n)).toBe("1,234,567.89");
    expect(formatUsdc6(-1n)).toBe("-0.000001");
  });

  it("round-trips what it parses", () => {
    for (const text of ["0.01", "5.00", "999.999999"]) {
      expect(formatUsdc6(parseUsdc6(text))).toBe(text);
    }
  });
});

describe("canonical amounts (parseUsdcAmount / formatUsdcAmount)", () => {
  it("parses whole and fractional USDC to base units", () => {
    expect(parseUsdcAmount("1")).toBe(1_000_000n);
    expect(parseUsdcAmount("1.5")).toBe(1_500_000n);
    expect(parseUsdcAmount("0.000001")).toBe(1n);
  });

  it("rejects zero, negatives, too many decimals and junk", () => {
    for (const bad of ["0", "0.0", "-1", "1.1234567", "", "abc", "1e3", " "]) {
      expect(parseUsdcAmount(bad)).toBeNull();
    }
  });

  it("formats base units without trailing zeros", () => {
    expect(formatUsdcAmount(1_000_000n)).toBe("1");
    expect(formatUsdcAmount(1_500_000n)).toBe("1.5");
    expect(formatUsdcAmount(1n)).toBe("0.000001");
  });
});

describe("zero", () => {
  it("is accepted by the throwing parsers and rejected (null) by parseUsdcAmount", () => {
    expect(parseUsdc6("0")).toBe(0n);
    expect(parseUsdc("0")).toBe(0n);
    expect(parseUsdcAmount("0")).toBeNull();
  });
});

describe("parseUsdc (Stellar, 7 decimals)", () => {
  it("reads amounts into stroops", () => {
    expect(parseUsdc("12.5")).toBe(125_000_000n);
    expect(parseUsdc("0.0000001")).toBe(1n);
  });

  it("throws XebraError invalid_amount for junk and an eighth decimal", () => {
    for (const bad of ["", ".", "-1", "abc", "1.2.3", "1.00000001"]) {
      const err = thrown(() => parseUsdc(bad));
      expect(err, bad).toBeInstanceOf(XebraError);
      expect((err as XebraError).code, bad).toBe("invalid_amount");
    }
    expect((thrown(() => parseUsdc("1.00000001")) as XebraError).message).toBe(
      'amount must be a decimal with at most 7 places, got "1.00000001"',
    );
  });
});

describe("fromUnits", () => {
  it("formats integer units", () => {
    expect(fromUnits("12500000", 6)).toBe("12.5");
  });

  it("throws XebraError invalid_amount, not a SyntaxError, on non-integers", () => {
    for (const bad of ["", "abc", "1.5", "1e3"]) {
      const err = thrown(() => fromUnits(bad, 6));
      expect(err, bad).toBeInstanceOf(XebraError);
      expect((err as XebraError).code, bad).toBe("invalid_amount");
    }
  });
});
