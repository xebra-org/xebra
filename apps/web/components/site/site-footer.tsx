import { cn } from "../ui/cn";
import { ArrowUpRight } from "../ui/icons";
import { StripeRule } from "../ui/stripe-rule";
import { NavLinks } from "./site-nav";

/**
 * Every link here resolves to something real. A footer of `href="#"` placeholders is worse
 * than no footer: on a page that moves money, a dead "how this works" link is the moment a
 * user decides the rest of the screen might be decorative too.
 */
export function SiteFooter({
  wrapperContractId,
  contractLabel = "Contract",
  wide = false,
}: {
  wrapperContractId: string | null;
  /** The written pages run wider than the bridge, and the footer lines up with them. */
  wide?: boolean;
  /**
   * The wrapper is the Stellar route's contract only. Where other routes are offered, the link
   * says so, because those call Circle directly and have no contract of ours to point at.
   */
  contractLabel?: string;
}) {
  return (
    <footer className={cn("mx-auto w-full px-1 pb-14 pt-20", wide ? "max-w-2xl" : "max-w-xl")}>
      <StripeRule />
      <nav aria-label="Pages" className="mt-6">
        <NavLinks />
      </nav>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
        <p className="max-w-[26rem] text-xs leading-relaxed text-bone/40">
          Xebra moves native USDC over Circle&apos;s Cross-Chain Transfer Protocol. It never issues
          a wrapped asset and never takes custody of your funds.
        </p>
        <ul className="flex items-center gap-5">
          <FooterLink href="https://developers.circle.com/stablecoins/cctp-getting-started">
            CCTP
          </FooterLink>
          {wrapperContractId && (
            <FooterLink
              href={`https://stellar.expert/explorer/public/contract/${wrapperContractId}`}
            >
              {contractLabel}
            </FooterLink>
          )}
          <FooterLink href="https://github.com/drydocs/xebra">Source</FooterLink>
        </ul>
      </div>
    </footer>
  );
}

function FooterLink({ href, children }: { href: string; children: string }) {
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className={cn(
          "group/link flex items-center gap-1 text-xs font-medium text-bone/45",
          "transition-colors duration-400 ease-haptic hover:text-bone",
        )}
      >
        {children}
        <ArrowUpRight className="h-3 w-3 transition-transform duration-400 ease-haptic group-hover/link:-translate-y-px group-hover/link:translate-x-px" />
      </a>
    </li>
  );
}
