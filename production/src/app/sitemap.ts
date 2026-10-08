import type { MetadataRoute } from "next";
import { SITE_URL } from "@/site/lib/config";

/**
 * /sitemap.xml — the crawl map for Google and for AI crawlers (GPTBot,
 * Google-Extended, PerplexityBot …). Only the PUBLIC marketing pages are listed;
 * the authenticated app, the API, and the transactional cart/checkout flow are
 * left out (and blocked in robots.ts) — they carry nothing to rank and should
 * never surface in a search result or an AI answer.
 *
 * URLs are built from SITE_URL (anutech.in, the canonical origin), so the
 * sitemap agrees with every page's canonical link. `priority` ranks the money
 * pages above the policy pages; it's a hint, not a guarantee.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const page = (
    path: string,
    priority: number,
    changeFrequency: "weekly" | "monthly",
  ): MetadataRoute.Sitemap[number] => ({
    url: `${SITE_URL}${path}`,
    lastModified: now,
    changeFrequency,
    priority,
  });

  return [
    page("/", 1.0, "weekly"),
    // The money pages
    page("/domains", 0.9, "weekly"),
    page("/hosting", 0.9, "weekly"),
    page("/email", 0.9, "weekly"),
    page("/email/compare-editions", 0.7, "weekly"),
    page("/google-workspace/pricing", 0.9, "weekly"),
    page("/ssl", 0.7, "weekly"),
    // R-232: the online Workspace checkout and the rate card were missing from the map.
    page("/buy/workspace", 0.8, "weekly"),
    page("/rates", 0.6, "weekly"),
    // Reseller side
    page("/reselleros", 0.8, "weekly"),
    page("/reseller", 0.8, "weekly"),
    // Supporting
    page("/quote", 0.6, "monthly"),
    page("/why-us", 0.6, "monthly"),
    page("/contact", 0.5, "monthly"),
    page("/status", 0.3, "monthly"),
    page("/refund", 0.3, "monthly"),
  ];
}
