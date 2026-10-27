/**
 * UTM capture and channel attribution for inbound leads.
 *
 * Four public routes create leads today and each hardcodes a `source` string:
 *   /api/public/enquiry/general    → "enquiry-form"
 *   /api/public/enquiry/workspace  → "buy-workspace"
 *   /api/public/trial/workspace    → "buy-workspace-trial"
 *   /api/public/checkout/workspace → a dynamic tag
 * That tells you which FORM was used. It says nothing about which ad, post or
 * search brought the person to it. This module fills that gap.
 *
 * ─── TWO PRIVACY DECISIONS, MADE DELIBERATELY ────────────────────────────────
 *
 * 1. The landing page is stored as PATH + utm params only. Everything else in
 *    the query string is dropped. Real landing URLs routinely carry `?email=`,
 *    `?phone=`, `?token=` or a session id, and storing the raw query string
 *    would copy that into a marketing table where nobody expects personal data
 *    to live — a DPDP problem created by an analytics feature.
 *
 * 2. The referrer is stored as origin + path, query string removed. A referrer
 *    query string leaks the visitor's search terms and, from some apps, an
 *    access token.
 *
 * Neither reduces attribution quality: the channel is in the host and the utm
 * params, never in the rest of the query.
 *
 * ─── THE SELF-REFERRAL TRAP ──────────────────────────────────────────────────
 * If the referrer host is our own site, the visitor navigated internally — they
 * did not arrive from anywhere. Recording that as a referral is the classic
 * attribution bug that makes your own domain the top-performing channel.
 */

/** Longest value stored per field. UTM params are attacker-controlled. */
const MAX_PARAM = 120;
const MAX_URL = 400;

export interface UtmCapture {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  /** R-1978: which ad / creative (Meta: the ad) and the keyword — utm_content / utm_term. */
  utm_content: string | null;
  utm_term: string | null;
  referrer_url: string | null;
  landing_page_url: string | null;
  /**
   * Ad-platform click ids, captured from the landing URL.
   *
   * WHY THESE MATTER MORE THAN THE UTM PARAMS. Offline conversion import --
   * telling Google or Meta that a click eventually became a paid deal, so their
   * bidding can learn from it -- requires sending the ORIGINAL click id back.
   * You cannot send back an id you never stored. Every inbound lead that arrives
   * without these captured is permanently un-attributable, no matter what
   * credentials arrive later. That is why this is captured before any API
   * integration exists: the approval process takes weeks, and the data lost in
   * the meantime does not come back.
   *
   * gclid  -- Google Ads click id
   * wbraid -- Googles cookieless equivalent, sent when consent limits gclid
   * fbclid -- Meta click id
   */
  gclid: string | null;
  wbraid: string | null;
  fbclid: string | null;
}

export const EMPTY_UTM: UtmCapture = {
  utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null,
  referrer_url: null, landing_page_url: null,
  gclid: null, wbraid: null, fbclid: null,
};

function clean(v: string | null | undefined, max: number): string | null {
  if (typeof v !== "string") return null;
  // Strip control characters — they serve no purpose in a UTM value and make
  // log lines and CSV exports unparseable.
  // NO regex character class here, on purpose. Writing this as a class of
  // literal control characters put a NUL byte in the file and turned it binary;
  // the repair pass then left [-], which silently stripped HYPHENS instead --
  // that would have folded google-ads into googleads and split one channel in two.
  // A codepoint filter cannot be mangled by either mistake.
  const s = Array.from(v)
    .filter((ch) => { const c = ch.codePointAt(0) ?? 0; return c >= 0x20 && c !== 0x7f; })
    .join("")
    .trim()
    .slice(0, max);
  return s.length > 0 ? s : null;
}

function safeUrl(raw: string | null | undefined): URL | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    return new URL(raw.trim());
  } catch {
    return null;
  }
}

/**
 * Capture attribution fields from the landing URL and the referrer.
 *
 * @param input.url      The full landing URL the visitor hit.
 * @param input.referrer The `Referer` header, if any.
 * @param input.selfHosts Hostnames that are US. A referrer from one of these is
 *        internal navigation, not a referral, and is discarded.
 */
export function captureUtm(input: {
  url?: string | null;
  referrer?: string | null;
  selfHosts?: readonly string[];
}): UtmCapture {
  const landing = safeUrl(input.url);
  const referrer = safeUrl(input.referrer);
  const selfHosts = (input.selfHosts ?? []).map((h) => h.toLowerCase());

  const p = landing?.searchParams;
  const utm_source   = clean(p?.get("utm_source"),   MAX_PARAM);
  const utm_medium   = clean(p?.get("utm_medium"),   MAX_PARAM);
  const utm_campaign = clean(p?.get("utm_campaign"), MAX_PARAM);
  const utm_content  = clean(p?.get("utm_content"),  MAX_PARAM);
  const utm_term     = clean(p?.get("utm_term"),     MAX_PARAM);

  // Landing page: origin + path, plus ONLY the utm params. See decision 1.
  let landing_page_url: string | null = null;
  if (landing) {
    const kept = new URLSearchParams();
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
      const v = clean(landing.searchParams.get(key), MAX_PARAM);
      if (v) kept.set(key, v);
    }
    const qs = kept.toString();
    landing_page_url = clean(
      `${landing.origin}${landing.pathname}${qs ? `?${qs}` : ""}`,
      MAX_URL
    );
  }

  // Referrer: origin + path, query dropped. See decision 2. Self-referrals are
  // discarded entirely — see the trap note above.
  let referrer_url: string | null = null;
  if (referrer && !selfHosts.includes(referrer.hostname.toLowerCase())) {
    referrer_url = clean(`${referrer.origin}${referrer.pathname}`, MAX_URL);
  }

  return {
    utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer_url, landing_page_url,
    // Click ids are read from the landing URL only. They are opaque platform
    // identifiers, not personal data, so they are kept in full.
    gclid:  clean(p?.get("gclid"),  MAX_PARAM),
    wbraid: clean(p?.get("wbraid"), MAX_PARAM),
    fbclid: clean(p?.get("fbclid"), MAX_PARAM),
  };
}

/**
 * Known host → channel. Deliberately short: a long guessing table produces
 * confident wrong attribution, and `channelFor` falls back to the bare host,
 * which is honest and still groups correctly.
 */
const HOST_CHANNEL: ReadonlyArray<[RegExp, string]> = [
  [/(^|\.)google\./,                    "google-organic"],
  [/(^|\.)bing\./,                       "bing-organic"],
  [/(^|\.)duckduckgo\./,                 "duckduckgo-organic"],
  [/(^|\.)(facebook|fb)\./,              "meta-organic"],
  [/(^|\.)instagram\./,                  "meta-organic"],
  [/(^|\.)linkedin\./,                   "linkedin-organic"],
  [/(^|\.)(twitter|x)\.com$/,            "twitter-organic"],
  [/(^|\.)(youtube|youtu)\./,            "youtube-organic"],
  [/(^|\.)(whatsapp|wa\.me)/,            "whatsapp"],
  [/(^|\.)t\.me$/,                       "telegram"],
];

/** utm_source values that mean paid, mapped to the channel keys spend uses. */
const SOURCE_CHANNEL: Readonly<Record<string, string>> = {
  google: "google-ads",
  googleads: "google-ads",
  "google-ads": "google-ads",
  adwords: "google-ads",
  facebook: "meta-ads",
  fb: "meta-ads",
  meta: "meta-ads",
  instagram: "meta-ads",
  ig: "meta-ads",
  linkedin: "linkedin-ads",
  whatsapp: "whatsapp",
  email: "email-outreach",
  newsletter: "email-outreach",
};

/**
 * The channel to attribute this lead to.
 *
 * Precedence, most trustworthy first:
 *   1. `utm_source` — the marketer tagged it deliberately
 *   2. the referrer host — where they actually came from
 *   3. the form's own `source` tag — which form they filled in
 *   4. "unknown"
 *
 * A `utm_medium` of `cpc`/`paid` upgrades an organic host mapping to its paid
 * equivalent, because "came from Google" and "came from a Google ad we paid for"
 * must not share a row when one of them has a CAC.
 */
export function channelFor(utm: UtmCapture, formSource?: string | null): string {
  const medium = (utm.utm_medium ?? "").toLowerCase();
  const paid = /^(cpc|ppc|paid|paid[-_]?social|display|banner)$/.test(medium);

  const src = (utm.utm_source ?? "").toLowerCase().replace(/[\s_]+/g, "-");
  if (src) {
    const mapped = SOURCE_CHANNEL[src] ?? SOURCE_CHANNEL[src.replace(/-/g, "")];
    if (mapped) return mapped;
    // An untagged-but-present source is still better than a guess: keep it.
    return src;
  }

  const refHost = safeUrl(utm.referrer_url)?.hostname.toLowerCase();
  if (refHost) {
    for (const [re, channel] of HOST_CHANNEL) {
      if (re.test(refHost)) {
        if (!paid) return channel;
        // Upgrade organic → paid where a paid twin exists.
        return channel
          .replace("google-organic", "google-ads")
          .replace("meta-organic", "meta-ads")
          .replace("linkedin-organic", "linkedin-ads");
      }
    }
    // Unknown host — return it as-is. Grouping by host is honest; inventing a
    // channel name is not.
    return refHost.replace(/^www\./, "");
  }

  const form = clean(formSource, MAX_PARAM);
  return form ? form.toLowerCase() : "unknown";
}

/**
 * Capture attribution from an incoming request on a public lead-creating route.
 *
 * ─── WHY THE REFERER HEADER IS THE LANDING PAGE HERE ─────────────────────────
 * A route handler's own `request.url` is `/api/public/enquiry/general` — useless
 * for attribution. But for a same-origin form POST the `Referer` header is the
 * page the form was submitted FROM, which is exactly the landing page, complete
 * with its `?utm_source=...` query. So utm capture works today with no change to
 * any form.
 *
 * The one thing the server cannot see is where the visitor came from BEFORE
 * landing — only the browser knows that, via `document.referrer`. A form may
 * send it as `pageReferrer` and it will be used; when absent, `referrer_url`
 * stays null rather than being filled with our own page, which would make this
 * site its own top-performing channel.
 *
 * @param selfHosts Every hostname that is us — apex, www, and any staging host.
 *        Matching is exact (see utm.test.ts), so a missing variant lets internal
 *        navigation through as a channel.
 */
export function captureFromRequest(
  request: { url: string; headers: { get(name: string): string | null } },
  body?: { pageUrl?: unknown; pageReferrer?: unknown },
  selfHosts?: readonly string[],
): UtmCapture {
  const referer = request.headers.get("referer") ?? request.headers.get("referrer");

  // A client-supplied page URL wins — it is the only source that survives a
  // referrer-policy header stripping the Referer.
  const pageUrl = typeof body?.pageUrl === "string" ? body.pageUrl : referer;

  const hosts = selfHosts ?? defaultSelfHosts(request.url);

  return captureUtm({
    url: pageUrl,
    referrer: typeof body?.pageReferrer === "string" ? body.pageReferrer : null,
    selfHosts: hosts,
  });
}

/**
 * Our own hostnames, derived from the request when the caller does not supply a
 * list. Includes the apex/www pair so a referrer from either form is recognised
 * as internal.
 */
export function defaultSelfHosts(requestUrl: string): string[] {
  const u = safeUrl(requestUrl);
  if (!u) return [];
  const h = u.hostname.toLowerCase();
  const bare = h.replace(/^www\./, "");
  return [...new Set([h, bare, `www.${bare}`, "localhost", "127.0.0.1"])];
}
