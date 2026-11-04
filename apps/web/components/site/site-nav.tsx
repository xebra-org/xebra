import Link from "next/link";
import { XebraWordmark } from "../brand/xebra-mark";
import { cn } from "../ui/cn";
import { ArrowRight } from "../ui/icons";

/** The written pages, in the order a newcomer would read them. */
export const SITE_NAV = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/routes", label: "Routes" },
  { href: "/fees", label: "Fees" },
  { href: "/security", label: "Security" },
  { href: "/faq", label: "FAQ" },
] as const;

/**
 * The header on the written pages: the same floating pill as the bridge's, without the wallet
 * (nothing here signs anything), with the pages and a way back to the bridge instead.
 */
export function ContentHeader({ current }: { current?: string }) {
  return (
    <header className="sticky top-4 z-30 mx-auto w-full max-w-2xl px-1 sm:top-6">
      <nav
        aria-label="Site"
        className={cn(
          "flex items-center justify-between gap-3 rounded-full py-2 pl-4 pr-2",
          "bg-obsidian-raised/70 ring-1 ring-inset ring-bone/10 backdrop-blur-2xl",
          "shadow-[0_1px_0_0_hsl(var(--bone)/0.07)_inset,0_16px_40px_-24px_hsl(228_40%_2%/0.9)]",
        )}
      >
        <Link href="/" aria-label="Xebra, the bridge">
          <XebraWordmark />
        </Link>
        <ul className="hidden items-center gap-5 md:flex">
          {SITE_NAV.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current === item.href ? "page" : undefined}
                className={cn(
                  "text-[0.8125rem] font-medium transition-colors duration-400 ease-haptic",
                  current === item.href ? "text-bone" : "text-bone/50 hover:text-bone",
                )}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
        <Link
          href="/#bridge"
          className={cn(
            "flex h-9 items-center gap-2 rounded-full bg-bone px-4 text-[0.8125rem] font-medium",
            "text-obsidian shadow-pill transition-colors duration-400 ease-haptic hover:bg-white",
          )}
        >
          Open the bridge
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </nav>
    </header>
  );
}

/** The pages again, as a plain row of links, for the footer and for small screens. */
export function NavLinks({ className }: { className?: string }) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-5 gap-y-2", className)}>
      {SITE_NAV.map((item) => (
        <li key={item.href}>
          <Link
            href={item.href}
            className="text-xs font-medium text-bone/45 transition-colors duration-400 ease-haptic hover:text-bone"
          >
            {item.label}
          </Link>
        </li>
      ))}
      <li>
        <Link
          href="/claim"
          className="text-xs font-medium text-bone/45 transition-colors duration-400 ease-haptic hover:text-bone"
        >
          Claim a transfer
        </Link>
      </li>
    </ul>
  );
}
