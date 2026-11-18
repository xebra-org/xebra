"use client";

import { useSearchContext } from "fumadocs-ui/contexts/search";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const ERRORS_PREFIX = "/docs/errors/";

export default function NotFound() {
  const pathname = usePathname() ?? "";
  const { setOpenSearch } = useSearchContext();
  // The 404 is prerendered without the requested path, so the first client render must match that
  // HTML; the error-code wording is chosen after mount to avoid a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // `/errors/<code>` is redirected to `/docs/errors/<code>`, so a problem `type` URL for a code
  // newer than these docs arrives here with the second form.
  const isUnknownErrorCode = mounted && pathname.startsWith(ERRORS_PREFIX);

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-4 px-6 py-24">
      <p className="text-fd-muted-foreground font-mono text-sm">404</p>
      <h1 className="text-3xl font-semibold tracking-[-0.02em]">
        {isUnknownErrorCode ? "This error code is newer than these docs" : "Page not found"}
      </h1>
      <p className="text-fd-muted-foreground">
        {isUnknownErrorCode
          ? "The API returned a code these docs do not describe yet. Browse the error index for the codes that are documented."
          : "There is no page at this address. It may have moved, or the link may be wrong."}
      </p>
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <Link
          href="/docs/errors"
          className="bg-fd-primary text-fd-primary-foreground rounded-md px-4 py-2 text-sm font-medium"
        >
          Error index
        </Link>
        <Link href="/docs" className="rounded-md border px-4 py-2 text-sm font-medium">
          Docs home
        </Link>
        <button
          type="button"
          onClick={() => setOpenSearch(true)}
          className="rounded-md border px-4 py-2 text-sm font-medium"
        >
          Search the docs
        </button>
      </div>
    </main>
  );
}
