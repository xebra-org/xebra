import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "../components/site/site-footer";
import { ContentHeader } from "../components/site/site-nav";
import { cn } from "../components/ui/cn";
import { ArrowRight } from "../components/ui/icons";
import { env } from "../lib/env";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: true },
};

/** Where someone who followed a dead link most likely meant to go. */
const PLACES = [
  { href: "/routes", label: "Routes", note: "Every chain pair we move USDC between." },
  { href: "/claim", label: "Claim a transfer", note: "Finish a transfer that has not arrived." },
  { href: "/near-intents", label: "NEAR Intents", note: "Send USDC into any NEAR Intents asset." },
  { href: "https://docs.xebra.exchange", label: "Docs", note: "API, SDK and mainnet proof." },
] as const;

/**
 * The page for any address the app does not serve. Same frame as the written pages, so a dead link
 * still lands somewhere that looks like Xebra and leads back to the bridge.
 */
export default function NotFound() {
  return (
    <>
      <ContentHeader />
      <main id="content" className="mx-auto w-full max-w-2xl px-4 pt-20 sm:px-5 sm:pt-28">
        <p className="tabular font-mono text-xs tracking-[0.2em] text-bone/40">ERROR 404</p>
        <h1 className="mt-4 text-balance text-4xl font-semibold tracking-tight text-bone sm:text-5xl">
          Nothing lives at this address.
        </h1>
        <p className="mt-5 max-w-[52ch] text-pretty text-[0.9375rem] leading-relaxed text-bone/55">
          The link may be old or mistyped. Your funds are not affected by a missing page: a transfer
          you started is still on chain, and you can follow it from the claim page with its hash.
        </p>

        <Link
          href="/#bridge"
          className={cn(
            "mt-9 inline-flex h-11 items-center gap-2 rounded-full bg-bone px-5 text-sm font-medium",
            "text-obsidian shadow-pill transition-[background-color,transform] duration-400 ease-haptic",
            "hover:bg-white active:scale-[0.98]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bone/60 focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian",
          )}
        >
          Open the bridge
          <ArrowRight className="h-4 w-4" />
        </Link>

        <ul className="mt-16 divide-y divide-bone/[0.07] border-y border-bone/[0.07]">
          {PLACES.map((p) => (
            <li key={p.href}>
              <Link
                href={p.href}
                className={cn(
                  "group flex items-center justify-between gap-6 py-4",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bone/40 rounded-sm",
                )}
              >
                <span>
                  <span className="block text-sm font-medium text-bone/85 transition-colors duration-400 ease-haptic group-hover:text-bone">
                    {p.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-bone/40">{p.note}</span>
                </span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-bone/30 transition-[color,transform] duration-400 ease-haptic group-hover:translate-x-0.5 group-hover:text-bone" />
              </Link>
            </li>
          ))}
        </ul>
      </main>
      <SiteFooter
        wrapperContractId={env.cctpWrapperContractId}
        contractLabel="Stellar contract"
        wide
      />
    </>
  );
}
