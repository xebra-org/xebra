import {
  type Delivery,
  IrisUnavailable,
  readDelivery,
  readDestinationDomain,
} from "@xebra/cctp-client";
import { irisBaseUrl, irisFetch, stellarDomainId } from "../../../lib/server/iris";
import { normaliseTxHash, readSource, txHashHint } from "../../../lib/server/routes";
import { createTtlCache } from "../../../lib/server/ttl-cache";

/**
 * How a burn is getting on, straight from Circle. Polled by the receipt so the pending state
 * resolves instead of spinning.
 *
 * There is no relay to ask. Circle's Forwarding Service mints on the destination, and Iris reports
 * how that went (`forwardState`, `forwardTxHash`), so this is one budgeted lookup by transaction
 * hash, cached for a few seconds because every receipt for the same burn asks the same question.
 *
 * `unknown` means we could not ask — Circle unreachable, or our own rate budget holding us back. It
 * is deliberately not `waiting`: an unanswerable question is not progress, and the page must not
 * imply the transfer is fine or failed on the strength of it.
 *
 * A burn made on an EVM chain names it with `&src=<CCTP domain>`; with no `src` the burn is a
 * Stellar one, as every link sent before EVM sources existed assumes.
 *
 * `destinationDomain` is the domain the burn's message names, once Circle has indexed it: a Sui burn
 * goes to Stellar through our relayer or anywhere else through Circle's Forwarding Service, and the
 * same digest is read differently for each.
 *
 * Read-only and public: it answers only about a burn hash the caller already holds.
 */

export const dynamic = "force-dynamic";

type Answer =
  | { status: "known"; delivery: Delivery; destinationDomain: number | null }
  | { status: "unknown"; reason: string };

/** The destination domain of the first message in Iris's answer, or null when there is none. */
function destinationOf(body: unknown): number | null {
  const message = (body as { messages?: Array<{ message?: unknown }> } | null)?.messages?.[0]
    ?.message;
  if (typeof message !== "string" || !message.startsWith("0x")) return null;
  try {
    return readDestinationDomain(message as `0x${string}`);
  } catch {
    return null;
  }
}

const cached = createTtlCache<Answer>(5_000);

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const source = readSource(params.get("src"), stellarDomainId());
  if (!source) {
    return Response.json({ error: "src is not a chain transfers start from" }, { status: 400 });
  }
  const tx = normaliseTxHash(source.kind, params.get("tx"));
  if (!tx) return Response.json({ error: txHashHint(source.kind) }, { status: 400 });

  const answer = await cached(`${source.domain}:${tx}`, async (): Promise<Answer> => {
    try {
      const res = await irisFetch(
        `${irisBaseUrl()}/v2/messages/${source.domain}?transactionHash=${tx}`,
        { cache: "no-store", signal: AbortSignal.timeout(6_000) },
      );
      // 404 is "not indexed yet", which is just waiting; anything else that is not OK is a
      // question we could not answer.
      if (res.status === 404) {
        return { status: "known", delivery: readDelivery(null), destinationDomain: null };
      }
      if (!res.ok) return { status: "unknown", reason: `Circle returned ${res.status}` };
      const body: unknown = await res.json();
      return {
        status: "known",
        delivery: readDelivery(body),
        destinationDomain: destinationOf(body),
      };
    } catch (err) {
      if (err instanceof IrisUnavailable) {
        return { status: "unknown", reason: "status lookups are paused for a moment" };
      }
      return { status: "unknown", reason: "could not reach Circle" };
    }
  });

  return Response.json(
    answer.status === "known"
      ? { status: "known", ...answer.delivery, destinationDomain: answer.destinationDomain }
      : answer,
  );
}
