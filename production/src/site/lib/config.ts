/**
 * Every external address in ONE place.
 *
 * The handoff hardcoded the ResellerOS links to the numeric ALIAS Cloud Run URL (the one
 * Scheduler calls), not the canonical service — and a third, dead service URL also exists.
 * The app's repo has already paid for scattered URLs once: six files carried the dead
 * service's address. So the base URL is written exactly once here, overridable per
 * environment — and site-invariants.test.ts fails if any other file carries a run.app URL,
 * the alias's number, or the dead service's number. (The numbers are deliberately not
 * written in this comment: that same test reads every file, including this one.)
 */
export const RESELLEROS_URL =
  process.env.NEXT_PUBLIC_RESELLEROS_URL?.trim() ||
  // Use the STABLE domain, not the Cloud Run URL — the run.app host changes when
  // the service moves region (asia-south1 → asia-southeast1 on 5 Sep 2026), but
  // the custom domain is bound to whichever service is live. So live-price + enquiry
  // self-calls, signup and demo links follow the domain and never break on a move.
  "https://reselleros.anutech.in";

/**
 * The COMPANY site's canonical origin — anutech.in (R-520, 9 Oct 2026: Pardeep split the
 * sites; anutech.in = company, reselleros.anutech.in = ResellerOS only. Before that, 7 Sep,
 * the company pages lived on the product subdomain and canonical pointed there).
 * Every canonical link, OpenGraph URL and JSON-LD @id on the company pages uses this.
 * The per-domain maps (redirects, sitemaps) are site/lib/site-split.ts. Override per
 * environment with NEXT_PUBLIC_SITE_URL. No trailing slash. (Distinct from RESELLEROS_URL,
 * the app/product, and DOMAINS_APP_URL, the domains/hosting platform.)
 */
export const SITE_URL =
  (process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://anutech.in").replace(/\/+$/, "");

/**
 * The domains + hosting platform (app.anutech.in / DMS). Merge Phase-1: the
 * marketing site's domain search + rate card read REAL answers from its
 * public read-APIs instead of the old fakes. Custom domain (not a run.app
 * host) so site-invariants stays happy; override per environment.
 */
export const DOMAINS_APP_URL =
  process.env.NEXT_PUBLIC_DOMAINS_APP_URL?.trim() ||
  "https://app.anutech.in";

/** Real domain availability + customer price (see the app's /api/public/domain-availability). */
export const DOMAIN_AVAILABILITY_API = `${DOMAINS_APP_URL}/api/public/domain-availability`;
/** Real per-TLD register/renew/transfer rate card. */
export const TLD_PRICING_API = `${DOMAINS_APP_URL}/api/public/tld-pricing`;

export const OS_SIGNUP = `${RESELLEROS_URL}/signup`;

/**
 * The handoff's "Explore the interactive demo" pointed at `/dashboard?preview=1` — a route
 * that DOES NOT EXIST in the app (checked 31 Aug 2026: no preview handling anywhere under
 * src/app/(app)/dashboard). Until a real demo mode ships, the demo CTA goes to the login
 * page, which carries the dev demo list. Building a public preview mode is an app-side task.
 */
export const OS_DEMO = `${RESELLEROS_URL}/login`;

/** Where the website's quote form posts — the app's public lead-capture API. */
export const ENQUIRY_API = `${RESELLEROS_URL}/api/public/enquiry/general`;

/**
 * The AUTO-QUOTE path for Google Workspace enquiries: this one creates the lead AND a
 * catalog-priced draft quotation (tier + seats + billing), alerts the operator with a
 * deep-link to it, and acknowledges the customer. The proxy routes GW editions here and
 * everything else to the general endpoint.
 */
export const ENQUIRY_WORKSPACE_API = `${RESELLEROS_URL}/api/public/enquiry/workspace`;

/**
 * Anutech's WhatsApp / call number (R-078, 4 Oct 2026: Pardeep — "9999930300", from his
 * Google Workspace landing-page brief). Every wa.me link on the site is built from it.
 * Until today this was the handoff's placeholder 919800000000, a dead button.
 */
export const WHATSAPP_NUMBER: string = "919999930300";
export const WHATSAPP_URL = `https://wa.me/${WHATSAPP_NUMBER}`;

/** The fake number above. While WHATSAPP_NUMBER still equals it, a page that must not
    show a dead button to a paying customer (the /buy/workspace thanks page) hides its
    WhatsApp and call links and offers COMPANY.supportEmail instead. */
export const WHATSAPP_PLACEHOLDER = "919800000000";
export const WHATSAPP_READY: boolean = WHATSAPP_NUMBER !== WHATSAPP_PLACEHOLDER;

/**
 * Where a customer manages what they bought: the DMS customer panel's sign-in (30 Sep 2026).
 * The site's footer and menu said "Client area" and opened /dashboard, which is the STAFF app.
 * Built from NEXT_PUBLIC_DMS_PORTAL_URL, the same variable the login page's "Hosting &
 * domains sign-in" uses, so the two cannot point at different panels. Unset, it falls back to
 * the site's own /login, which carries that same sign-in link, never a guessed host.
 */
export const CLIENT_AREA_URL: string = (() => {
  const base = (process.env.NEXT_PUBLIC_DMS_PORTAL_URL ?? "").trim();
  if (!base) return "/login";
  try { return new URL("/login", base).toString(); } catch { return "/login"; }
})();

/** "919800000000" → "+91 98000 00000". */
export function whatsappDisplay(e164: string = WHATSAPP_NUMBER): string {
  return `+${e164.slice(0, 2)} ${e164.slice(2, 7)} ${e164.slice(7)}`;
}

/**
 * Service promises — the ONE place the website states a time (R-229, 7 Oct 2026).
 * The site used to say "call within 30 minutes (9am–7pm)", "WhatsApp within 4 hours",
 * "Live in 24 hours" and "same day" on different pages. Pardeep asked for realistic
 * promises; the manager fixed these values. Every page reads them from here. Never write
 * 24x7 or a guaranteed time anywhere — sla.test.ts greps the public site for that.
 */
const SLA_SHORT = {
  firstReply: "4 working hours",
  workspaceLive: "1 working day",
  hostingLive: "4 working hours",
  domainRegistered: "2 working hours",
  sslLive: "1 working day",
} as const;

export const SLA = {
  hours: "Mon–Sat, 10:00–19:00 IST",
  /** Bare durations for short labels ("Live in 1 working day"). */
  short: SLA_SHORT,
  /** First reply by call or WhatsApp. */
  firstReply: `within ${SLA_SHORT.firstReply}`,
  workspaceLive: `within ${SLA_SHORT.workspaceLive} of payment and DNS verification`,
  hostingLive: `within ${SLA_SHORT.hostingLive} of payment`,
  domainRegistered: `within ${SLA_SHORT.domainRegistered} of payment`,
  domainDelay: "If the registry is slow, we tell you by email.",
  sslLive: `within ${SLA_SHORT.sslLive} of the domain pointing to us`,
  /** R-340: a priced quote for a headcount (was "the same working day"). */
  quote: "within 1 working day",
  /** R-340: mail/site migration (was "24–48 hours, zero downtime" — not a promise we can keep). */
  migration: "usually 1–2 working days, planned to avoid downtime",
} as const;

/** Three lines shown on checkout and the done page under "After you pay". */
export const AFTER_YOU_PAY: readonly string[] = [
  `We call or WhatsApp you ${SLA.firstReply} (${SLA.hours}).`,
  `Hosting is live ${SLA.hostingLive}. A domain is registered ${SLA.domainRegistered}. ${SLA.domainDelay}`,
  `Google Workspace is live ${SLA.workspaceLive}. SSL is active ${SLA.sslLive}.`,
];

export const COMPANY = {
  name: "Anutech Digital Pvt Ltd",
  short: "Anutech Digital",
  gstin: "07ABDCA0298H1ZP",
  hsn: "998313",
  city: "Rohini, Delhi",
  founder: "Pardeep Sharma",
  supportEmail: "support@anutech.in",
  partnerLine: "Google Premier Partner, since 2014",
  hours: SLA.hours,
} as const;
