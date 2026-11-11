import type { ZodType } from "zod";
import { type ZodOpenApiResponsesObject, createDocument } from "zod-openapi";
import { SDK_VERSION } from "../version.js";
import {
  ClaimBuildSchema,
  ClaimRequestSchema,
  HealthSchema,
  ProblemSchema,
  QuoteRequestSchema,
  QuoteSchema,
  RoutesSchema,
  TransferBuildSchema,
  TransferPathSchema,
  TransferRequestSchema,
  TransferStatusSchema,
} from "./schemas.js";

export const API_BASE_URL = "https://api.xebra.exchange";

/** The generated document, as the JSON it is. */
export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; [key: string]: unknown };
  paths: Record<string, Record<string, { operationId?: string; [key: string]: unknown }>>;
  components?: { schemas?: Record<string, unknown>; [key: string]: unknown };
  [key: string]: unknown;
}

const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

const json = (description: string, schema: ZodType) => ({
  description,
  content: { "application/json": { schema } },
});

/** Errors every operation can answer with. */
const COMMON: ZodOpenApiResponsesObject = {
  "400": problem(
    "The request is malformed: a missing or unknown field, or a value of the wrong shape.",
  ),
  "429": problem("Too many requests. Wait for `Retry-After` seconds."),
  "503": problem("Circle or a chain could not be read just now. Nothing was decided; ask again."),
};

/**
 * The OpenAPI 3.1 description of the public API, generated from the same schemas the server
 * validates with. `openapi.json` in this package is this document, written by `pnpm openapi`.
 */
export function buildOpenApiDocument(): OpenApiDocument {
  const doc = createDocument({
    openapi: "3.1.0",
    info: {
      title: "Xebra API",
      version: SDK_VERSION,
      description:
        "Native USDC between chains over Circle CCTP. The API prices transfers and builds unsigned transactions; your user's wallet signs them. Xebra never holds keys or funds.",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    },
    servers: [{ url: API_BASE_URL }],
    tags: [
      { name: "Routes", description: "Which chains reach which, right now." },
      { name: "Quotes", description: "What a transfer costs and what the recipient gets." },
      {
        name: "Transfers",
        description: "Unsigned transactions, and how a transfer is getting on.",
      },
      { name: "Claims", description: "Finishing a delivery that did not complete on its own." },
      { name: "System", description: "Liveness." },
    ],
    paths: {
      "/v1/routes": {
        get: {
          operationId: "listRoutes",
          tags: ["Routes"],
          summary: "List live routes",
          responses: {
            "200": json("Every route Xebra sends on right now.", RoutesSchema),
            ...COMMON,
          },
        },
      },
      "/v1/quote": {
        get: {
          operationId: "getQuote",
          tags: ["Quotes"],
          summary: "Price a transfer",
          description:
            "Read-only. Fees move, so a quote expires; building a transfer prices it again. A Solana recipient with no USDC account costs more; that is priced when the transfer is built.",
          requestParams: { query: QuoteRequestSchema },
          responses: {
            "200": json("The price.", QuoteSchema),
            "422": problem("The route is not offered, or the amount is outside its bounds."),
            ...COMMON,
          },
        },
      },
      "/v1/transfers": {
        post: {
          operationId: "createTransfer",
          tags: ["Transfers"],
          summary: "Build a transfer",
          description:
            "Checks the sender, the recipient and the sender's balance, prices the transfer, and returns the unsigned transactions in signing order. Nothing is signed or sent.",
          requestBody: { content: { "application/json": { schema: TransferRequestSchema } } },
          responses: {
            "200": json("The quote and the steps to sign.", TransferBuildSchema),
            "422": problem("The transfer cannot be built as asked; `code` says why."),
            ...COMMON,
          },
        },
      },
      "/v1/transfers/{chain}/{tx}": {
        get: {
          operationId: "getTransfer",
          tags: ["Transfers"],
          summary: "A transfer's status",
          requestParams: { path: TransferPathSchema },
          responses: { "200": json("Where the transfer is.", TransferStatusSchema), ...COMMON },
        },
      },
      "/v1/claims": {
        post: {
          operationId: "createClaim",
          tags: ["Claims"],
          summary: "Build a claim",
          description:
            "The unsigned mint for a transfer whose delivery did not complete, checked so that a mint already made or one that would fail is refused before anyone pays.",
          requestBody: { content: { "application/json": { schema: ClaimRequestSchema } } },
          responses: {
            "200": json("The steps to sign.", ClaimBuildSchema),
            "409": problem("Not attested yet, or already delivered."),
            "422": problem("The mint would be rejected; `detail` gives the chain's reason."),
            ...COMMON,
          },
        },
      },
      "/v1/health": {
        get: {
          operationId: "getHealth",
          tags: ["System"],
          summary: "Liveness",
          responses: { "200": json("The API is up.", HealthSchema) },
        },
      },
    },
  });
  // createDocument types its result for exactOptionalPropertyTypes-free code; the JSON is the same.
  return JSON.parse(JSON.stringify(doc)) as OpenApiDocument;
}
