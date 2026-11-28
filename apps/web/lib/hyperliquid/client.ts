import { HYPERCORE, isHyperliquidDestination, parseTransferId } from "@xebra/sdk/core";
import type { HyperliquidDestination } from "@xebra/sdk/core";
import { hypercoreUnits } from "./reads";

/**
 * The browser's side of a withdrawal from Hyperliquid: reading the balance, posting the two signed
 * actions to Hyperliquid, remembering the withdrawal so a closed tab does not lose it, and saying
 * where it is. Prices, the actions themselves and status come from Xebra's `/v1` API.
 */

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: Fetch = (input, init) => fetch(input, init);

export type ExchangeOutcome =
  | { ok: true }
  /**
   * `refused`: Hyperliquid answered and said no, so nothing left the balance. Otherwise the answer
   * could not be read, and the action may have gone through.
   */
  | { ok: false; refused: boolean; message: string };

/** What Hyperliquid's `/exchange` answered, in words for the person. */
export function exchangeOutcome(httpStatus: number, body: unknown): ExchangeOutcome {
  const b = body as { status?: unknown; response?: unknown } | null;
  if (httpStatus === 200 && b?.status === "ok") return { ok: true };
  if (httpStatus === 200 && b?.status === "err" && typeof b.response === "string") {
    const said = b.response.trim().slice(0, 200);
    return {
      ok: false,
      refused: true,
      message: `Hyperliquid refused it: "${said}". Nothing left your account: the USDC is still in your Hyperliquid balance.`,
    };
  }
  return {
    ok: false,
    refused: false,
    message:
      "Hyperliquid's answer could not be read, so the withdrawal may or may not have gone through. This page watches for it.",
  };
}

/** Posts a signed action, only ever to Hyperliquid's own exchange endpoint. */
export async function submitSigned(
  url: string,
  body: unknown,
  fetchImpl: Fetch = defaultFetch,
): Promise<ExchangeOutcome> {
  if (url !== HYPERCORE.exchangeUrl) throw new Error("not Hyperliquid's exchange endpoint");
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return exchangeOutcome(0, null);
  }
  const parsed = await res.json().catch(() => null);
  return exchangeOutcome(res.status, parsed);
}

/** The account's withdrawable USDC on Hyperliquid, perps and spot, or null when unreadable. */
export async function readHyperliquidBalances(
  user: string,
  fetchImpl: Fetch = defaultFetch,
): Promise<{ perps: bigint; spot: bigint } | null> {
  const ask = async (type: string) => {
    const res = await fetchImpl(HYPERCORE.infoUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, user }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<Record<string, unknown> | null>;
  };
  try {
    const [perps, spot] = await Promise.all([
      ask("clearinghouseState"),
      ask("spotClearinghouseState"),
    ]);
    const withdrawable =
      typeof perps?.withdrawable === "string" ? hypercoreUnits(perps.withdrawable) : null;
    if (withdrawable === null || !Array.isArray(spot?.balances)) return null;
    const usdc = (spot.balances as Array<Record<string, unknown>>).find(
      (b) => b.coin === "USDC" && b.token === 0,
    );
    const total = typeof usdc?.total === "string" ? hypercoreUnits(usdc.total) : 0n;
    const hold = typeof usdc?.hold === "string" ? hypercoreUnits(usdc.hold) : 0n;
    if (total === null || hold === null) return null;
    return { perps: withdrawable, spot: total > hold ? total - hold : 0n };
  } catch {
    return null;
  }
}

const STORAGE_KEY = "xebra.hyperliquid.transfer";

export interface RememberedWithdrawal {
  /** `<sender>:<nonce>`, what `/v1/transfers/hyperliquid/{id}` takes. */
  id: string;
  to: HyperliquidDestination;
  at: number;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
const browserStorage = (): Storage | null =>
  typeof window === "undefined" ? null : window.localStorage;

/** Keeps (or forgets) the withdrawal this browser is following. False when storage is blocked. */
export function rememberHyperliquidTransfer(
  t: RememberedWithdrawal | null,
  storage: Storage | null = browserStorage(),
): boolean {
  try {
    if (!storage) return false;
    if (t) storage.setItem(STORAGE_KEY, JSON.stringify(t));
    else storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function recallHyperliquidTransfer(
  storage: Storage | null = browserStorage(),
): RememberedWithdrawal | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<RememberedWithdrawal>;
    if (typeof v.id !== "string" || !parseTransferId(v.id)) return null;
    if (typeof v.to !== "string" || !isHyperliquidDestination(v.to)) return null;
    return { id: v.id, to: v.to, at: typeof v.at === "number" ? v.at : 0 };
  } catch {
    return null;
  }
}

/** `/v1/transfers/hyperliquid/{id}`'s answer, as far as the page reads it. */
export interface WithdrawalStatus {
  state: "pending" | "delivering" | "delivered" | "needs_claim" | "failed";
  burnTx?: string | null | undefined;
  deliveryTx: string | null;
  reason: string | null;
  claimUrl: string | null;
}

/**
 * Where a withdrawal is, as three steps: 1 Hyperliquid hands it to Circle, 2 Circle burns it on
 * HyperEVM and delivers it, 3 it has arrived.
 */
export function statusView(s: WithdrawalStatus): {
  step: 1 | 2 | 3;
  done: boolean;
  note: string | null;
  problem: string | null;
  claimUrl: string | null;
} {
  if (s.state === "delivered") {
    return { step: 3, done: true, note: null, problem: null, claimUrl: null };
  }
  if (s.state === "failed" || s.state === "needs_claim") {
    return {
      step: 2,
      done: false,
      note: s.reason,
      problem:
        "Circle burned it but could not deliver it. The USDC is safe: anyone can finish the delivery, and the claim page does it from your wallet for a little gas.",
      claimUrl: s.claimUrl,
    };
  }
  return {
    step: s.burnTx ? 2 : 1,
    done: false,
    note: s.reason,
    problem: null,
    claimUrl: null,
  };
}
