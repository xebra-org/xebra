import Link from "next/link";
import type React from "react";
import type { Faq } from "../../lib/seo/faq";
import { stripMarkdown } from "../../lib/seo/json-ld";
import { ENDPOINT_NAMES, type RouteInfo } from "../../lib/seo/routes";
import { type Chain, ChainGlyph } from "../bridge/chain-glyph";
import { ArrowRight } from "../ui/icons";
import { StripeRule } from "../ui/stripe-rule";

/**
 * Below the bridge: the three things a first-time visitor asks, answered in text that is in the
 * page's HTML (not drawn after it loads), so search engines and assistants read it too.
 *
 * Kept quiet on purpose. The plate above is the product; this is reference, set in the same small
 * type as the assurances, with each part linking to its full page.
 */
export function HomeSections({ routes, faq }: { routes: RouteInfo[]; faq: Faq[] }) {
  const sources = [...new Set(routes.map((r) => r.from))];
  return (
    <div className="mt-24 space-y-20">
      <section aria-labelledby="how-heading">
        <SectionHeading id="how-heading" href="/how-it-works" link="How it works">
          Burn, attest, mint
        </SectionHeading>
        <ol className="mt-6 grid gap-px overflow-hidden rounded-tray bg-bone/[0.06] sm:grid-cols-3">
          {[
            ["You sign once", "Circle burns your USDC on the chain you send from."],
            ["Circle attests", "Once that chain finalises the burn, Circle signs for it."],
            ["Circle mints", "Native USDC lands at your recipient, usually within minutes."],
          ].map(([title, body], i) => (
            <li key={title} className="bg-obsidian/90 px-4 py-5">
              <span className="tabular text-xs text-bone/30">0{i + 1}</span>
              <h3 className="mt-2 text-[0.8125rem] font-medium tracking-[-0.01em] text-bone/80">
                {title}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-bone/40">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="routes-heading">
        <SectionHeading id="routes-heading" href="/routes" link="All routes">
          Where USDC can go
        </SectionHeading>
        <div className="mt-6 space-y-6">
          {sources.map((from) => (
            <div key={from}>
              <h3 className="text-eyebrow font-medium uppercase text-bone/40">
                From {ENDPOINT_NAMES[from]}
              </h3>
              <ul className="mt-3 flex flex-wrap gap-2">
                {routes
                  .filter((r) => r.from === from)
                  .map((r) => (
                    <li key={r.slug}>
                      <Link
                        href={`/bridge/${r.slug}`}
                        className="flex items-center gap-2 rounded-full bg-bone/[0.04] py-1.5 pl-1.5 pr-3 text-xs font-medium text-bone/70 ring-1 ring-inset ring-bone/10 transition-colors duration-400 ease-haptic hover:bg-bone/[0.08] hover:text-bone"
                        title={`Bridge USDC from ${ENDPOINT_NAMES[r.from]} to ${ENDPOINT_NAMES[r.to]}`}
                      >
                        <ChainGlyph chain={r.to as Chain} className="h-4 w-4" />
                        {ENDPOINT_NAMES[r.to]}
                      </Link>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="faq-heading">
        <SectionHeading id="faq-heading" href="/faq" link="All questions">
          Before you send
        </SectionHeading>
        <div className="mt-6 divide-y divide-bone/[0.06] rounded-tray bg-bone/[0.02] ring-1 ring-inset ring-bone/[0.06]">
          {faq.map((f) => (
            <details key={f.q} className="group px-4 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[0.8125rem] font-medium text-bone/80 [&::-webkit-details-marker]:hidden">
                <h3>{f.q}</h3>
                <span
                  aria-hidden="true"
                  className="text-bone/30 transition-transform duration-400 ease-haptic group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="mt-2 text-xs leading-relaxed text-bone/45">{stripMarkdown(f.a)}</p>
            </details>
          ))}
        </div>
      </section>

      <StripeRule className="opacity-40" />
    </div>
  );
}

function SectionHeading({
  id,
  href,
  link,
  children,
}: {
  id: string;
  href: string;
  link: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-1">
      <h2 id={id} className="text-title font-semibold text-bone">
        {children}
      </h2>
      <Link
        href={href}
        className="group/link flex shrink-0 items-center gap-1 text-xs font-medium text-bone/45 transition-colors duration-400 ease-haptic hover:text-bone"
      >
        {link}
        <ArrowRight className="h-3 w-3 transition-transform duration-400 ease-haptic group-hover/link:translate-x-0.5" />
      </Link>
    </div>
  );
}
