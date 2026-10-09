import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { sitemapFor } from "@/site/lib/site-split";

/**
 * /sitemap.xml — one per domain (R-520, 9 Oct 2026). The same service answers for
 * anutech.in (company pages) and reselleros.anutech.in (ResellerOS pages), so the list is
 * picked from the Host header; both lists and their origins live in site/lib/site-split.ts.
 *
 * Only PUBLIC pages are listed; the app, the API and the transactional cart/checkout flow
 * are left out (and blocked in robots.ts). Every URL is on the origin that serves the page
 * without a redirect, so it agrees with that page's canonical link.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const h = await headers();
  const { origin, pages } = sitemapFor(h.get("x-forwarded-host") ?? h.get("host"));
  const now = new Date();
  return pages.map((p) => ({
    url: `${origin}${p.path}`,
    lastModified: now,
    changeFrequency: p.changeFrequency,
    priority: p.priority,
  }));
}
