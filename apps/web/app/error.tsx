"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "../components/ui/button";
import { Notice } from "../components/ui/notice";

/**
 * Catches any unhandled error thrown inside the root layout's `children` slot. The root layout
 * itself stays mounted, so the site header, providers and global styles all survive — only the
 * broken subtree is replaced by this fallback.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[error boundary]", error.digest, error);
  }, [error]);

  return (
    <main id="content" className="mx-auto w-full max-w-2xl px-4 pt-20 sm:px-5 sm:pt-28">
      <Notice tone="alarm" title="Something went wrong">
        <p>Something on this page broke. Any USDC you already burned is safe on chain.</p>
      </Notice>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button variant="primary" size="md" onClick={reset}>
          Try again
        </Button>

        <Link
          href="/claim"
          className="inline-flex h-11 items-center gap-2 rounded-full px-5 text-sm font-medium text-bone/60 transition-colors duration-400 ease-haptic hover:text-bone"
        >
          Find my transfer
        </Link>
      </div>
    </main>
  );
}
