import type {
  ClaimBuild,
  TransferBuild,
  Quote as WireQuote,
  TransferStatus as WireStatus,
} from "@xebra/sdk";
import type { TransferStep } from "@xebra/sdk/build";
import { formatUsdcAmount } from "@xebra/sdk/core";
import type { Quote, RouteGroup, TransferStatus } from "./service";

/**
 * The service's values as the API sends them: 6-decimal bigints become decimal strings, and fields
 * meant only for the MCP tools' sentences are dropped.
 */

const amount = (units: bigint): string => formatUsdcAmount(units);

export function routesToWire(groups: RouteGroup[], complete: boolean) {
  return {
    routes: groups.flatMap((g) => g.to.map((d) => ({ from: g.from, to: d.id, speeds: d.speeds }))),
    complete,
  };
}

export function quoteToWire(q: Quote): WireQuote {
  return {
    from: q.from,
    to: q.to,
    speed: q.speed,
    amount: amount(q.amount),
    recipientGets: amount(q.recipientGets),
    fees: {
      xebra: amount(q.fees.xebra),
      circle: amount(q.fees.circle),
      delivery: amount(q.fees.delivery),
      total: amount(q.fees.total),
    },
    minimum: amount(q.minimum),
    maximum: q.maximum === null ? null : amount(q.maximum),
    circleStatus: q.circleStatus,
    expiresAt: q.expiresAt,
  };
}

export function buildToWire(b: { quote: Quote; steps: TransferStep[] }): TransferBuild {
  return { quote: quoteToWire(b.quote), steps: b.steps };
}

export function claimToWire(b: { steps: TransferStep[] }): ClaimBuild {
  return { steps: b.steps };
}

export function statusToWire(s: TransferStatus): WireStatus {
  return {
    state: s.state,
    chain: s.chain,
    tx: s.tx,
    deliveryTx: s.deliveryTx,
    reason: s.reason,
    claimUrl: s.claimUrl,
  };
}

/** An error's extra fields for the problem body: amounts as strings, other values as they are. */
export function extraToWire(extra: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(extra).map(([k, v]) => [k, typeof v === "bigint" ? amount(v) : v]),
  );
}
