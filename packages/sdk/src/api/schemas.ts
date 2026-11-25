import "zod-openapi";
import * as z from "zod";
import { parseUsdcAmount } from "../core/amounts.js";
import { CHAIN_IDS, type ChainId } from "../core/chains/ids.js";
import { ERROR_CODES, ERROR_TYPE_BASE } from "./errors.js";

/**
 * The public API's wire format, once. These schemas validate requests on the server, type the SDK's
 * client, and generate `openapi.json`. Amounts are decimal strings of USDC with at most six places
 * ("12.5"), never JSON numbers.
 */

export const ChainIdSchema = z
  .enum(CHAIN_IDS as unknown as [ChainId, ...ChainId[]])
  .meta({ id: "ChainId", description: "A chain, as the API names it.", example: "stellar" });

export const AmountSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, "a decimal amount of USDC with at most 6 places, such as 12.5")
  .refine((v) => parseUsdcAmount(v) !== null, "must be more than zero")
  .meta({
    id: "Amount",
    description: "USDC, as a decimal string with at most 6 places.",
    example: "25.5",
  });

/** An amount the API reports, which can be zero (a fee, for one). */
export const AmountOutSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/)
  .meta({
    id: "AmountOut",
    description: "USDC, as a decimal string with at most 6 places.",
    example: "0.35",
  });

export const SpeedSchema = z.enum(["standard", "fast"]).meta({
  id: "Speed",
  description: "Standard waits for finality; Fast is attested sooner for Circle's fee.",
});

export const RouteSchema = z
  .object({ from: ChainIdSchema, to: ChainIdSchema, speeds: z.array(SpeedSchema).min(1) })
  .meta({ id: "Route" });

export const RoutesSchema = z
  .object({
    routes: z.array(RouteSchema),
    /** False when the Stellar contract could not be read, so its list may be short. */
    complete: z.boolean().meta({
      description: "False when part of the list could not be read just now; ask again shortly.",
    }),
  })
  .meta({ id: "Routes" });

export const QuoteRequestSchema = z.object({
  from: ChainIdSchema,
  to: ChainIdSchema,
  amount: AmountSchema,
  speed: SpeedSchema.optional(),
  recipient: z.string().min(1).max(128).optional().meta({
    description:
      "Optional. For Solana, pass it: a wallet with no USDC account yet costs more to deliver to, and the quote includes that.",
  }),
});

export const FeesSchema = z
  .object({
    xebra: AmountOutSchema.meta({ description: "What Xebra keeps." }),
    circle: AmountOutSchema.meta({ description: "Circle's transfer fee (Fast only)." }),
    delivery: AmountOutSchema.meta({
      description: "What Circle is paid to deliver on the destination.",
    }),
    total: AmountOutSchema,
  })
  .meta({ id: "Fees" });

// The comments on the keys below reach the inferred `Quote` and `TransferStatus` types, and
// from there the SDK reference pages (`AutoTypeTable` in apps/docs).
export const QuoteSchema = z
  .object({
    /** The chain the transfer starts on. */
    from: ChainIdSchema,
    /** The chain it ends on. */
    to: ChainIdSchema,
    /** Echoes the speed priced. */
    speed: SpeedSchema,
    /** What the sender sends, in USDC. */
    amount: AmountOutSchema,
    /** What arrives: `amount` minus `fees.total`. */
    recipientGets: AmountOutSchema,
    /**
     * What Xebra keeps, Circle's transfer fee (Fast only), what Circle is paid to deliver, and
     * their sum. All strings of USDC.
     */
    fees: FeesSchema,
    /** The smallest amount this route takes right now, with a margin for fees moving. */
    minimum: AmountOutSchema,
    /** The largest amount, or null when the route sets none. */
    maximum: AmountOutSchema.nullable(),
    /** Circle's own health, when it could be read. */
    circleStatus: z.enum(["ok", "degraded"]).nullable(),
    /** ISO 8601. Fees move; after this, ask again. */
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: "Quote" });

export const UnsignedTxSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("stellar"), xdr: z.string(), networkPassphrase: z.string() }),
    z.object({
      kind: z.literal("evm"),
      chainId: z.number().int(),
      to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      data: z.string().regex(/^0x[0-9a-fA-F]*$/),
      value: z.literal("0"),
    }),
    z.object({ kind: z.literal("sui"), json: z.string() }),
    z.object({
      kind: z.literal("aptos"),
      chainId: z.number().int(),
      bytecode: z.string().regex(/^0x[0-9a-f]+$/),
      arguments: z.object({
        amount: z.string().regex(/^\d+$/),
        destinationDomain: z.number().int(),
        mintRecipient: z.string().regex(/^0x[0-9a-f]{64}$/),
        destinationCaller: z.string().regex(/^0x[0-9a-f]{64}$/),
        burnToken: z.string().regex(/^0x[0-9a-f]{64}$/),
        maxFee: z.string().regex(/^\d+$/),
        minFinalityThreshold: z.number().int(),
        hookData: z.string().regex(/^0x[0-9a-f]*$/),
      }),
    }),
    z.object({ kind: z.literal("solana"), transaction: z.string() }),
    z.object({
      kind: z.literal("aptos_call"),
      chainId: z.number().int(),
      function: z.string().regex(/^0x[0-9a-f]{1,64}::[a-z_][a-z0-9_]*::[a-z_][a-z0-9_]*$/),
      typeArguments: z.array(z.string()),
      functionArguments: z.array(z.string()),
    }),
  ])
  .meta({ id: "UnsignedTx", description: "A transaction for the user's wallet to sign." });

export const TransferStepSchema = z
  .object({
    id: z.enum(["approve", "burn", "fee", "open_account", "claim"]),
    chain: ChainIdSchema,
    description: z.string(),
    tx: UnsignedTxSchema,
    expiresAt: z.iso.datetime().nullable(),
  })
  .meta({
    id: "TransferStep",
    description: "One signature, in the order the wallet should be asked.",
  });

export const TransferRequestSchema = z
  .strictObject({
    from: ChainIdSchema,
    to: ChainIdSchema,
    amount: AmountSchema,
    sender: z.string().min(1).max(128).meta({ description: "The address that signs and pays." }),
    recipient: z
      .string()
      .min(1)
      .max(128)
      .meta({ description: "Who receives, on the destination." }),
    speed: SpeedSchema.optional(),
    maxTotalFee: AmountOutSchema.optional().meta({
      description: "Refuse if fees have risen above this, typically the total you showed.",
    }),
  })
  .meta({ id: "TransferRequest" });

export const TransferBuildSchema = z
  .object({ quote: QuoteSchema, steps: z.array(TransferStepSchema).min(1) })
  .meta({ id: "TransferBuild" });

export const TransferStatusSchema = z
  .object({
    /** See [Track a transfer](/docs/guides/track-a-transfer). */
    state: z.enum(["pending", "delivering", "delivered", "needs_claim", "failed"]),
    /** The chain the burn was made on. */
    chain: ChainIdSchema,
    /** The burn's hash, as asked. */
    tx: z.string(),
    /** The mint on the destination, once Circle has delivered it. */
    deliveryTx: z.string().nullable(),
    /** Circle's own words when delivery did not complete, shortened. */
    reason: z.string().nullable(),
    /** Where the recipient can finish a delivery that did not complete on its own. */
    claimUrl: z.url().nullable(),
  })
  .meta({ id: "TransferStatus" });

export const TransferPathSchema = z.object({
  chain: ChainIdSchema,
  tx: z
    .string()
    .min(1)
    .max(128)
    .meta({ description: "The burn's transaction hash or Sui digest." }),
});

export const ClaimRequestSchema = z
  .strictObject({
    chain: ChainIdSchema.meta({ description: "The chain the burn was made on." }),
    tx: z.string().min(1).max(128),
    payer: z
      .string()
      .min(1)
      .max(128)
      .meta({ description: "Pays the destination's fee and signs." }),
    recipientOwner: z.string().min(1).max(128).optional().meta({
      description:
        "Solana only: the wallet that owns the recipient's USDC account, when it must be opened.",
    }),
  })
  .meta({ id: "ClaimRequest" });

export const ClaimBuildSchema = z
  .object({ steps: z.array(TransferStepSchema).min(1) })
  .meta({ id: "ClaimBuild" });

export const HealthSchema = z
  .object({ status: z.literal("ok"), version: z.string() })
  .meta({ id: "Health" });

export const ProblemSchema = z
  .object({
    type: z.url().meta({ example: `${ERROR_TYPE_BASE}route_unavailable` }),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
    instance: z.string().optional().meta({
      description:
        "A URI for this one occurrence: `urn:xebra:request:<id>`. Quote it when you report a problem. The same id is in the `X-Request-Id` response header and in Xebra's logs.",
      example: "urn:xebra:request:iad1::7zdhm-1700000000000-0a1b2c3d4e5f",
    }),
    code: z.enum(ERROR_CODES as [string, ...string[]]),
    minimum: AmountOutSchema.optional(),
    maximum: AmountOutSchema.optional(),
    have: AmountOutSchema.optional(),
    need: AmountOutSchema.optional(),
    total: AmountOutSchema.optional(),
    limit: AmountOutSchema.optional(),
    needs: z.string().optional(),
    issues: z
      .array(
        z.object({
          path: z.array(z.string()).meta({
            description: 'Where the problem is, such as `["amount"]`. Empty for the whole input.',
          }),
          message: z.string(),
        }),
      )
      .optional()
      .meta({
        description:
          "On `invalid_request` and `invalid_amount` from checking the input: each field that failed, and why.",
      }),
  })
  .meta({ id: "Problem", description: "An RFC 9457 problem. `detail` is written for a person." });

export type Route = z.infer<typeof RouteSchema>;
export type Routes = z.infer<typeof RoutesSchema>;
export type QuoteRequest = z.input<typeof QuoteRequestSchema>;
export type Quote = z.infer<typeof QuoteSchema>;
export type TransferRequest = z.input<typeof TransferRequestSchema>;
export type TransferBuild = z.infer<typeof TransferBuildSchema>;
export type TransferStatus = z.infer<typeof TransferStatusSchema>;
export type ClaimRequest = z.input<typeof ClaimRequestSchema>;
export type ClaimBuild = z.infer<typeof ClaimBuildSchema>;
export type Problem = z.infer<typeof ProblemSchema>;
export type Health = z.infer<typeof HealthSchema>;
