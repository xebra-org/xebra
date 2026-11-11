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

export const QuoteSchema = z
  .object({
    from: ChainIdSchema,
    to: ChainIdSchema,
    speed: SpeedSchema,
    amount: AmountOutSchema,
    recipientGets: AmountOutSchema,
    fees: FeesSchema,
    minimum: AmountOutSchema,
    maximum: AmountOutSchema.nullable(),
    circleStatus: z.enum(["ok", "degraded"]).nullable(),
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
    z.object({ kind: z.literal("solana"), transaction: z.string() }),
  ])
  .meta({ id: "UnsignedTx", description: "A transaction for the user's wallet to sign." });

export const TransferStepSchema = z
  .object({
    id: z.enum(["approve", "burn", "open_account", "claim"]),
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
    state: z.enum(["pending", "delivering", "delivered", "needs_claim", "failed"]),
    chain: ChainIdSchema,
    tx: z.string(),
    deliveryTx: z.string().nullable(),
    reason: z.string().nullable(),
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
    code: z.enum(ERROR_CODES as [string, ...string[]]),
    minimum: AmountOutSchema.optional(),
    maximum: AmountOutSchema.optional(),
    have: AmountOutSchema.optional(),
    need: AmountOutSchema.optional(),
    total: AmountOutSchema.optional(),
    limit: AmountOutSchema.optional(),
    needs: z.string().optional(),
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
