import { IrisUnavailable } from "@xebra/cctp-client";
import { irisBaseUrl, irisFetch } from "../../../lib/server/iris";
import { logFailure } from "../../../lib/server/log";
import { createTtlCache } from "../../../lib/server/ttl-cache";

/**
 * Asks Circle to attest a message again.
 *
 * Only a Fast burn needs this. Circle signs a Fast burn before its source chain has finalised, and
 * bounds how long that early signature stays good: the message carries an `expirationBlock` on the
 * destination, about a day out. Circle's Forwarding Service normally mints long before then. If it
 * did not, and nobody claimed in time, the mint reverts as expired. The money is not lost; Circle
 * issues a fresh attestation for the same nonce on request, and this is that request. `/claim`
 * offers it when it sees an expired message.
 *
 * Public and unauthenticated, like the attestation it refreshes: the nonce is public, and all this
 * can do is make Circle re-sign a message that already exists. It spends our Iris budget, so an
 * accepted request for a nonce is not repeated for a minute however many times the button is
 * pressed. A refusal is not remembered, so trying again is always a real attempt.
 */

export const dynamic = "force-dynamic";

const NONCE = /^0x[0-9a-f]{64}$/;

/** Circle said no. Thrown so the cache keeps only requests that were accepted. */
class Refused extends Error {
  constructor(
    reason: string,
    readonly http: number,
  ) {
    super(reason);
  }
}

const requested = createTtlCache<true>(60_000);

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { nonce?: unknown } | null;
  const nonce = typeof body?.nonce === "string" ? body.nonce.trim().toLowerCase() : "";
  if (!NONCE.test(nonce)) {
    return Response.json(
      { error: "nonce must be 0x followed by 64 hex characters" },
      { status: 400 },
    );
  }

  try {
    await requested(nonce, async () => {
      const res = await irisFetch(`${irisBaseUrl()}/v2/reattest/${nonce}`, {
        method: "POST",
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) return true as const;
      const rawBody = await res.text().catch(() => "");
      logFailure(
        "/api/reattest",
        new Error(`Circle /v2/reattest returned ${res.status}`),
        { status: res.status, nonce, body: rawBody },
        request,
      );
      let circleMessage = "";
      try {
        const detail = JSON.parse(rawBody) as { message?: unknown } | null;
        if (typeof detail?.message === "string") circleMessage = detail.message;
      } catch {
        // Non-JSON upstream error body; logged raw above.
      }
      if (res.status === 404) {
        throw new Refused("Circle has no attestation for that nonce.", 404);
      }
      if (res.status >= 400 && res.status < 500) {
        if (/already/i.test(circleMessage)) {
          throw new Refused("It was already renewed; look it up again.", 409);
        }
        if (/not\s+(?:yet\s+)?expired|unexpired/i.test(circleMessage)) {
          throw new Refused("This attestation has not expired, so it does not need renewing.", 422);
        }
        throw new Refused("Circle could not renew this attestation.", 422);
      }
      throw new Refused(`Circle returned ${res.status}`, 502);
    });
    return Response.json({ status: "requested" });
  } catch (err) {
    if (err instanceof Refused) {
      return Response.json({ status: "failed", reason: err.message }, { status: err.http });
    }
    logFailure("/api/reattest", err, { nonce }, request);
    if (err instanceof IrisUnavailable) {
      return Response.json(
        { status: "failed", reason: "Circle lookups are paused for a moment; try again shortly" },
        { status: 503 },
      );
    }
    return Response.json({ status: "failed", reason: "could not reach Circle" }, { status: 502 });
  }
}
