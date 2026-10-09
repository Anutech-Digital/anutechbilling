import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { sitemapFor } from "@/site/lib/site-split";

/**
 * /robots.txt — lets the public pages be crawled and indexed, while keeping the
 * authenticated app, the API, and the transactional flow out of the index. AI crawlers
 * (GPTBot, Google-Extended, PerplexityBot, ClaudeBot …) are NOT singled out — they follow
 * the "*" rules, so they may read the public pages and cite Anutech Digital / ResellerOS.
 *
 * R-520: `host` and `sitemap` point at the domain that was asked (anutech.in or
 * reselleros.anutech.in) — each domain has its own sitemap.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const h = await headers();
  const { origin } = sitemapFor(h.get("x-forwarded-host") ?? h.get("host"));
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/dev/",
          // the authenticated app
          "/dashboard",
          "/leads",
          "/customers",
          "/quotes",
          "/invoices",
          "/online-orders",
          "/setup",
          // auth
          "/login",
          "/signup",
          "/forgot-password",
          // transactional — nothing to rank, and often per-visitor
          "/cart",
          "/checkout",
          "/done",
        ],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
