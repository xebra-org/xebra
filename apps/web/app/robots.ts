import type { MetadataRoute } from "next";
import { AI_CRAWLERS } from "../lib/seo/crawlers";
import { IS_PRODUCTION_DEPLOYMENT, SITE_URL } from "../lib/site";

/** Never worth crawling: the operator console, server routes, and two pages with nothing to read. */
const PRIVATE = ["/admin", "/api/", "/recover", "/intent/"];

export default function robots(): MetadataRoute.Robots {
  // A preview or local build indexed under its own address would compete with the real site.
  if (!IS_PRODUCTION_DEPLOYMENT) return { rules: [{ userAgent: "*", disallow: "/" }] };
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: PRIVATE },
      { userAgent: AI_CRAWLERS, allow: "/", disallow: PRIVATE },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
