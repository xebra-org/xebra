import {
  ClaimBuildSchema,
  ClaimRequestSchema,
  HealthSchema,
  QuoteRequestSchema,
  QuoteSchema,
  RoutesSchema,
  SDK_VERSION,
  TransferBuildSchema,
  TransferPathSchema,
  TransferRequestSchema,
  TransferStatusSchema,
} from "@xebra/sdk";
import { parseUsdcAmount } from "@xebra/sdk/core";
import { ApiError } from "./errors";
import { handle } from "./http";
import { type DestId, type Service, type SourceId, isDestId, isSourceId } from "./service";
import { buildToWire, claimToWire, quoteToWire, routesToWire, statusToWire } from "./wire";

/**
 * The `/v1` handlers, built over a service so tests can drive them with fakes. The route files in
 * `app/v1` are one line each over `v1` from `lib/api/instance.ts`.
 */

function units(raw: string): bigint {
  // The schema has already checked the shape; this cannot be null, but a null is not let through.
  const v = parseUsdcAmount(raw);
  if (v === null) throw new ApiError("invalid_amount", "amount: must be more than zero.");
  return v;
}

function route(from: string, to: string): { from: SourceId; to: DestId } {
  if (!isSourceId(from) || !isDestId(to)) {
    throw new ApiError("route_unavailable", `Xebra does not send from ${from} to ${to}.`, {
      from,
      to,
    });
  }
  return { from, to };
}

function source(chain: string): SourceId {
  if (!isSourceId(chain)) {
    throw new ApiError("invalid_request", `Transfers do not start on ${chain}.`);
  }
  return chain;
}

export function endpoints(service: Service) {
  return {
    routes: (req: Request) =>
      handle(req, {
        from: "none",
        run: async () => {
          const r = await service.routes();
          return routesToWire(r.routes, r.stellarContractRead);
        },
        output: RoutesSchema,
        cache: "public, s-maxage=30, stale-while-revalidate=30",
      }),

    quote: (req: Request) =>
      handle(req, {
        from: "query",
        input: QuoteRequestSchema,
        run: async (q) => {
          const r = route(q.from, q.to);
          // Only Solana's price depends on the recipient (opening its USDC account costs more).
          const opensAccount =
            r.to === "solana" && q.recipient
              ? await service.solanaOpensAccount(q.recipient)
              : false;
          const priced = await service.quote({
            ...r,
            amount: units(q.amount),
            ...(q.speed ? { speed: q.speed } : {}),
            opensAccount,
          });
          return quoteToWire(priced.quote);
        },
        output: QuoteSchema,
      }),

    createTransfer: (req: Request) =>
      handle(req, {
        from: "body",
        input: TransferRequestSchema,
        run: async (r) =>
          buildToWire(
            await service.buildTransfer({
              ...route(r.from, r.to),
              amount: units(r.amount),
              sender: r.sender,
              recipient: r.recipient,
              ...(r.speed ? { speed: r.speed } : {}),
              ...(r.maxTotalFee !== undefined
                ? { maxTotalFee: parseUsdcAmount(r.maxTotalFee) ?? 0n }
                : {}),
            }),
          ),
        output: TransferBuildSchema,
      }),

    getTransfer: (req: Request, params: { chain: string; tx: string }) =>
      handle(req, {
        from: "params",
        params,
        input: TransferPathSchema,
        run: async (p) =>
          statusToWire(await service.transferStatus({ chain: source(p.chain), tx: p.tx })),
        output: TransferStatusSchema,
      }),

    createClaim: (req: Request) =>
      handle(req, {
        from: "body",
        input: ClaimRequestSchema,
        run: async (c) =>
          claimToWire(
            await service.buildClaim({
              chain: source(c.chain),
              tx: c.tx,
              payer: c.payer,
              ...(c.recipientOwner ? { recipientOwner: c.recipientOwner } : {}),
            }),
          ),
        output: ClaimBuildSchema,
      }),

    health: (req: Request) =>
      handle(req, {
        from: "none",
        run: async () => ({ status: "ok" as const, version: SDK_VERSION }),
        output: HealthSchema,
        cache: "no-store",
      }),
  };
}

export type Endpoints = ReturnType<typeof endpoints>;
