import { formatUsdc } from "@xebra/sdk/core";
import type { BridgeQuote } from "../../lib/cctp-bridge";
import { XebraMark } from "../brand/xebra-mark";
import { cn } from "../ui/cn";
import { DataRow } from "../ui/data-row";
import { InsetTray } from "../ui/glass-card";
import { Notice } from "../ui/notice";
import { Skeleton } from "../ui/skeleton";
import { StripeRule } from "../ui/stripe-rule";

/** The Stellar route's fee breakdown, read from the wrapper contract's own `quote()`. */
export function QuotePanel({
  quote,
  loading,
  error,
  hasAddress,
  destinationName,
}: {
  quote: BridgeQuote | null;
  loading: boolean;
  error: string | null;
  hasAddress: boolean;
  destinationName: string;
}) {
  if (!hasAddress) {
    return (
      <div className="mt-6 flex items-center justify-center gap-2.5 rounded-tray border border-dashed border-bone/[0.09] px-4 py-6 text-center">
        <XebraMark className="h-4 w-4 text-bone/25" />
        <p className="text-[0.8125rem] text-bone/35">Connect a wallet to see the fee breakdown.</p>
      </div>
    );
  }

  if (error) {
    return (
      <Notice tone="alarm" title="Could not price this transfer" className="mt-6">
        {error}
      </Notice>
    );
  }

  if (loading || !quote) {
    // Skeleton matching the real panel's shape, rather than a spinner that tells you nothing
    // about what is coming — and, more practically, so the plate does not resize under the
    // cursor the moment a quote lands.
    return (
      <InsetTray className="mt-6 space-y-3.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center justify-between">
            <Skeleton className={cn("h-3", i === 2 ? "w-28" : "w-20")} />
            <Skeleton className={cn("h-3", i === 2 ? "w-24" : "w-16")} />
          </div>
        ))}
      </InsetTray>
    );
  }

  return (
    <InsetTray className="mt-6">
      <dl className="tabular space-y-3">
        <DataRow label="Amount" value={`${formatUsdc(quote.amount)} USDC`} />
        <DataRow
          label="Fee"
          value={`−${formatUsdc(quote.fee)} USDC`}
          hint={`Includes Circle's delivery to ${destinationName}${quote.accountCreated ? ", and opening the recipient's USDC account" : ""}. Nothing more to pay on ${destinationName}.`}
        />
        {quote.remainder > 0n && (
          <DataRow
            label="Not sent"
            value={`${formatUsdc(quote.remainder)} USDC`}
            hint={`Below USDC's smallest unit on ${destinationName}, so it stays in your wallet.`}
          />
        )}
        <div className="pt-3">
          <StripeRule className="mb-3 opacity-50" />
          <DataRow
            label="Recipient gets"
            value={`${formatUsdc(quote.netBurned - quote.forwardFee)} USDC`}
            emphasis
            hint="After every fee."
          />
        </div>
      </dl>
    </InsetTray>
  );
}
