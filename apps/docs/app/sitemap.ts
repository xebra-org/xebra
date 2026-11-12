import { siteUrl } from "@/lib/shared";
import { source } from "@/lib/source";
import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return source.getPages().map((page) => ({
    url: new URL(page.url, siteUrl).toString(),
    changeFrequency: "weekly",
  }));
}
