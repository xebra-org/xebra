import { readFileSync } from "node:fs";
import { validate } from "@readme/openapi-parser";
import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "../version.js";
import { ERROR_CODES, ERROR_STATUS } from "./errors.js";
import { buildOpenApiDocument } from "./openapi.js";
import {
  AmountSchema,
  FeesSchema,
  ProblemSchema,
  QuoteRequestSchema,
  TransferRequestSchema,
  TransferStatusSchema,
  TransferStepSchema,
} from "./schemas.js";

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

describe("Hyperliquid on the wire", () => {
  const typedData = {
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: 42161,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    types: { "HyperliquidTransaction:UsdSend": [{ name: "amount", type: "string" }] },
    primaryType: "HyperliquidTransaction:UsdSend",
    message: { amount: "0.011" },
  };
  const step = {
    id: "fee",
    chain: "hyperliquid",
    description: "Xebra's fee.",
    expiresAt: null,
    tx: {
      kind: "hyperliquid",
      exchangeUrl: "https://api.hyperliquid.xyz/exchange",
      nonce: 1795870421001,
      action: { type: "usdSend", amount: "0.011", time: 1795870421001 },
      typedData,
    },
  };

  it("takes a step that is typed data to sign and an action to post", () => {
    expect(TransferStepSchema.safeParse(step).success).toBe(true);
  });

  it("refuses one posted anywhere but Hyperliquid's exchange, or signed for another domain", () => {
    const elsewhere = { ...step, tx: { ...step.tx, exchangeUrl: "https://evil.example/exchange" } };
    expect(TransferStepSchema.safeParse(elsewhere).success).toBe(false);
    const otherDomain = {
      ...step,
      tx: {
        ...step.tx,
        typedData: { ...typedData, domain: { ...typedData.domain, name: "Other" } },
      },
    };
    expect(TransferStepSchema.safeParse(otherDomain).success).toBe(false);
  });

  it("lets a transfer name the wallet's chain for the signature, and a quote name the sender", () => {
    const base = {
      from: "hyperliquid",
      to: "arc",
      amount: "10",
      sender: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    };
    expect(TransferRequestSchema.safeParse({ ...base, signatureChainId: 42161 }).success).toBe(
      true,
    );
    expect(TransferRequestSchema.safeParse({ ...base, signatureChainId: 0 }).success).toBe(false);
    expect(TransferRequestSchema.safeParse({ ...base, signatureChainId: "42161" }).success).toBe(
      false,
    );
    expect(
      QuoteRequestSchema.safeParse({
        from: "hyperliquid",
        to: "arc",
        amount: "10",
        sender: base.sender,
      }).success,
    ).toBe(true);
  });

  it("shows Hyperliquid's one-time fee as its own figure, which other routes leave out", () => {
    const fees = { xebra: "0.011", circle: "0", delivery: "0.2", total: "1.211" };
    expect(FeesSchema.parse({ ...fees, activation: "1" }).activation).toBe("1");
    expect(FeesSchema.safeParse(fees).success).toBe(true);
  });

  it("reports the HyperEVM burn on a status, when there is one", () => {
    const status = {
      state: "delivering",
      chain: "hyperliquid",
      tx: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266:1795870421000",
      deliveryTx: null,
      reason: null,
      claimUrl: null,
    };
    expect(TransferStatusSchema.safeParse(status).success).toBe(true);
    const burnTx = `0x${"ab".repeat(32)}`;
    expect(TransferStatusSchema.parse({ ...status, burnTx }).burnTx).toBe(burnTx);
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

describe("a problem's instance", () => {
  const problem = {
    type: "https://docs.xebra.exchange/errors/internal_error",
    title: "Internal error",
    status: 500,
    detail: "Something went wrong on our side. Nothing was sent.",
    code: "internal_error",
  };

  it("is kept when the API sends one, so the client can hand it on, and is not required", () => {
    const instance = "urn:xebra:request:iad1::7zdhm-1700000000000-0a1b2c3d4e5f";
    // A member the schema does not name is dropped on parsing, which is how this one used to go.
    expect(ProblemSchema.parse({ ...problem, instance }).instance).toBe(instance);
    expect(ProblemSchema.parse({ ...problem, instance, other: 1 })).not.toHaveProperty("other");
    // The API host's own 404 and 405 carry none.
    expect(ProblemSchema.safeParse(problem).success).toBe(true);
  });

  it("is in the published document, which allows a problem no member it does not list", () => {
    const published = buildOpenApiDocument().components?.schemas?.Problem as {
      additionalProperties?: boolean;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(published.additionalProperties).toBe(false);
    expect(Object.keys(published.properties)).toContain("instance");
    expect(published.required).not.toContain("instance");
  });
});

describe("a problem's issues", () => {
  const problem = {
    type: "https://docs.xebra.exchange/errors/invalid_request",
    title: "Invalid request",
    status: 400,
    detail: "to: Invalid option.",
    code: "invalid_request",
  };

  it("are kept, so a form can mark the field, and are not required", () => {
    const issues = [
      { path: ["to"], message: "Invalid option" },
      { path: [], message: 'Unrecognized key: "memo"' },
    ];
    expect(ProblemSchema.parse({ ...problem, issues }).issues).toEqual(issues);
    expect(ProblemSchema.safeParse(problem).success).toBe(true);
  });

  it("must each be a path of strings and a message", () => {
    for (const issues of [
      [{ path: [0], message: "x" }],
      [{ path: ["to"] }],
      [{ path: "to", message: "x" }],
      "to: Invalid option",
    ]) {
      expect(ProblemSchema.safeParse({ ...problem, issues }).success).toBe(false);
    }
  });

  it("are in the published document, and optional", () => {
    const published = buildOpenApiDocument().components?.schemas?.Problem as {
      properties: Record<string, { type?: string; items?: { required?: string[] } }>;
      required: string[];
    };
    expect(published.properties.issues?.type).toBe("array");
    expect(published.properties.issues?.items?.required).toEqual(["path", "message"]);
    expect(published.required).not.toContain("issues");
  });
});
