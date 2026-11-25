"use client";

import { useEffect, useState } from "react";
import { SUPPORT_LABEL, SUPPORT_URL, type UserError } from "../../lib/user-error";
import { cn } from "./cn";
import { Check, Copy } from "./icons";
import { Notice } from "./notice";

const FUNDS: Record<NonNullable<UserError["funds"]>, string> = {
  unmoved: "Your USDC hasn't moved.",
  uncertain: "Your USDC may already be on its way.",
  "unless-shown": "Your USDC hasn't moved unless this page shows a transaction for it.",
};

/**
 * A failure, written for the person in front of it (`lib/user-error.ts` says how): what happened,
 * what to do, and where their money is. The raw failure stays folded away under "Technical
 * details", with a button that copies it for support, so nobody is sent to a browser console.
 */
export function ErrorNotice({
  error,
  className,
  txUrl,
}: {
  error: UserError;
  className?: string | undefined;
  /** An explorer link for `error.txHash`, when the form knows how to build one. */
  txUrl?: string | undefined;
}) {
  return (
    <Notice tone={error.tone} title={error.title} className={className ?? ""}>
      <p className="max-w-[60ch] text-pretty text-bone/65">{error.body}</p>

      {error.steps.length === 1 && <p className="mt-2 text-bone/65">{error.steps[0]}</p>}
      {error.steps.length > 1 && (
        <ol className="mt-2.5 list-decimal space-y-1 pl-4 text-bone/65 marker:text-bone/35">
          {error.steps.map((step) => (
            <li key={step} className="pl-1">
              {step}
            </li>
          ))}
        </ol>
      )}

      {(error.funds || error.txHash) && (
        <p className="mt-3 text-bone/45">
          {error.funds && FUNDS[error.funds]}
          {error.txHash && (
            <>
              {error.funds && " "}
              {txUrl ? (
                <a
                  href={txUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-bone/25 underline-offset-[3px] transition-colors duration-200 ease-haptic hover:text-bone hover:decoration-bone/50"
                >
                  Check the transaction
                </a>
              ) : (
                <>
                  Transaction{" "}
                  <span className="break-all font-mono text-[0.75rem] text-bone/60">
                    {error.txHash}
                  </span>
                </>
              )}
              .
            </>
          )}
        </p>
      )}

      {error.detail && <TechnicalDetails title={error.title} detail={error.detail} />}
    </Notice>
  );
}

function TechnicalDetails({ title, detail }: { title: string; detail: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const report = () =>
    [
      title,
      `Page: ${typeof window === "undefined" ? "" : window.location.pathname}`,
      `Time: ${new Date().toISOString()}`,
      "",
      detail,
    ].join("\n");

  return (
    <details className="group mt-3">
      <summary
        className={cn(
          "inline-flex cursor-pointer list-none items-center gap-1.5 rounded-sm text-[0.75rem] text-bone/40",
          "transition-colors duration-200 ease-haptic hover:text-bone/70",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone/40",
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        <span
          aria-hidden
          className="inline-block transition-transform duration-200 ease-haptic group-open:rotate-90"
        >
          ›
        </span>
        Technical details
      </summary>
      <div className="mt-2 rounded-md bg-bone/[0.04] p-3 ring-1 ring-inset ring-bone/[0.06]">
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.6875rem] leading-relaxed text-bone/50">
          {detail}
        </pre>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[0.75rem]">
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(report()).then(
                () => setCopied(true),
                // A refused clipboard write leaves the text on screen to select by hand.
                () => undefined,
              );
            }}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ring-1 ring-inset",
              "transition-colors duration-200 ease-haptic active:translate-y-px",
              "focus-visible:outline-none focus-visible:ring-bone/40",
              copied
                ? "text-signal ring-signal/30"
                : "text-bone/55 ring-bone/15 hover:bg-bone/[0.06] hover:text-bone",
            )}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy details"}
          </button>
          <span className="text-bone/35">
            Still stuck?{" "}
            <a
              href={SUPPORT_URL}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-bone/25 underline-offset-[3px] transition-colors duration-200 ease-haptic hover:text-bone/70"
            >
              {SUPPORT_LABEL}
            </a>{" "}
            and paste them.
          </span>
        </div>
      </div>
    </details>
  );
}
