import type { Metadata } from "next";

/**
 * Who the site is and where it lives, for search engines, link previews and AI assistants.
 *
 * The address is pinned here, not read from the environment, like every other mainnet constant
 * in this app: a canonical URL that a build setting could quietly change would point every page's
 * "this is the real one" at somewhere else. `xebra-sandy.vercel.app` and `www` redirect to it.
 */
export const SITE_URL = "https://xebra.exchange";
export const SITE_NAME = "Xebra";
export const SITE_TAGLINE = "native USDC between chains";
export const SITE_DESCRIPTION =
  "Move native USDC between Stellar, Solana, Arc and EVM chains over Circle's CCTP. Circle burns it on one chain and mints it on the other: no wrapped token, no pool, and nobody holds your funds.";
export const SOURCE_URL = "https://github.com/drydocs/xebra";
export const LOGO_PATH = "/icon-512.png";
/**
 * When the written pages last changed, for the sitemap and structured data. A date, not the build
 * time: a page that has not changed should not tell crawlers it has every deploy.
 */
export const CONTENT_UPDATED = "2026-10-15";

/** An absolute URL on this site. */
export function absoluteUrl(path: string): string {
  return new URL(path, SITE_URL).toString();
}

/**
 * Whether this build is the one people reach. Previews and local builds must not be indexed: a
 * preview of a half-finished page that ranks is a page nobody can correct.
 */
export const IS_PRODUCTION_DEPLOYMENT = process.env.VERCEL_ENV === "production";

/**
 * A page's metadata: its title, description, canonical address, and the link preview (Open Graph
 * and X) with its own image. Every indexable page goes through this, so none of them can forget the
 * canonical URL or ship a large-image card without the image.
 */
export function pageMetadata({
  title,
  description,
  path,
  image = "/og/home",
  markdownPath,
}: {
  /** The page's own title; the layout appends "· Xebra". Omit for the home page. */
  title?: string;
  description: string;
  path: string;
  image?: string;
  /** The page's Markdown copy, linked as an alternate for agents that prefer it. */
  markdownPath?: string;
}): Metadata {
  const fullTitle = title ? `${title} · ${SITE_NAME}` : `${SITE_NAME} — ${SITE_TAGLINE}`;
  const images = [{ url: image, width: 1200, height: 630, alt: fullTitle }];
  return {
    ...(title ? { title } : {}),
    description,
    alternates: {
      canonical: path,
      ...(markdownPath ? { types: { "text/markdown": markdownPath } } : {}),
    },
    openGraph: {
      title: fullTitle,
      description,
      url: path,
      siteName: SITE_NAME,
      type: "website",
      locale: "en_US",
      images,
    },
    twitter: { card: "summary_large_image", title: fullTitle, description, images: [image] },
  };
}
