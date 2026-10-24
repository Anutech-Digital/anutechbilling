/**
 * Ad-click attribution for landing pages (R-139, 4 Oct 2026).
 *
 * A Google Ads click lands with ?gclid=…&utm_*=… on the URL. The lead endpoints already store
 * those (lib/marketing/utm.ts → captureFromRequest), but only when they SEE them: from the
 * body's `pageUrl`, else the Referer. A visitor who scrolls, clicks "Buy now" and moves to
 * /buy/workspace loses the gclid from the URL, and the lead arrives as "direct".
 *
 * So the landing page remembers the FIRST ad URL of the visit (sessionStorage) and:
 *   • sends it as `pageUrl` with the form, and
 *   • carries the ad params onto the Buy link, so the checkout's Referer still holds them.
 * Pure helpers here; storage access is wrapped because private windows can refuse it.
 */

/** The query keys an ad platform or campaign adds. Everything else is ignored. */
export const AD_PARAM_KEYS = [
  "gclid", "wbraid", "gbraid", "fbclid",
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
] as const;

const STORE_KEY = "anutech.lp.landing.v1";

/** Only the ad keys from a query string, in a stable order. */
export function pickAdParams(search: string): URLSearchParams {
  const from = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out = new URLSearchParams();
  for (const k of AD_PARAM_KEYS) {
    const v = from.get(k);
    if (v && v.length <= 300) out.set(k, v);
  }
  return out;
}

/** Append the ad params to an internal href (keeps the href's own params). */
export function withAdParams(href: string, ad: URLSearchParams): string {
  if (![...ad.keys()].length) return href;
  const [path, query = ""] = href.split("?");
  const merged = new URLSearchParams(query);
  ad.forEach((v, k) => { if (!merged.has(k)) merged.set(k, v); });
  return `${path}?${merged.toString()}`;
}

/**
 * The URL to report as this visit's landing page: the stored first ad landing if there is
 * one, else the current URL. Stores the current URL when it carries ad params and nothing is
 * stored yet (first touch wins within a visit).
 */
export function rememberLanding(currentUrl: string, storage: Pick<Storage, "getItem" | "setItem"> | null): string {
  let stored: string | null = null;
  try { stored = storage?.getItem(STORE_KEY) ?? null; } catch { stored = null; }
  if (stored) return stored;
  const q = currentUrl.includes("?") ? currentUrl.slice(currentUrl.indexOf("?")) : "";
  if ([...pickAdParams(q).keys()].length) {
    try { storage?.setItem(STORE_KEY, currentUrl); } catch { /* private window: send the current URL */ }
  }
  return currentUrl;
}

/**
 * R-1598: the attribution fields a site form sends with its enquiry — the visit's landing URL
 * (first ad URL, with gclid/utm_*) as `pageUrl`, and where the visitor came from as
 * `pageReferrer`. Browser-only; on the server (no window) it returns nothing.
 */
export function landingForForm(): { pageUrl?: string; pageReferrer?: string } {
  if (typeof window === "undefined") return {};
  let store: Storage | null = null;
  try { store = window.sessionStorage; } catch { store = null; }
  const pageUrl = rememberLanding(window.location.href, store);
  const pageReferrer = typeof document !== "undefined" && document.referrer ? document.referrer : undefined;
  return pageReferrer ? { pageUrl, pageReferrer } : { pageUrl };
}
