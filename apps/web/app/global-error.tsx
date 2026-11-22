"use client";

import { useEffect } from "react";
import { Button } from "../components/ui/button";
import { Notice } from "../components/ui/notice";
import "./globals.css";

/**
 * Last-resort error boundary — catches errors thrown by the root layout itself. Because the root
 * layout has crashed, nothing from it survives: this component must render its own `<html>` and
 * `<body>` and import `globals.css` directly so the page keeps its theme and typography.
 *
 * Navigation via `<a>` rather than Next's `<Link>` because the router context may have crashed
 * along with the layout.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[global-error boundary]", error.digest, error);
  }, [error]);

  return (
    <html lang="en">
      <body className="grain min-h-[100dvh] bg-obsidian font-sans text-bone antialiased">
        <main id="content" className="mx-auto w-full max-w-2xl px-4 pt-20 sm:px-5 sm:pt-28">
          <Notice tone="alarm" title="Something went wrong">
            <p>Something on this page broke. Any USDC you already burned is safe on chain.</p>
          </Notice>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button variant="primary" size="md" onClick={reset}>
              Try again
            </Button>

            <a
              href="/claim"
              className="inline-flex h-11 items-center gap-2 rounded-full px-5 text-sm font-medium text-bone/60 transition-colors duration-400 ease-haptic hover:text-bone"
            >
              Find my transfer
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
