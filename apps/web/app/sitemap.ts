import type { MetadataRoute } from "next";
import { getDocs } from "../lib/seo/live";
import { CONTENT_UPDATED, absoluteUrl } from "../lib/site";

/** Every written page and route page. Re-read hourly, as a Stellar route can go live between deploys. */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const docs = await getDocs();
  return docs.map((d) => ({
    url: absoluteUrl(d.path),
    lastModified: CONTENT_UPDATED,
    changeFrequency: d.section === "routes" ? "weekly" : "monthly",
    priority: d.path === "/" ? 1 : d.section === "routes" ? 0.7 : 0.8,
  }));
}
