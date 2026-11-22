import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ERROR_CODES, ERROR_STATUS } from "@xebra/sdk";
import { describe, expect, it } from "vitest";

const errorsDir = resolve(import.meta.dirname ?? __dirname, "../content/docs/errors");
const metaPath = resolve(errorsDir, "meta.json");
const indexPath = resolve(errorsDir, "index.mdx");

describe("API error documentation", () => {
  const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  const indexContent = readFileSync(indexPath, "utf-8");
  const indexLines = indexContent.split("\n");

  it("lists all error codes in meta.json", () => {
    for (const code of ERROR_CODES) {
      expect(meta.pages).toContain(code);
    }
  });

  describe.each(ERROR_CODES)("error code: %s", (code) => {
    const pagePath = resolve(errorsDir, `${code}.mdx`);

    it("has a documentation page file", () => {
      expect(existsSync(pagePath)).toBe(true);
    });

    it("is listed in meta.json", () => {
      expect(meta.pages).toContain(code);
    });

    it("has a table row in errors/index.mdx", () => {
      const hasTableRow = indexLines.some(
        (line) => line.startsWith("|") && line.includes(`\`${code}\``),
      );
      expect(hasTableRow).toBe(true);
    });

    it("has a matching status on the page", () => {
      expect(existsSync(pagePath)).toBe(true);
      const content = readFileSync(pagePath, "utf-8");
      const match = content.match(/HTTP \*\*(\d+)\*\*/);
      expect(match).not.toBeNull();
      expect(Number(match?.[1])).toBe(ERROR_STATUS[code]);
    });
  });
});
