/**
 * Quote-builder catalogue — everything a multi-line quote can contain, in the
 * shape the "Anutech Quote" handoff uses. Prices come from the repo's own data
 * where it exists (LICENCE_EDITIONS + TLDS in catalog.ts, HOSTING_TIERS — the same
 * tiers /hosting, /rates and the cart sell) so the quote can never disagree with the
 * rest of the site; support tiers and the three domain "actions" are defined here
 * (not elsewhere in the repo) from the handoff.
 *
 * R-224 (7 Oct 2026): hosting used to come from the old HOSTING_PLANS placeholder
 * (Starter ₹159/199, Business ₹359 and a ₹799 third plan — ~3× /hosting, one that does
 * not exist). Hosting rates are paise-precise (₹49.99), so `quoteInr` prints them the
 * way /rates does. `monthly: null` = no flexible tier (a live GW edition can be annual
 * only) — the builder must not quote it under "Flexible monthly".
 *
 * `annual` / `monthly` are ₹ per `per`-unit per period. Domain / SSL / onsite
 * lines bill once a year (cycle "yr") — never ×12. Domain products carry a
 * `domainField` that selects the reg / renew / transfer column of the chosen
 * extension, so the rate follows the TLD the customer picks.
 */
import { LICENCE_EDITIONS, TLDS, type Tld } from "./catalog";
import { PLUS_EDITION } from "@/lib/catalog/public-price-policy";
import { HOSTING_TIERS } from "./hosting-landing-v2";
import { SLA } from "../config";
import type { MergedEdition } from "../live-catalog";

export interface QuoteProduct {
  name: string;      // stable id
  label: string;     // shown
  vendor: string;    // category
  tags: string;      // keyword search haystack
  note: string;
  annual: number;    // ₹/unit, annual commitment
  monthly: number | null; // ₹/unit, flexible monthly — null = annual only
  per: string;       // "seat" | "site" | "domain" | "certificate" | "account" | "visit"
  cycle: "mo" | "yr"; // billing cadence for the amount shown
  domain?: boolean;
  domainField?: keyof Pick<Tld, "reg" | "renew" | "transfer">;
  /** R-328: no public price (Business Plus) — the line goes on the quote, the price comes back
   *  with the formal quotation. ₹0 in every sum on this page; shown as "Price on request". */
  priceOnRequest?: boolean;
}

const LABEL: Record<string, string> = {
  "GW Business Starter": "Google Workspace Business Starter",
  "GW Business Standard": "Google Workspace Business Standard",
  "GW Business Plus": "Google Workspace Business Plus",
  "M365 Business Basic": "Microsoft 365 Business Basic",
  "M365 Business Standard": "Microsoft 365 Business Standard",
  "Zoho Workplace": "Zoho Workplace Standard",
};
const TAGS: Record<string, string> = {
  "GW Business Starter": "gmail meet drive docs sheets slides calendar gemini 30gb",
  "GW Business Standard": "gmail meet recordings shared drives 2tb esignature",
  "GW Business Plus": "vault ediscovery compliance endpoint 5tb audit retention",
  "M365 Business Basic": "outlook teams onedrive exchange webmail sharepoint",
  "M365 Business Standard": "outlook desktop word excel powerpoint teams webinars onedrive",
  "Zoho Workplace": "writer sheet show cliq zoho mail workdrive india cheapest",
};

const vendorOf = (name: string) => name.startsWith("GW ") ? "Google Workspace" : name.startsWith("M365 ") ? "Microsoft 365" : "Zoho Workplace";

const editions: QuoteProduct[] = LICENCE_EDITIONS.map((e) => ({
  name: e.name, label: LABEL[e.name] ?? e.name, vendor: vendorOf(e.name),
  tags: TAGS[e.name] ?? "", note: e.note, annual: e.annual, monthly: e.monthly, per: "seat", cycle: "mo",
}));
/* R-328: Business Plus can still be asked for — after Standard, with no figure of its own. */
const plusAt = editions.findIndex((e) => e.name === "GW Business Standard") + 1;
editions.splice(plusAt > 0 ? plusAt : editions.length, 0, {
  name: PLUS_EDITION, label: LABEL[PLUS_EDITION], vendor: "Google Workspace", tags: TAGS[PLUS_EDITION],
  note: "5 TB, Vault, eDiscovery · price sent with your quotation", annual: 0, monthly: 0, per: "seat", cycle: "mo",
  priceOnRequest: true,
});

const domains: QuoteProduct[] = [
  { name: "Domain registration", label: "Domain registration", vendor: "Domains", tags: "domain registration register new name in com net org dns whois", note: "A new name on the extension you pick — first year.", annual: 0, monthly: 0, per: "domain", cycle: "yr", domain: true, domainField: "reg" },
  { name: "Domain renewal", label: "Domain renewal", vendor: "Domains", tags: "domain renewal renew expiry extend keep", note: "Extend an existing name by one year.", annual: 0, monthly: 0, per: "domain", cycle: "yr", domain: true, domainField: "renew" },
  { name: "Domain transfer", label: "Domain transfer in", vendor: "Domains", tags: "domain transfer move switch registrar epp code", note: "Move a name to us — no fee, adds a year.", annual: 0, monthly: 0, per: "domain", cycle: "yr", domain: true, domainField: "transfer" },
];

/* Same tiers, names and ₹ as /hosting and /rates: billed yearly → annual, billed monthly → flexible. */
const hosting: QuoteProduct[] = HOSTING_TIERS.map((h) => ({
  name: `Hosting ${h.name}`, label: `Web hosting — ${h.name}`, vendor: "Web hosting",
  tags: `cpanel nvme ssl backups hosting website ${h.name.toLowerCase()}`,
  note: `${h.storage} · ${h.sites} site${h.sites === "1" ? "" : "s"} · ${h.bandwidth} bandwidth`,
  annual: h.yearlyMo, monthly: h.monthly, per: "site", cycle: "mo",
}));

const ssl: QuoteProduct[] = [
  { name: "SSL Positive", label: "Positive SSL — DV", vendor: "SSL & security", tags: "ssl certificate https dv secure padlock", note: `Single domain · active ${SLA.sslLive}.`, annual: 899, monthly: 899, per: "certificate", cycle: "yr" },
  { name: "SSL Wildcard", label: "Wildcard SSL — DV", vendor: "SSL & security", tags: "ssl certificate https wildcard subdomains secure", note: "Unlimited subdomains on one domain.", annual: 4499, monthly: 4499, per: "certificate", cycle: "yr" },
];

const support: QuoteProduct[] = [
  { name: "Support Standard", label: "Support — Standard", vendor: "Support", tags: "support whatsapp help desk included free standard", note: "Included with every order · WhatsApp, Mon–Sat 10–19 IST.", annual: 0, monthly: 0, per: "account", cycle: "yr" },
  { name: "Support Priority", label: "Support — Priority", vendor: "Support", tags: "support priority sla escalation phone urgent response", note: "1-hour first response, 7 days · named engineer.", annual: 999, monthly: 1199, per: "account", cycle: "mo" },
  { name: "Support Onsite Delhi", label: "Onsite visit — Delhi NCR", vendor: "Support", tags: "support onsite visit delhi ncr engineer setup training", note: "Engineer at your office · setup or team training.", annual: 2499, monthly: 2499, per: "visit", cycle: "yr" },
  { name: "Support Managed Admin", label: "Managed admin", vendor: "Support", tags: "support managed admin console users offboarding audit", note: "We run the admin console — users, policies, offboarding.", annual: 1499, monthly: 1799, per: "account", cycle: "mo" },
];

export const QUOTE_PRODUCTS: readonly QuoteProduct[] = [...editions, ...domains, ...hosting, ...ssl, ...support];

/** Category order for the filter, with live counts. */
export const QUOTE_CATEGORIES: readonly string[] = ["Google Workspace", "Microsoft 365", "Zoho Workplace", "Domains", "Web hosting", "SSL & security", "Support"];

/** The extensions the domain picker offers — real reg/renew/transfer from TLDS. */
export const QUOTE_TLDS: readonly Tld[] = TLDS;

/**
 * Overlay live edition prices on the catalogue. A live edition whose `monthlyOrNull` is
 * null has no flexible tier — its `monthly` becomes null (annual only), never the annual
 * rate dressed up as monthly (R-224).
 */
export function withLiveEditions(products: readonly QuoteProduct[], editions: readonly MergedEdition[] | undefined): QuoteProduct[] {
  if (!editions?.length) return [...products];
  const live = new Map(editions.map((e) => [e.name, e]));
  return products.map((p) => {
    const l = live.get(p.name);
    if (!l || p.priceOnRequest) return p;
    const monthly = l.monthlyOrNull === undefined ? l.monthly : l.monthlyOrNull;
    return { ...p, annual: l.annual ?? p.annual, monthly };
  });
}

/** ₹/unit for the term, or null when the product is not sold on that term. */
export function quoteRate(p: QuoteProduct, term: "annual" | "monthly"): number | null {
  return term === "annual" ? p.annual : p.monthly;
}

/** ₹ the way /rates prints it: whole rupees plain, paise to 2 places (₹49.99, ₹1,080). */
export function quoteInr(n: number): string {
  const r = Math.round(n * 100) / 100;
  return "₹" + (Number.isInteger(r) ? r.toLocaleString("en-IN") : r.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}
