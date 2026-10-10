/**
 * R-520 (owner decision R-466, 9 Oct 2026): two sites, one Next.js service.
 *
 *   anutech.in             = the company — custom software, domains, hosting, email, SSL, quotes
 *   reselleros.anutech.in  = ResellerOS only — product homepage, pricing, login, the app
 *
 * Measured 9 Oct before this change: BOTH hosts are served by the same Cloud Run service
 * (same /api/version sha), so the split is decided here, per request, from the Host header —
 * no Cloudflare rule and no second service needed.
 *
 * THIS FILE IS THE ONE PLACE TO CHANGE IT. Every old path → new URL lives in the two maps
 * below; middleware.ts, sitemap.ts and robots.ts only read them.
 *
 * How it can break, and what this file does about it (failure cases first):
 * - Redirect loop between the two hosts → a path is never in both maps (site-split.test.ts).
 * - Payment callback or form POST lands on a redirect and loses its body → only GET/HEAD are
 *   redirected; every other method is served where it landed.
 * - A buyer mid-checkout on the old host loses the cart (cart lives in that origin's storage)
 *   → the transactional pages (/cart, /checkout, /done, /buy/…) are NOT redirected; they are
 *   served on both hosts and kept out of both sitemaps (robots blocks them).
 * - Webhooks / API / app screens / sign-in must never move → only listed paths move;
 *   anything not listed is served as before.
 * - Local dev, staging (the Cloud Run host) and tests have other hosts → no redirect at all there, so
 *   every page stays reachable at its path. Product homepage on those hosts: /reselleros.
 */

export const COMPANY_ORIGIN = "https://anutech.in";
export const PRODUCT_ORIGIN = "https://reselleros.anutech.in";

export const COMPANY_HOSTS: readonly string[] = ["anutech.in", "www.anutech.in"];
export const PRODUCT_HOSTS: readonly string[] = ["reselleros.anutech.in"];

/** The route that renders the ResellerOS homepage. On the product host it is served at "/". */
export const PRODUCT_HOME_ROUTE = "/reselleros";

export type SiteKind = "company" | "product" | "other";

export interface MovedPath {
  /** Old path on the host that no longer carries it. */
  from: string;
  /** Absolute new URL. */
  to: string;
  /** Also move everything under `from/` (sub-path is appended to `to`). */
  prefix?: boolean;
}

/**
 * Company pages: requested on reselleros.anutech.in → 301 to anutech.in.
 * Order does not matter; the longest matching `from` wins.
 */
export const COMPANY_PATHS: readonly MovedPath[] = [
  { from: "/domains", to: `${COMPANY_ORIGIN}/domains`, prefix: true },
  { from: "/hosting", to: `${COMPANY_ORIGIN}/hosting`, prefix: true },
  { from: "/email", to: `${COMPANY_ORIGIN}/email`, prefix: true },
  { from: "/google-workspace", to: `${COMPANY_ORIGIN}/google-workspace`, prefix: true },
  { from: "/ssl", to: `${COMPANY_ORIGIN}/ssl` },
  { from: "/rates", to: `${COMPANY_ORIGIN}/rates` },
  { from: "/reseller", to: `${COMPANY_ORIGIN}/reseller` },
  { from: "/why-us", to: `${COMPANY_ORIGIN}/why-us` },
  { from: "/quote", to: `${COMPANY_ORIGIN}/quote` },
  { from: "/contact", to: `${COMPANY_ORIGIN}/contact` },
  { from: "/status", to: `${COMPANY_ORIGIN}/status` },
  { from: "/trial", to: `${COMPANY_ORIGIN}/trial` },
  { from: "/privacy-policy", to: `${COMPANY_ORIGIN}/privacy-policy` },
  { from: "/terms-and-conditions", to: `${COMPANY_ORIGIN}/terms-and-conditions` },
  { from: "/refund", to: `${COMPANY_ORIGIN}/refund` },
  { from: "/lp", to: `${COMPANY_ORIGIN}/lp`, prefix: true },
];

/** ResellerOS pages: requested on anutech.in → 301 to reselleros.anutech.in. */
export const PRODUCT_PATHS: readonly MovedPath[] = [
  { from: "/reselleros", to: `${PRODUCT_ORIGIN}/` },
  { from: "/pricing", to: `${PRODUCT_ORIGIN}/pricing` },
  { from: "/about", to: `${PRODUCT_ORIGIN}/about` },
];

/**
 * Served on BOTH hosts, never redirected (see failure cases above). Listed so the test can
 * prove no map ever claims them.
 */
export const SERVED_ON_BOTH: readonly string[] = [
  "/cart", "/checkout", "/done", "/buy", "/api",
  // the app's own public links: tenant quote links, the embeddable enquiry form
  "/quote/view", "/quote/[id]/accept", "/enquiry",
];

export function siteKindForHost(rawHost: string | null | undefined): SiteKind {
  const host = (rawHost ?? "").split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
  if (COMPANY_HOSTS.includes(host)) return "company";
  if (PRODUCT_HOSTS.includes(host)) return "product";
  return "other";
}

function matches(path: string, m: MovedPath): boolean {
  if (path === m.from) return true;
  return !!m.prefix && path.startsWith(`${m.from}/`);
}

/** Longest matching entry → the new absolute URL (sub-path kept for prefix entries). */
export function lookupMoved(map: readonly MovedPath[], path: string): string | null {
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  let best: MovedPath | null = null;
  for (const m of map) {
    if (matches(clean, m) && (!best || m.from.length > best.from.length)) best = m;
  }
  if (!best) return null;
  return clean === best.from ? best.to : best.to + clean.slice(best.from.length);
}

export type SiteDecision =
  | { action: "serve" }
  | { action: "redirect"; location: string }
  | { action: "rewrite"; pathname: string };

/**
 * What to do with one request. Pure — middleware.ts calls it; site-split.test.ts pins it.
 * `search` is the raw query string ("?a=1" or ""), carried onto every redirect so UTM and
 * ad-click ids survive the move.
 */
export function decideSite(
  host: string | null | undefined,
  pathname: string,
  search: string,
  method: string,
): SiteDecision {
  const kind = siteKindForHost(host);
  if (kind === "other") return { action: "serve" };

  if (kind === "product" && pathname === "/") return { action: "rewrite", pathname: PRODUCT_HOME_ROUTE };

  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") return { action: "serve" };

  const target =
    kind === "product"
      ? (pathname === PRODUCT_HOME_ROUTE || pathname === `${PRODUCT_HOME_ROUTE}/`)
        ? `${PRODUCT_ORIGIN}/`
        : lookupMoved(COMPANY_PATHS, pathname)
      : lookupMoved(PRODUCT_PATHS, pathname);

  if (!target) return { action: "serve" };
  return { action: "redirect", location: target + (search && search !== "?" ? search : "") };
}

/* ── Sitemaps: one list per host ──────────────────────────────────────────── */

export interface SitemapPage {
  path: string;
  priority: number;
  changeFrequency: "weekly" | "monthly";
}

/** anutech.in — the company's public pages. */
export const COMPANY_SITEMAP: readonly SitemapPage[] = [
  { path: "/", priority: 1.0, changeFrequency: "weekly" },
  { path: "/domains", priority: 0.9, changeFrequency: "weekly" },
  { path: "/hosting", priority: 0.9, changeFrequency: "weekly" },
  { path: "/email", priority: 0.9, changeFrequency: "weekly" },
  { path: "/email/compare-editions", priority: 0.7, changeFrequency: "weekly" },
  { path: "/google-workspace/pricing", priority: 0.9, changeFrequency: "weekly" },
  { path: "/ssl", priority: 0.7, changeFrequency: "weekly" },
  // R-232: the online Workspace checkout and the rate card.
  { path: "/buy/workspace", priority: 0.8, changeFrequency: "weekly" },
  { path: "/rates", priority: 0.6, changeFrequency: "weekly" },
  { path: "/reseller", priority: 0.8, changeFrequency: "weekly" },
  { path: "/quote", priority: 0.6, changeFrequency: "monthly" },
  { path: "/why-us", priority: 0.6, changeFrequency: "monthly" },
  { path: "/contact", priority: 0.5, changeFrequency: "monthly" },
  { path: "/status", priority: 0.3, changeFrequency: "monthly" },
  { path: "/refund", priority: 0.3, changeFrequency: "monthly" },
  { path: "/privacy-policy", priority: 0.3, changeFrequency: "monthly" },
  { path: "/terms-and-conditions", priority: 0.3, changeFrequency: "monthly" },
];

/** reselleros.anutech.in — the product's public pages. */
export const PRODUCT_SITEMAP: readonly SitemapPage[] = [
  { path: "/", priority: 1.0, changeFrequency: "weekly" },
  { path: "/pricing", priority: 0.8, changeFrequency: "weekly" },
  { path: "/about", priority: 0.5, changeFrequency: "monthly" },
  { path: "/privacy", priority: 0.3, changeFrequency: "monthly" },
  { path: "/terms", priority: 0.3, changeFrequency: "monthly" },
];

/** Origin + page list for the sitemap/robots served on `host`. Other hosts get the product's. */
export function sitemapFor(host: string | null | undefined): { origin: string; pages: readonly SitemapPage[] } {
  return siteKindForHost(host) === "company"
    ? { origin: COMPANY_ORIGIN, pages: COMPANY_SITEMAP }
    : { origin: PRODUCT_ORIGIN, pages: PRODUCT_SITEMAP };
}
