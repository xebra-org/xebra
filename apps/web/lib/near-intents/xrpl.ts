/**
 * What the XRP Ledger says about a recipient account, read before a swap to XRP is quoted.
 *
 * 1Click delivers XRP to a classic `r...` address only: it cannot attach a destination tag (an
 * X-address answered "Internal server error" on 2026-11-28). Exchanges mark their deposit accounts
 * "require destination tag", and the ledger refuses a payment to such an account without one, so
 * Xebra refuses it first. A new account also needs the ledger's reserve (1 XRP on 2026-11-28) in
 * its first payment, or that payment fails.
 *
 * Two public servers, tried in turn. When neither answers, the check fails instead of guessing.
 */

export const XRPL_RPCS = ["https://xrplcluster.com/", "https://s1.ripple.com:51234/"] as const;

/** AccountRoot flags (xrpl.org, "AccountRoot Flags"). */
const LSF_REQUIRE_DEST_TAG = 0x00020000;
const LSF_DEPOSIT_AUTH = 0x01000000;

export interface XrpAccount {
  exists: boolean;
  requireDestTag: boolean;
  depositAuth: boolean;
  /** The ledger's base reserve in drops (1 XRP = 1,000,000 drops). */
  reserveDrops: bigint;
}

type Rpc = { result?: Record<string, unknown> };

async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params: [params] }),
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const body = (await res.json()) as Rpc;
  if (!body.result) throw new Error(`${url} sent no result`);
  return body.result;
}

async function readFrom(url: string, address: string, fetchImpl: typeof fetch) {
  const [info, state] = await Promise.all([
    rpc(url, "account_info", { account: address, ledger_index: "validated" }, fetchImpl),
    rpc(url, "server_state", {}, fetchImpl),
  ]);
  const ledger = (state.state as { validated_ledger?: { reserve_base?: number } } | undefined)
    ?.validated_ledger;
  if (typeof ledger?.reserve_base !== "number") throw new Error(`${url} sent no reserve`);
  const reserveDrops = BigInt(ledger.reserve_base);
  if (info.error === "actNotFound") {
    return { exists: false, requireDestTag: false, depositAuth: false, reserveDrops };
  }
  const flags = (info.account_data as { Flags?: number } | undefined)?.Flags;
  if (typeof flags !== "number") throw new Error(`${url} sent no account flags`);
  return {
    exists: true,
    requireDestTag: (flags & LSF_REQUIRE_DEST_TAG) !== 0,
    depositAuth: (flags & LSF_DEPOSIT_AUTH) !== 0,
    reserveDrops,
  };
}

export async function xrpAccount(
  address: string,
  fetchImpl: typeof fetch = fetch,
): Promise<XrpAccount> {
  for (const url of XRPL_RPCS) {
    try {
      return await readFrom(url, address, fetchImpl);
    } catch {
      // try the next server
    }
  }
  throw new Error(
    "We couldn't check this XRP account on the XRP Ledger just now. Try again in a minute.",
  );
}

/**
 * Why the ledger would refuse NEAR Intents' payment to `account`, in a sentence, or null.
 * `amountDrops` is the least the swap delivers (1Click's `minAmountOut`, XRP has 6 decimals);
 * without it only the account's own settings are checked.
 */
export function xrpDeliveryProblem(account: XrpAccount, amountDrops?: string): string | null {
  if (account.requireDestTag) {
    return "This XRP account needs a destination tag with every payment, so it is probably an exchange. NEAR Intents can't add a tag yet: send to an XRP wallet you control.";
  }
  if (account.depositAuth) {
    return "This XRP account only accepts payments from senders it has approved, so NEAR Intents can't pay it. Use another XRP wallet.";
  }
  if (!account.exists && amountDrops !== undefined && BigInt(amountDrops) < account.reserveDrops) {
    const xrp = Number(account.reserveDrops) / 1e6;
    return `This XRP account isn't open yet, and the XRP Ledger needs at least ${xrp} XRP to open one. Send more, or use an account that is already open.`;
  }
  return null;
}
