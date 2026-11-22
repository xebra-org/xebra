import {
  type BudgetStore,
  DEFAULT_BUDGET,
  createBudgetedFetch,
  createMemoryBudgetStore,
  createResilientBudgetStore,
} from "@xebra/cctp-client";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

/**
 * Every call our servers make to Circle's Iris API goes through `irisFetch`.
 *
 * It spends from a shared budget first and stops calling Iris for five and a half minutes after any
 * 429, so a busy minute degrades the delivery status instead of locking us out of it. The counter
 * lives in Convex (`convex/irisBudget.ts`) because Vercel runs many instances that share one
 * address; when Convex is unreachable each instance counts alone.
 *
 * Nothing here can stop a transfer. A refused Iris call only means we cannot *read* Circle for a
 * moment, and callers turn `IrisUnavailable` into "status unavailable", never into "down".
 */

const acquire = makeFunctionReference<"mutation">("irisBudget:acquire");
const rateLimited = makeFunctionReference<"mutation">("irisBudget:rateLimited");
const current = makeFunctionReference<"query">("irisBudget:current");

export function convexBudgetStore(convexUrl: string, secret: string): BudgetStore {
  const client = new ConvexHttpClient(convexUrl);
  return {
    async acquire(nowMs, n) {
      return (await client.mutation(acquire, { secret, nowMs, n })) as Awaited<
        ReturnType<BudgetStore["acquire"]>
      >;
    },
    async markRateLimited(nowMs) {
      await client.mutation(rateLimited, { secret, nowMs });
    },
    async usage(nowMs) {
      return (await client.query(current, { secret, nowMs })) as Awaited<
        ReturnType<BudgetStore["usage"]>
      >;
    },
  };
}

type Shared = { store: BudgetStore; fetch: typeof fetch };
const SLOT = Symbol.for("xebra.iris");

/** One store per server instance; module state would be rebuilt on every hot reload in dev. */
function shared(): Shared {
  const g = globalThis as unknown as Record<symbol, Shared | undefined>;
  const existing = g[SLOT];
  if (existing) return existing;

  const local = createMemoryBudgetStore(DEFAULT_BUDGET);
  const convexUrl = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  const secret = process.env.IRIS_BUDGET_SECRET;

  let store: BudgetStore = local;
  if (convexUrl && secret) {
    let warned = false;
    store = createResilientBudgetStore(convexBudgetStore(convexUrl, secret), local, (err) => {
      if (warned) return;
      warned = true;
      console.warn(
        `iris budget: shared store failed, counting per instance (${err instanceof Error ? err.message : err})`,
      );
    });
  } else {
    console.warn("iris budget: CONVEX_URL or IRIS_BUDGET_SECRET unset, counting per instance only");
  }

  const value = {
    store,
    fetch: createBudgetedFetch(store, fetch, Date.now, DEFAULT_BUDGET.blockMs),
  };
  g[SLOT] = value;
  return value;
}

export const irisFetch: typeof fetch = (input, init) => shared().fetch(input, init);
export const irisBudget = (): BudgetStore => shared().store;

export function irisBaseUrl(): string {
  return process.env.IRIS_BASE_URL ?? "https://iris-api.circle.com";
}

/** Stellar's CCTP domain, as Circle numbers it. */
const STELLAR_CCTP_DOMAIN = 27;
let warnedStellarDomain = false;

/**
 * Stellar's CCTP domain: 27, unless `STELLAR_CCTP_DOMAIN_ID` names another non-negative whole
 * number. Anything else is ignored and reported once. It used to be passed to `Number()`, so a typo
 * became `NaN`: `readSource` then matched no source to Stellar, and every Stellar status call
 * answered 400 "src is not a chain transfers start from", as if the caller had made the mistake.
 * An empty value counts as unset; `Number("")` had read it as domain 0, which is Ethereum's.
 */
export function stellarDomainId(): number {
  const raw = process.env.STELLAR_CCTP_DOMAIN_ID?.trim();
  if (!raw) return STELLAR_CCTP_DOMAIN;
  if (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw);
  if (!warnedStellarDomain) {
    warnedStellarDomain = true;
    console.error(
      `STELLAR_CCTP_DOMAIN_ID=${JSON.stringify(raw)} is not a CCTP domain (a non-negative whole number), so Stellar's own, ${STELLAR_CCTP_DOMAIN}, is used.`,
    );
  }
  return STELLAR_CCTP_DOMAIN;
}
