import { IrisUnavailable, readDestinationDomain, readExpirationBlock } from "@xebra/cctp-client";
import { CCTP_DOMAIN, PRESETS, evmChainForDomain } from "@xebra/network-config";
import { env } from "../../../lib/env";
import { irisBaseUrl, irisFetch, stellarDomainId } from "../../../lib/server/iris";
import { normaliseTxHash, readSource, txHashHint } from "../../../lib/server/routes";

/**
 * Circle's attested `(message, attestation)` pair for a burn.
 *
 * This is what makes a transfer claimable by anyone. Circle attests a burn and publishes the
 * signed pair; whoever holds it can submit `receiveMessage` on the destination chain and
 * complete the mint. Circle's Forwarding Service normally does that for you; when a forward does
 * not land, this route is what lets the owner do it themselves at `/claim`.
 *
 * # Why it is proxied rather than called from the browser
 *
 * Only so the Iris base URL stays a single server-side value. Iris itself permits browser
 * origins, unlike Solana's RPC. Making it a `NEXT_PUBLIC_*` would mean a build-time constant
 * baked into the bundle and one more variable that has to be right before the build — and
 * pointing at Circle's sandbox by mistake leaves every burn "pending" forever rather than failing
 * loudly.
 *
 * Nothing here is secret. The response is public data about a public transaction.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  // No `src` means a Stellar burn, as it always has. An EVM burn names its chain.
  const source = readSource(params.get("src"), stellarDomainId());
  if (!source) {
    return Response.json({ error: "src is not a chain transfers start from" }, { status: 400 });
  }
  const tx = normaliseTxHash(source.kind, params.get("tx"));
  if (!tx) return Response.json({ error: txHashHint(source.kind) }, { status: 400 });

  const domain = String(source.domain);

  try {
    // Through the shared budget, like every Iris call from here, so a burst of claim lookups
    // cannot get us blocked.
    const res = await irisFetch(`${irisBaseUrl()}/v2/messages/${domain}?transactionHash=${tx}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });

    // Iris answers 404 for a transaction it has not indexed. That is "not yet", not an error:
    // a burn is queryable within seconds but a caller may simply be early.
    if (res.status === 404) {
      return Response.json({ status: "unknown", reason: "Circle has not indexed this burn yet" });
    }
    if (!res.ok) {
      return Response.json(
        { status: "unknown", reason: `Circle returned ${res.status}` },
        { status: 502 },
      );
    }

    const body = (await res.json()) as {
      messages?: Array<{
        message: string;
        attestation: string | null;
        status: string;
        eventNonce?: string;
      }>;
    };

    const first = body.messages?.[0];
    if (!first) {
      return Response.json({ status: "unknown", reason: "no CCTP message in that transaction" });
    }
    if (first.status !== "complete" || !first.attestation) {
      // Circle signs within a couple of minutes for a fast transfer. Reported separately from
      // "unknown" because waiting is the right response and retrying a different hash is not.
      return Response.json({ status: "pending" });
    }

    // Read from the message itself — the copy Circle's contracts enforce — so the page can never
    // be told one destination while the message says another.
    const message = first.message as `0x${string}`;
    const destinationDomain = readDestinationDomain(message);
    const arc = PRESETS.mainnet.arc;
    const evm = evmChainForDomain(destinationDomain);

    return Response.json({
      status: "complete",
      message: first.message,
      attestation: first.attestation,
      // Solana's USDC mint, so the page can check the recipient token account without another
      // build-time constant of its own.
      usdcMint: env.usdcSolanaMint,
      sourceDomainId: Number(domain),
      destinationDomain,
      // What re-attesting an expired message is keyed on, and the destination block after which
      // this one expires. Zero for a Standard burn, which never does; a Fast burn's attestation
      // is good for about a day. A string because a block number is not a safe JSON number
      // everywhere.
      eventNonce: first.eventNonce ?? null,
      expirationBlock: readExpirationBlock(message).toString(),
      // For any EVM destination: where and how to submit the mint by hand.
      ...(evm
        ? {
            evm: {
              chainId: evm.chainId,
              name: evm.name,
              messageTransmitter: evm.messageTransmitterAddress,
              rpcUrl: evm.rpcUrl,
              explorerUrl: evm.explorerUrl,
              nativeCurrency: evm.nativeCurrency,
              claimCost: evm.claimCost,
            },
          }
        : {}),
      // The older, Arc-only form of `evm`, kept for a page that loaded before `evm` existed.
      ...(destinationDomain === CCTP_DOMAIN.arc
        ? {
            arc: {
              chainId: arc.chainId,
              messageTransmitter: arc.messageTransmitterAddress,
              rpcUrl: arc.rpcUrl,
              explorerUrl: arc.explorerUrl,
            },
          }
        : {}),
    });
  } catch (err) {
    if (err instanceof IrisUnavailable) {
      const retryAfterSeconds = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
      return Response.json(
        { status: "unknown", reason: "Circle lookups are paused for a moment; try again shortly" },
        {
          status: 503,
          headers: {
            "Retry-After": String(retryAfterSeconds),
          },
        },
      );
    }
    console.error("attestation lookup failed", err);
    return Response.json({ status: "unknown", reason: "could not reach Circle" }, { status: 502 });
  }
}
