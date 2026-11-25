import { describe, expect, it } from "vitest";
import {
  XEBRA_TAG,
  attributionSuffix,
  isXebraTagged,
  readAttribution,
  withAttribution,
} from "./tag.js";

const MARKER = "80218021802180218021802180218021";

describe("ERC-8021 attribution", () => {
  it("matches the spec's schema 0 test vector", () => {
    // ERC-8021: txData 0xdddddddd, code "baseapp", length 7, schema 0, then the marker.
    expect(withAttribution("0xdddddddd", ["baseapp"])).toBe(
      `0xdddddddd626173656170700700${MARKER}`,
    );
    expect(readAttribution(`0xdddddddd626173656170700700${MARKER}`)).toEqual(["baseapp"]);
  });

  it("tags with xebra by default, and reads it back", () => {
    expect(XEBRA_TAG).toBe("xebra");
    // "xebra" is 78 65 62 72 61, five bytes.
    expect(attributionSuffix()).toBe(`78656272610500${MARKER}`);
    const tagged = withAttribution("0xa9059cbb");
    expect(isXebraTagged(tagged)).toBe(true);
    expect(readAttribution(tagged)).toEqual(["xebra"]);
  });

  it("joins several codes with commas", () => {
    expect(readAttribution(withAttribution("0x", ["xebra", "baseapp"]))).toEqual([
      "xebra",
      "baseapp",
    ]);
  });

  it("finds nothing in untagged calldata, or a suffix it cannot parse", () => {
    expect(readAttribution("0xa9059cbb")).toBeNull();
    expect(isXebraTagged("0xa9059cbb")).toBe(false);
    expect(readAttribution(`0x${"ff".repeat(2)}0100${MARKER}`)).toBeNull();
  });

  it("refuses codes the schema cannot hold", () => {
    expect(() => attributionSuffix([])).toThrow();
    expect(() => attributionSuffix(["a,b"])).toThrow();
    expect(() => attributionSuffix(["é"])).toThrow();
    expect(() => attributionSuffix(["x".repeat(256)])).toThrow();
  });
});
