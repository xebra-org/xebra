import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type React from "react";
import { AmbientBackground } from "../components/site/ambient-background";
import { env } from "../lib/env";
import { hasEvmRoutes } from "../lib/evm-chains";
import { JsonLd, organizationLd, websiteLd } from "../lib/seo/json-ld";
import { IS_PRODUCTION_DEPLOYMENT, SITE_NAME, SITE_URL, SOURCE_URL } from "../lib/site";
import { Providers } from "./providers";
import "./globals.css";

/**
 * # Why the typefaces are local files and not `next/font/google`
 *
 * `next/font/google` fetches the font at *build* time. This app's production build runs on
 * Vercel and in CI, and a build that silently depends on fonts.gstatic.com being reachable is a
 * build that fails on the day it is not. The two latin subsets are 52 KB committed to the repo,
 * self-hosted from our own origin, and cannot be broken by someone else's outage.
 *
 * Geist is a variable font across 100-900, so weight is free: the interface uses 400, 500,
 * 600 and 700 for hierarchy rather than the regular/bold pair that makes a design read as
 * two-tone.
 */
const geist = localFont({
  src: "./fonts/geist-variable.woff2",
  variable: "--font-geist",
  weight: "100 900",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/geist-mono-variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

// What the site says it does follows what this build offers: Stellar's routes alone, or those
// and the routes that start on Arc or another EVM chain. Inlined at build time, like the flags.
const MANY_ROUTES = hasEvmRoutes(env.evmRoutes);
// Which further chains Stellar reaches is decided by the contract at run time, so a build that
// names any only promises "other chains".
const STELLAR_DESTINATIONS =
  env.stellarSendsTo.length > 0 ? "other chains" : env.arcEnabled ? "Solana or Arc" : "Solana";
const TITLE = MANY_ROUTES
  ? "Xebra — native USDC between chains"
  : `Xebra — USDC from Stellar to ${STELLAR_DESTINATIONS}`;
const DESCRIPTION = MANY_ROUTES
  ? "Move native USDC between Stellar, Solana, Arc and other chains over Circle's CCTP. No wrapped assets, no custody."
  : `Move native USDC from Stellar to ${STELLAR_DESTINATIONS} over Circle's CCTP. One signature, no wrapped assets, no custody.`;

export const metadata: Metadata = {
  // Every relative URL in metadata (canonical, Open Graph, images) resolves against the real site,
  // whichever address served the page.
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: "%s · Xebra" },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  category: "finance",
  creator: SITE_NAME,
  authors: [{ name: SITE_NAME, url: SOURCE_URL }],
  // Previews and local builds are never indexed; see `app/robots.ts`.
  robots: IS_PRODUCTION_DEPLOYMENT
    ? {
        index: true,
        follow: true,
        googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
      }
    : { index: false, follow: false },
  // Served from `public/` rather than as `app/icon.*` convention files: Next's static metadata
  // handler tries to register that path as a route and fails page-data collection for it at
  // build time.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: SITE_NAME,
    type: "website",
    locale: "en_US",
    url: "/",
    images: [{ url: "/og/home", width: 1200, height: 630, alt: TITLE }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: MANY_ROUTES
      ? "Native USDC between chains, over Circle's CCTP."
      : `Native USDC, Stellar to ${STELLAR_DESTINATIONS}, over Circle's CCTP.`,
    images: ["/og/home"],
  },
};

export const viewport: Viewport = {
  // Matches --obsidian, so the mobile browser chrome continues the page instead of framing it.
  themeColor: "#0a0b0e",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body className="grain min-h-[100dvh] bg-obsidian font-sans text-bone antialiased">
        {/* Keyboard users should not have to tab the wallet control to reach the amount. */}
        <a
          href="#bridge"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-bone focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-obsidian"
        >
          Skip to the bridge
        </a>
        <AmbientBackground />
        <Providers>{children}</Providers>
        <JsonLd data={[organizationLd(), websiteLd()]} />
        {/* Entry animations start hidden in the server-rendered markup so the page does not
            flash on load (see components/ui/reveal.tsx). Without JavaScript nothing would
            ever reveal them, so without JavaScript they are simply never hidden. */}
        <noscript>
          <style>
            {"[data-reveal]{opacity:1!important;transform:none!important;filter:none!important}"}
          </style>
        </noscript>
      </body>
    </html>
  );
}
