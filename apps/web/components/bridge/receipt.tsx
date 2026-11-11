"use client";

import type { Destination } from "@xebra/sdk/core";
import { useEffect, useState } from "react";
import type { DeliveryView } from "../../lib/circle-status";
import { cn } from "../ui/cn";
import { InsetTray } from "../ui/glass-card";
import { Check, Copy } from "../ui/icons";
import { Notice } from "../ui/notice";

/** What a receipt needs to know about where the dollars are going. */
export type ReceiptDestination = Pick<Destination, "name" | "explorerTxUrl" | "claimCost">;

/**
 * What differs between routes. Every field is optional and its absence reproduces the Stellar
 * receipt exactly, which is the one that has been read by real people.
 */
export interface ReceiptRoute {
  /** How long delivery usually takes, as a sentence. */
  eta?: string;
  /** Where the burn itself can be seen. */
  burnUrl?: string;
  /** Where to claim by hand. A Stellar burn is found by its hash alone; others name their chain. */
  claimHref?: string;
  /**
   * True for a Fast burn. Its attestation is good for about a day, not forever, and the receipt
   * must not promise otherwise.
   */
  expires?: boolean;
  /** Said of a transfer that is attested but that Circle has not delivered. */
  claimableLine?: string;
}

export function SubmittedNotice({
  txHash,
  delivery,
  destination,
  route = {},
}: {
  txHash: string;
  delivery: DeliveryView | null;
  destination: ReceiptDestination;
  route?: ReceiptRoute;
}) {
  return (
    <div className="mt-6">
      <Notice tone="signal" title="Burn submitted">
        Circle attests the transfer, then delivers it to {destination.name}.{" "}
        {route.eta ?? "This usually takes a few minutes."} If delivery ever fails, your USDC is
        still yours: anyone holding Circle&rsquo;s attestation can complete the mint, and you can do
        it yourself.
      </Notice>
      <InsetTray className="mt-2.5 py-3">
        <div className="flex items-center gap-3">
          <span className="tabular min-w-0 flex-1 truncate font-mono text-xs text-bone/45">
            {txHash}
          </span>
          {route.burnUrl && (
            <a
              href={route.burnUrl}
              target="_blank"
              rel="noreferrer"
              className={`shrink-0 text-xs ${claimLink}`}
            >
              View
            </a>
          )}
          <CopyButton value={txHash} label="transaction hash" />
        </div>
        <DeliveryStatus
          delivery={delivery}
          txHash={txHash}
          destination={destination}
          route={route}
        />
      </InsetTray>
    </div>
  );
}

const claimLink =
  "text-bone/70 underline decoration-bone/25 underline-offset-[3px] transition-colors duration-200 ease-haptic hover:text-bone hover:decoration-bone/50";

/**
 * Where the transfer is, in Circle's words.
 *
 * Three outcomes ask different things of the reader. Waiting and forwarding mean do nothing.
 * Delivered links to the destination transaction. Failed and claimable mean the dollars are burned
 * and one more signature from the owner collects them, so the link has to be here rather than left
 * as an idea. There is no relay to fall back on: a failed forward is the owner's to claim, and the
 * page says so plainly.
 *
 * `unknown` is its own line. Not being able to ask is not progress and not failure.
 */
export function DeliveryStatus({
  delivery,
  txHash,
  destination,
  route = {},
}: {
  delivery: DeliveryView | null;
  txHash: string;
  destination: ReceiptDestination;
  route?: ReceiptRoute;
}) {
  const line = "mt-2.5 flex items-center gap-2 border-t border-bone/[0.06] pt-2.5 text-[0.75rem]";

  if (delivery?.status === "known" && delivery.state === "delivered") {
    return (
      <div className={`${line} text-bone/45`}>
        <span className="h-1 w-1 shrink-0 rounded-full bg-signal" />
        <span>
          Delivered to {destination.name}.{" "}
          {delivery.forwardTxHash ? (
            <a
              href={destination.explorerTxUrl(delivery.forwardTxHash)}
              target="_blank"
              rel="noreferrer"
              className={claimLink}
            >
              View it
            </a>
          ) : null}
        </span>
      </div>
    );
  }

  if (
    delivery?.status === "known" &&
    (delivery.state === "failed" || delivery.state === "claimable")
  ) {
    return (
      <div className="mt-2.5 border-t border-bone/[0.06] pt-2.5 text-[0.75rem] leading-relaxed text-bone/45">
        <p className="flex items-center gap-2">
          <span className="h-1 w-1 shrink-0 rounded-full bg-alarm" />
          {delivery.state === "failed"
            ? `Circle could not deliver this to ${destination.name}${delivery.reason ? ` (${delivery.reason})` : ""}.`
            : (route.claimableLine ??
              `This transfer was not set up for automatic delivery to ${destination.name}.`)}
        </p>
        <p className="mt-1.5 pl-3">
          {route.expires ? (
            <>
              Your USDC is burned and still yours: Circle&rsquo;s attestation is public, so it can
              be minted by anyone holding it. A Fast transfer&rsquo;s attestation is good for about
              a day; after that the claim page asks Circle for a fresh one.
            </>
          ) : (
            <>
              Your USDC is burned and still yours: Circle&rsquo;s attestation is public and does not
              expire for a transfer like this, so it can be minted by anyone holding it.
            </>
          )}{" "}
          <a
            href={route.claimHref ?? `/claim?tx=${encodeURIComponent(txHash)}`}
            className={claimLink}
          >
            Claim it yourself
          </a>{" "}
          — you pay the {destination.name} gas, {destination.claimCost}.
        </p>
      </div>
    );
  }

  if (delivery?.status === "unknown") {
    return (
      <p className={`${line} text-bone/45`}>
        <span className="h-1 w-1 shrink-0 rounded-full bg-bone/30" />
        We cannot read Circle&rsquo;s status right now. Your transfer is not affected; check{" "}
        {destination.name} for the USDC, or try again shortly.
      </p>
    );
  }

  return (
    <p className={`${line} text-bone/45`}>
      <span className="h-1 w-1 shrink-0 rounded-full bg-signal animate-breathe" />
      {delivery?.status === "known" && delivery.state === "forwarding"
        ? `Circle is delivering to ${destination.name}.`
        : "Waiting for Circle to attest the transfer."}
    </p>
  );
}

/**
 * Copies and says so. A hash long enough to need truncating is a hash nobody transcribes by
 * hand, and the confirmation has to be visible rather than implied — the clipboard gives no
 * feedback of its own.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => setCopied(true),
          // A clipboard write can be refused (insecure origin, denied permission). Silently
          // doing nothing is fine here: the hash is on screen and selectable.
          () => undefined,
        );
      }}
      className={cn(
        "grid h-7 w-7 shrink-0 place-items-center rounded-full",
        "transition-colors duration-400 ease-haptic",
        copied ? "text-signal" : "text-bone/40 hover:bg-bone/[0.08] hover:text-bone",
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      <span className="sr-only">{copied ? `Copied the ${label}` : `Copy the ${label}`}</span>
    </button>
  );
}
