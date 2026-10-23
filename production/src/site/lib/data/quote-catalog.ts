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
 * not exist). R-1465 (16 Oct 2026): the catalogue rate keeps its paise (₹49.99) but the
 * site never prints them — `quoteInr` is the site's one whole-rupee formatter, and a line's
 * amount is rounded to whole rupees the way checkout charges it. `monthly: null` = no flexible tier (a live GW edition can be annual
 * only) — the builder must not quote it under "Flexible monthly".
 *
 * `annual` / `monthly` are ₹ per `per`-unit per period. Domain / SSL / onsite
 * lines bill once a year (cycle "yr") — never ×12. Domain products carry a
 * `domainField` that selects the reg / renew / transfer column of the chosen
 * extension, so the rate follows the TLD the customer picks.
 */
import { CERTS, LICENCE_EDITIONS, TLDS, type Tld } from "./catalog";
import { PLUS_EDITION } from "@/lib/catalog/public-price-policy";
import { HOSTING_TIERS, type HostingTier } from "./hosting-landing-v2";
import { SSL_SKU_BY_CERT } from "@/lib/catalog/catalog-prices";
import { SLA } from "../config";
import { rupee } from "../money";
import { gstBreakup } from "@/lib/quotes/amounts";
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
  { name: "Domain transfer", label: "Domain transfer in", vendor: "Domains", tags: "domain transfer move switch registrar epp code", note: "Move a name to us — the transfer price includes 1 year renewal.", annual: 0, monthly: 0, per: "domain", cycle: "yr", domain: true, domainField: "transfer" },
];

/* Same tiers, names and ₹ as /hosting and /rates: billed yearly → annual, billed monthly → flexible. */
const hosting: QuoteProduct[] = HOSTING_TIERS.map((h) => ({
  name: `Hosting ${h.name}`, label: `Web hosting — ${h.name}`, vendor: "Web hosting",
  tags: `cpanel nvme ssl backups hosting website ${h.name.toLowerCase()}`,
  note: `${h.storage} · ${h.sites} site${h.sites === "1" ? "" : "s"} · ${h.bandwidth} bandwidth`,
  annual: h.yearlyMo, monthly: h.monthly, per: "site", cycle: "mo",
}));

/* R-1504: SSL rates are the ones /ssl prints (CERTS.addPrice) — never typed a second time. A
   certificate with no fixed price on /ssl (OV / EV, "Talk to us") is quoted as price on request. */
const SSL_CATEGORY = "SSL & security";
type SslLineInfo = Pick<QuoteProduct, "name" | "label" | "tags" | "note">;
const sslLine = (certName: string, p: SslLineInfo): QuoteProduct => {
  const price = CERTS.find((c) => c.name === certName)?.addPrice ?? null;
  return {
    ...p, vendor: SSL_CATEGORY, per: "certificate", cycle: "yr", annual: price ?? 0, monthly: price ?? 0,
    ...(price === null ? { priceOnRequest: true } : {}),
  };
};
/** /ssl card name → the quote line its "Get a quote" button opens on. Free DV is not sold. */
const CERT_QUOTE_LINE: Readonly<Record<string, string>> = {
  "Positive SSL": "SSL Positive",
  Wildcard: "SSL Wildcard",
  "OV / EV": "SSL OV/EV",
};

const ssl: QuoteProduct[] = [
  sslLine("Positive SSL", { name: "SSL Positive", label: "Positive SSL — DV", tags: "ssl certificate https dv secure padlock", note: `Single domain · active ${SLA.sslLive}.` }),
  sslLine("Wildcard", { name: "SSL Wildcard", label: "Wildcard SSL — DV", tags: "ssl certificate https wildcard subdomains secure", note: "Unlimited subdomains on one domain." }),
  sslLine("OV / EV", { name: "SSL OV/EV", label: "OV / EV SSL — organisation validated", tags: "ssl certificate https ov ev organisation extended validation company name vetting", note: "Company name on the certificate · the CA vets your documents, we handle them." }),
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

/**
 * R-1504: what /quote opens on. `?product=ssl` (from /ssl) opens the SSL category with
 * `?ed=<SSL line>` picked, else Positive SSL; `?ed=` alone keeps the calculator hand-off.
 * Anything unknown returns {} — the page's own default (Workspace Starter, all plans).
 */
const PRODUCT_PARAM: Readonly<Record<string, { cat: string; line: string }>> = {
  ssl: { cat: SSL_CATEGORY, line: "SSL Positive" },
};
export function quotePrefill(
  params: { get(key: string): string | null },
  known: ReadonlyMap<string, { vendor: string }>,
): { ed?: string; cat?: string } {
  const ed = params.get("ed") ?? params.get("edition");
  const key = (params.get("product") ?? "").trim().toLowerCase();
  const product = Object.hasOwn(PRODUCT_PARAM, key) ? PRODUCT_PARAM[key] : undefined;
  if (product) {
    const line = ed && known.get(ed)?.vendor === product.cat ? ed : product.line;
    return known.has(line) ? { ed: line, cat: product.cat } : { cat: product.cat };
  }
  return ed && known.has(ed) ? { ed } : {};
}

/** The /quote link for an /ssl certificate card, or null for one that is not sold (Free DV). */
export function sslQuoteHref(certName: string): string | null {
  const line = Object.hasOwn(CERT_QUOTE_LINE, certName) ? CERT_QUOTE_LINE[certName] : undefined;
  return line ? `/quote?${new URLSearchParams({ product: "ssl", ed: line })}` : null;
}

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

/** The price-book figures /quote needs (lib/catalog/catalog-prices PriceBook: tiers + ssl). */
export interface QuoteBookPrices {
  tiers: readonly HostingTier[];
  /** SKU (SSL-POSITIVE-YR…) → ₹ ex-GST per year. */
  ssl: Readonly<Record<string, number>>;
}

/**
 * R-1797: hosting and SSL lines at the price book's figures (items rows with CATALOG_FROM_DB
 * on), so the estimate is what /hosting, /ssl and checkout say. A product the book does not
 * price, or prices at ₹0, keeps its code figure; a price-on-request line stays on request.
 * No book, or the code book → the same products, unchanged.
 */
export function withPriceBook(products: readonly QuoteProduct[], book: QuoteBookPrices | undefined): QuoteProduct[] {
  if (!book) return [...products];
  const sslSku = new Map(Object.entries(CERT_QUOTE_LINE).map(([cert, line]) => [line, SSL_SKU_BY_CERT[cert]]));
  return products.map((p) => {
    if (p.priceOnRequest) return p;
    if (p.vendor === "Web hosting") {
      const t = book.tiers.find((x) => `Hosting ${x.name}` === p.name);
      if (!t || !(t.yearlyMo > 0) || !(t.monthly > 0)) return p;
      return t.yearlyMo === p.annual && t.monthly === p.monthly ? p : { ...p, annual: t.yearlyMo, monthly: t.monthly };
    }
    const sku = sslSku.get(p.name);
    const price = sku ? book.ssl[sku] : undefined;
    if (!price || price <= 0 || price === p.annual) return p;
    return { ...p, annual: Math.round(price), monthly: Math.round(price) };
  });
}

/** ₹/unit for the term, or null when the product is not sold on that term. */
export function quoteRate(p: QuoteProduct, term: "annual" | "monthly"): number | null {
  return term === "annual" ? p.annual : p.monthly;
}

/** ₹ the way every site page prints it (R-1465): whole rupees (₹50, ₹1,080), never paise. */
export const quoteInr: (n: number) => string = rupee;

/**
 * One unit's price for one billing period, whole rupees — rate × months rounded once, exactly
 * as checkout prices a hosting site (hostingRate: Math.round of the cycle total,
 * lib/checkout/hosting-prices.ts). ₹49.99 × 12 = ₹600 a site.
 */
export function quoteUnitAmount(rate: number, months: number): number {
  return Math.round(rate * months);
}

/**
 * One quote line's amount, whole rupees — the unit's period price × qty.
 *
 * R-1482 (17 Oct 2026): this used to round rate × qty × months once, so 7 Starter sites a year
 * came to ₹4,199 (49.99 × 84) while checkout charges ₹600 a site — ₹4,200. Rounding per unit
 * then multiplying is what checkout does, so the quote line now equals it for any count.
 * Display only: /quote sends an enquiry, never an amount; the team prices the real quotation.
 */
export function quoteLineAmount(rate: number, qty: number, months: number): number {
  return quoteUnitAmount(rate, months) * qty;
}

/** A line as the renewal sees it: `rate` = the term's rate, `renewRate` = what a yearly item renews at. */
export interface QuoteRenewalLine {
  cycle: QuoteProduct["cycle"];
  qty: number;
  rate: number;
  /** Domains: the extension's renewal price, not its registration/transfer price (R-1484). */
  renewRate: number;
}

export interface QuoteRenewal {
  /** Flexible monthly: one month's invoice incl. GST. Null on an annual commitment. */
  perMonth: number | null;
  /** Flexible monthly: the yearly items (domain, SSL…) once a year, incl. GST. 0 on annual. */
  yearlyOnce: number;
  /** What a year costs at today's rates, incl. GST. Monthly: perMonth × 12 + yearlyOnce. */
  perYear: number;
}

/**
 * The "Renews ₹X/yr" line on /quote (R-1483, 17 Oct 2026).
 *
 * Flexible monthly is billed as twelve monthly invoices, each with its own GST — so a year is
 * the month's payable × 12, not one year-long line rounded once. Pawan's basket (GW Starter × 3
 * + Hosting Starter × 7) paid ₹1,977 a month but "renewed" at ₹23,716 a year; ₹1,977 × 12 is
 * ₹23,724. Yearly items (domain, SSL, onsite) renew once a year at their renewal rate.
 * An annual commitment is one invoice: monthly-cycle lines × 12 per unit plus yearly items, one GST.
 */
export function quoteRenewal(lines: readonly QuoteRenewalLine[], term: "annual" | "monthly"): QuoteRenewal {
  const yearlyItems = lines.filter((l) => l.cycle === "yr").reduce((n, l) => n + quoteLineAmount(l.renewRate, l.qty, 1), 0);
  const moLines = lines.filter((l) => l.cycle === "mo");
  if (term === "annual") {
    const taxable = moLines.reduce((n, l) => n + quoteLineAmount(l.rate, l.qty, 12), 0) + yearlyItems;
    return { perMonth: null, yearlyOnce: 0, perYear: gstBreakup(taxable).total };
  }
  const perMonth = gstBreakup(moLines.reduce((n, l) => n + quoteLineAmount(l.rate, l.qty, 1), 0)).total;
  const yearlyOnce = yearlyItems > 0 ? gstBreakup(yearlyItems).total : 0;
  return { perMonth, yearlyOnce, perYear: perMonth * 12 + yearlyOnce };
}
