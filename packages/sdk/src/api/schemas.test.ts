import { readFileSync } from "node:fs";
import { validate } from "@readme/openapi-parser";
import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "../version.js";
import { ERROR_CODES, ERROR_STATUS } from "./errors.js";
import { buildOpenApiDocument } from "./openapi.js";
import { AmountSchema, ProblemSchema, TransferRequestSchema } from "./schemas.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("AmountSchema", () => {
  it("takes decimal USDC with at most six places", () => {
    for (const ok of ["0.000001", "12.5", "1", "999999999999.999999"]) {
      expect(AmountSchema.safeParse(ok).success).toBe(true);
    }
  });

  it("refuses zero, exponents, a seventh place, signs, padding and numbers", () => {
    for (const bad of ["0", "0.0", "1e3", "1.1234567", "-1", "+1", " 1", "1 ", "", "1.", ".5", 1]) {
      expect(AmountSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("TransferRequestSchema", () => {
  it("refuses fields it does not know, so a typo is not silently ignored", () => {
    const base = { from: "stellar", to: "base", amount: "10", sender: "G", recipient: "0x" };
    expect(TransferRequestSchema.safeParse(base).success).toBe(true);
    expect(TransferRequestSchema.safeParse({ ...base, maxFee: "1" }).success).toBe(false);
  });
});

describe("the OpenAPI document", () => {
  const doc = buildOpenApiDocument();

  it("is valid OpenAPI 3.1", async () => {
    const result = await validate(structuredClone(doc) as never);
    expect(result.valid ? [] : result.errors).toEqual([]);
  });

  it("names one operation per endpoint", () => {
    const ids = Object.values(doc.paths).flatMap((item) =>
      Object.values(item).map((op) => op.operationId),
    );
    expect(ids.sort()).toEqual(
      [
        "createClaim",
        "createTransfer",
        "getHealth",
        "getQuote",
        "getTransfer",
        "listRoutes",
      ].sort(),
    );
  });

  it("is what openapi.json holds (run `pnpm --filter @xebra/sdk openapi` if not)", () => {
    const onDisk = JSON.parse(readFileSync(new URL("../../openapi.json", import.meta.url), "utf8"));
    expect(onDisk).toEqual(doc);
  });

  it("carries the package version", () => {
    expect(doc.info.version).toBe(pkg.version);
    expect(SDK_VERSION).toBe(pkg.version);
  });
});

describe("error codes", () => {
  it("are the codes a problem response can carry, each with a status", () => {
    for (const code of ERROR_CODES) {
      expect(ProblemSchema.shape.code.safeParse(code).success).toBe(true);
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
    expect(ProblemSchema.shape.code.safeParse("teapot").success).toBe(false);
  });
});
