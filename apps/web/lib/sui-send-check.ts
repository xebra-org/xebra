/**
 * After a Sui wallet reports an error, find out whether the burn went through anyway.
 *
 * A wallet can sign and submit, then fail while waiting for the result (on a phone that loses its
 * network, Android wallets surface `java.net.UnknownHostException`). Retrying blind would send the
 * money twice. So the page reads the wallet's newest burn before signing (`lastSuiBurn`), and after
 * an error looks again for a newer one (`findBurnAfterFailure`) before telling the person anything.
 */

export interface SeenBurn {
  digest: string;
  destinationDomain: number;
}

/** The newest burn, `null` for none, `undefined` when it could not be read. */
export type BurnReading = SeenBurn | null | undefined;

export type BurnCheck = { kind: "found"; burn: SeenBurn } | { kind: "none" } | { kind: "unknown" };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function lastSuiBurn(
  sender: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4000,
): Promise<BurnReading> {
  try {
    const res = await fetchImpl(`/api/sui-stellar/last-burn?sender=${encodeURIComponent(sender)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { burn?: SeenBurn | null };
    return body.burn === undefined ? undefined : body.burn;
  } catch {
    return undefined;
  }
}

/**
 * Looks for a burn newer than `before`, a few times over about twenty seconds, because Sui's index
 * can trail the chain by a few seconds. `unknown` when there was no reading before signing, or when
 * the last look failed: the page then cannot promise that nothing was sent.
 */
export async function findBurnAfterFailure(
  sender: string,
  before: BurnReading,
  opts: {
    delaysMs?: readonly number[];
    read?: (sender: string) => Promise<BurnReading>;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<BurnCheck> {
  if (before === undefined) return { kind: "unknown" };
  const { delaysMs = [0, 3000, 6000, 10_000], read = lastSuiBurn, wait = sleep } = opts;
  let last: BurnReading;
  for (const ms of delaysMs) {
    if (ms > 0) await wait(ms);
    last = await read(sender);
    if (last && last.digest !== before?.digest) return { kind: "found", burn: last };
  }
  return last === undefined ? { kind: "unknown" } : { kind: "none" };
}

// Phrases wallets and browsers use when the network, not the person, stopped the request.
const NETWORK =
  /unknownhost|unable to resolve host|no address associated|fetch failed|failed to fetch|load failed|network ?error|network request failed|enotfound|econnreset|econnrefused|etimedout|timed? ?out|socket|offline/i;

/** Whether an error message says the wallet could not reach the network. Pure. */
export function isNetworkError(text: string): boolean {
  return NETWORK.test(text);
}

// How wallets say the person said no ("User rejected the request", "Cancelled", ...). A bare
// "closed" is left out: "connection closed" is the network, not the person.
const DECLINED =
  /reject|declin|den(y|ied)|cancel|dismiss|(user|popup|window|modal|dialog) (was )?closed|closed by (the )?user/i;

/**
 * Whether an error message says the person turned the request down. A message that also reads as a
 * network failure is not a decline, so it gets the full check on Sui. Pure.
 */
export function isDeclined(text: string): boolean {
  return DECLINED.test(text) && !NETWORK.test(text);
}

const LOOK_FIRST =
  "Open your wallet's activity and check before you try again, so you do not send twice.";

/** What the person is told when the burn did not show up on Sui. Pure. */
export function sendFailureMessage(text: string, check: "none" | "unknown"): string {
  const network = isNetworkError(text);
  if (check === "none") {
    return network
      ? "Your wallet could not reach the Sui network, so nothing was sent. Check your internet connection and try again."
      : `${text} Nothing was sent: no new transfer from your wallet shows on Sui.`;
  }
  return network
    ? `Your wallet could not reach the Sui network, and we could not confirm whether the transfer went out. ${LOOK_FIRST}`
    : `${text} We could not confirm whether the transfer went out. ${LOOK_FIRST}`;
}
