/**
 * R-1786 (Phase 2 of R-1784, one product catalog) — the price book the website and checkout
 * read hosting, the Anutech Mail mailbox and SSL from.
 *
 * Two sources, one shape:
 *   · the CODE prices (LANDING_PLANS → HOSTING_TIERS, MAILBOX_YR, CERTS) — today's behaviour,
 *     and the fallback for every SKU the catalogue does not answer for;
 *   · the `items` rows R-1785 seeded by SKU (HOST-<TIER>-YR/MO, MAIL-ANUTECH-YR, SSL-*-YR) —
 *     used only when CATALOG_FROM_DB is on (catalog-prices.server.ts reads them).
 *
 * Fail-safe for customers: a missing, inactive or non-positive row never prices anything at
 * ₹0 — that SKU keeps its code price and is named in `fallbacks` (the server logs it).
 * The old synced `HOST-<PLAN>-<tenant>` rows (no `sku`) are not read: what to do with them is
 * still Pardeep's decision (R-1785 needsDecision).
 *
 * Client-safe on purpose (no server imports): the site's client components take the book's
 * `tiers` / `mailboxYearly` / `ssl` as props. Whole rupees throughout (CLAUDE.md §13).
 */
import { HOSTING_TIERS, type HostingTier } from "@/site/lib/data/hosting-landing-v2";
import { MAILBOX_YR } from "@/site/lib/data/domains-landing";
import { CERTS, MAIL_RATES, type Cert } from "@/site/lib/data/catalog";
import { SUPPORT_TIERS, supportPrice, supportSkuId, type SupportTierId } from "@/lib/support/tiers";

export const CATALOG_FUNCTIONS = ["hosting", "mail", "ssl", "support"] as const;
export type CatalogFunction = (typeof CATALOG_FUNCTIONS)[number];

/** One SKU the website sells, as the R-1785 seed wrote it (the fallback metadata). */
export interface CoreSku {
  sku: string;
  name: string;
  function: CatalogFunction;
  termMonths: number;
  hsn: string;
  fulfilment: string;
  engineRef: string | null;
}

const tierSkus = (tier: string, name: string): CoreSku[] => [
  { sku: `HOST-${tier}-YR`, name: `${name} Hosting (Yearly)`, function: "hosting", termMonths: 12, hsn: "998315", fulfilment: "hosting_panel", engineRef: name },
  { sku: `HOST-${tier}-MO`, name: `${name} Hosting (Monthly)`, function: "hosting", termMonths: 1, hsn: "998315", fulfilment: "hosting_panel", engineRef: name },
];

/** Every SKU this book prices — the same ten rows as 20261023114500_r1785_catalog_phase1.sql. */
export const CORE_SKUS: readonly CoreSku[] = [
  ...tierSkus("STARTER", "Starter"),
  ...tierSkus("STANDARD", "Standard"),
  ...tierSkus("PLUS", "Plus"),
  { sku: "MAIL-ANUTECH-YR", name: "Anutech Mail mailbox (Yearly)", function: "mail", termMonths: 12, hsn: "998313", fulfilment: "manual", engineRef: null },
  { sku: "SSL-POSITIVE-YR", name: "Positive SSL (Yearly)", function: "ssl", termMonths: 12, hsn: "998313", fulfilment: "manual", engineRef: null },
  { sku: "SSL-WILDCARD-YR", name: "Wildcard SSL (Yearly)", function: "ssl", termMonths: 12, hsn: "998313", fulfilment: "manual", engineRef: null },
  { sku: "SSL-OVEV-YR", name: "OV / EV SSL (Yearly)", function: "ssl", termMonths: 12, hsn: "998313", fulfilment: "manual", engineRef: null },
];

/**
 * R-2083 (29 Oct 2026): the paid support plans the website sells (/buy/support) — Standard and
 * Enterprise, monthly and yearly. Free is not sold, so it has no SKU here. Names, HSN and term
 * are the 20260817160000 seed's + R-1785 §4's (sku, term_months, fulfilment 'support_panel');
 * the code price is SUPPORT_TIERS (lib/support/tiers.ts) — the same figures the seed wrote and
 * the quote builder charges. Kept apart from CORE_SKUS, which is the R-1785 seed list exactly.
 */
const supportSkus = (id: SupportTierId, label: string): CoreSku[] => [
  { sku: supportSkuId(id, "monthly"), name: `Support ${label} (Monthly)`, function: "support", termMonths: 1, hsn: "998313", fulfilment: "support_panel", engineRef: null },
  { sku: supportSkuId(id, "yearly"), name: `Support ${label} (Yearly)`, function: "support", termMonths: 12, hsn: "998313", fulfilment: "support_panel", engineRef: null },
];
export const SUPPORT_SKUS: readonly CoreSku[] = [...supportSkus("standard", "Standard"), ...supportSkus("enterprise", "Enterprise")];

/** Every SKU the book prices and the public catalogue lists. */
export const BOOK_SKUS: readonly CoreSku[] = [...CORE_SKUS, ...SUPPORT_SKUS];

/** The support SKU for a plan and cycle, or null for a plan the website does not sell (Free). */
export function supportBookSku(plan: string, cycle: "monthly" | "yearly"): string | null {
  const t = SUPPORT_TIERS.find((x) => x.id === plan);
  if (!t || t.id === "free") return null;
  return supportSkuId(t.id, cycle);
}

/** CERTS card name → its SKU. Free DV is included with hosting, not sold. */
export const SSL_SKU_BY_CERT: Readonly<Record<string, string>> = {
  "Positive SSL": "SSL-POSITIVE-YR",
  Wildcard: "SSL-WILDCARD-YR",
  "OV / EV": "SSL-OVEV-YR",
};

export const hostingSku = (tier: string, yearly: boolean) => `HOST-${tier.toUpperCase()}-${yearly ? "YR" : "MO"}`;

/** One `items` row as the server reads it — only the columns the book and the public API use. */
export interface CatalogRow {
  sku: string;
  name: string;
  msrp: number | string;
  hsn: string | null;
  term_months: number | null;
  fulfilment: string | null;
  engine_ref: string | null;
  is_public: boolean;
  /** R-2083: prices.annual_total.msrp — where a yearly support row keeps its year total (msrp 0). */
  annual_total_msrp?: number | string | null;
}

export interface PriceBook {
  /** "catalog" when the flag is on and the rows were read; "code" otherwise. */
  source: "code" | "catalog";
  /** HOSTING_TIERS with each cycle's price from the catalogue (same object when unchanged). */
  tiers: readonly HostingTier[];
  /** ₹ for one mailbox, one year, ex-GST. */
  mailboxYearly: number;
  /** SKU → ₹ ex-GST for each paid certificate. */
  ssl: Readonly<Record<string, number>>;
  /** R-2083: SKU → ₹ ex-GST for one term of each paid support plan (SUP-*-MO = a month, -YR = the year). */
  support: Readonly<Record<string, number>>;
  /** Public metadata per SKU (catalogue row when there is one, else the seed's). */
  entries: readonly PublicEntry[];
  /** SKUs priced from code because the catalogue had no usable row. */
  fallbacks: readonly string[];
}

export interface PublicEntry {
  sku: string;
  name: string;
  function: CatalogFunction;
  termMonths: number;
  exGst: number;
  hsn: string;
  fulfilment: string;
  engineRef: string | null;
  isPublic: boolean;
}

/** CATALOG_FROM_DB=1 (or true/on) — off by default, which is today's behaviour. */
export function catalogFromDbEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env.CATALOG_FROM_DB ?? "").trim());
}

/** A usable price: a finite number above zero, rounded to whole rupees. Else null. */
function rupees(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

const twoDp = (n: number) => Math.round(n * 100) / 100;

function codeSupportPrice(sku: string): number {
  const m = /^SUP-([A-Z]+)-(MO|YR)$/.exec(sku);
  const t = m ? SUPPORT_TIERS.find((x) => x.id.toUpperCase() === m[1]) : undefined;
  return t && m ? supportPrice(t, m[2] === "YR" ? "yearly" : "monthly") : 0;
}

/**
 * The price a catalogue row holds. Support's yearly rows keep the whole-year total in
 * prices.annual_total.msrp and 0 in msrp (20260817160000 — lib/support/catalog-row.ts
 * supportRowPrice); every other row keeps it in msrp.
 */
function rowPrice(sku: string, r: CatalogRow | undefined): number | null {
  if (!r) return null;
  if (/^SUP-[A-Z]+-YR$/.test(sku)) return rupees(r.annual_total_msrp) ?? rupees(r.msrp);
  return rupees(r.msrp);
}

function codeSslPrice(sku: string): number {
  const name = Object.keys(SSL_SKU_BY_CERT).find((k) => SSL_SKU_BY_CERT[k] === sku);
  const cert = CERTS.find((c) => c.name === name);
  return Number((cert?.price ?? "0").replace(/[^\d]/g, ""));
}

/** What the code charges for one SKU today. */
export function codePrice(sku: string): number {
  const h = /^HOST-([A-Z]+)-(YR|MO)$/.exec(sku);
  if (h) {
    const t = HOSTING_TIERS.find((x) => x.name.toUpperCase() === h[1]);
    return t ? Math.round(h[2] === "YR" ? t.yearlyTotal : t.monthly) : 0;
  }
  if (sku === "MAIL-ANUTECH-YR") return Math.round(MAILBOX_YR);
  if (sku.startsWith("SUP-")) return codeSupportPrice(sku);
  return codeSslPrice(sku);
}

/**
 * The book from catalogue rows. `rows === null` (flag off) → the code book, unchanged.
 * A tier whose catalogue price equals the code's rupee keeps the code tier object exactly
 * (so /hosting still prints ₹49.99/mo, not ₹50); a changed price replaces that cycle only.
 */
export function buildPriceBook(rows: readonly CatalogRow[] | null): PriceBook {
  const bySku = new Map((rows ?? []).map((r) => [r.sku, r]));
  const fallbacks: string[] = [];
  const price = (sku: string): number => {
    const fromDb = rows ? rowPrice(sku, bySku.get(sku)) : null;
    if (fromDb !== null) return fromDb;
    if (rows) fallbacks.push(sku);
    return codePrice(sku);
  };

  const tiers = HOSTING_TIERS.map((t) => {
    const yr = price(hostingSku(t.name, true));
    const mo = price(hostingSku(t.name, false));
    const sameYr = yr === Math.round(t.yearlyTotal);
    const sameMo = mo === Math.round(t.monthly);
    if (sameYr && sameMo) return t;
    return {
      ...t,
      ...(sameYr ? {} : { yearlyTotal: yr, yearlyMo: twoDp(yr / 12) }),
      ...(sameMo ? {} : { monthly: mo }),
    };
  });
  const mailboxYearly = price("MAIL-ANUTECH-YR");
  const ssl: Record<string, number> = {};
  for (const sku of Object.values(SSL_SKU_BY_CERT)) ssl[sku] = price(sku);
  const support: Record<string, number> = {};
  for (const s of SUPPORT_SKUS) support[s.sku] = price(s.sku);

  const priceOf = (sku: string): number => {
    const h = /^HOST-([A-Z]+)-(YR|MO)$/.exec(sku);
    if (h) {
      const t = tiers.find((x) => x.name.toUpperCase() === h[1])!;
      return Math.round(h[2] === "YR" ? t.yearlyTotal : t.monthly);
    }
    if (sku.startsWith("SUP-")) return support[sku];
    return sku === "MAIL-ANUTECH-YR" ? mailboxYearly : ssl[sku];
  };
  const entries: PublicEntry[] = BOOK_SKUS.map((c) => {
    const r = bySku.get(c.sku);
    const usable = !!rows && !!r && rowPrice(c.sku, r) !== null;
    return {
      sku: c.sku,
      name: usable ? r!.name : c.name,
      function: c.function,
      termMonths: usable && r!.term_months ? r!.term_months : c.termMonths,
      exGst: priceOf(c.sku),
      hsn: usable && r!.hsn ? r!.hsn : c.hsn,
      fulfilment: usable && r!.fulfilment ? r!.fulfilment : c.fulfilment,
      engineRef: usable ? r!.engine_ref : c.engineRef,
      /* R-2083: the support rows were seeded in Aug, before is_public existed (default false,
         never set since). A paid plan IS sold on the website (/buy/support), so its flag is not
         read — the rows would otherwise vanish from the list the day CATALOG_FROM_DB goes on. */
      isPublic: c.function === "support" ? true : usable ? r!.is_public : true,
    };
  });

  return { source: rows ? "catalog" : "code", tiers, mailboxYearly, ssl, support, entries, fallbacks };
}

/** Today's prices, from code only. */
export const codePriceBook = (): PriceBook => buildPriceBook(null);

/** GST checkout adds to every line (lib/checkout: Math.round(subtotal × 1.18)). */
export const CATALOG_GST_PERCENT = 18;

/** What GET /api/public/catalog returns per product — this list and nothing else. */
export interface PublicCatalogItem {
  sku: string;
  name: string;
  function: CatalogFunction;
  termMonths: number;
  exGst: number;
  inclGst: number;
  gstRate: number;
  hsn: string;
  fulfilment: string;
  engineRef: string | null;
}

/**
 * The public list, built field by field (never by spreading a row), so a column added to
 * `items` later — cost, margin, partner price — cannot leak by accident.
 */
export function publicCatalog(book: Pick<PriceBook, "entries">, fn?: CatalogFunction): PublicCatalogItem[] {
  return book.entries
    .filter((e) => e.isPublic && e.exGst > 0 && (!fn || e.function === fn))
    .map((e) => ({
      sku: e.sku,
      name: e.name,
      function: e.function,
      termMonths: e.termMonths,
      exGst: e.exGst,
      inclGst: Math.round(e.exGst * (1 + CATALOG_GST_PERCENT / 100)),
      gstRate: CATALOG_GST_PERCENT,
      hsn: e.hsn,
      fulfilment: e.fulfilment,
      engineRef: e.engineRef,
    }));
}

/**
 * CERTS with each paid certificate's price from the book — for the /ssl cards and /rates.
 * A cert whose book price equals the code's keeps the code object exactly; Free DV is untouched.
 */
export function bookCerts(book: Pick<PriceBook, "ssl">, certs: readonly Cert[] = CERTS): Cert[] {
  return certs.map((c) => {
    const sku = SSL_SKU_BY_CERT[c.name];
    const p = sku ? book.ssl[sku] : undefined;
    if (!p || p <= 0 || p === Number(c.price.replace(/[^\d]/g, ""))) return c;
    const price = "₹" + Math.round(p).toLocaleString("en-IN");
    return { ...c, price, addPrice: c.addPrice === null ? null : Math.round(p) };
  });
}

/**
 * R-1797: the Anutech Mail mailbox per month, as the site prints it ("₹79/mailbox/mo") — the
 * book's yearly price over 12, whole rupees, never below ₹1. Flag off: 948 / 12 = ₹79.
 */
export function bookMailboxMonthly(book: Pick<PriceBook, "mailboxYearly">): number {
  return Math.max(1, Math.round(book.mailboxYearly / 12));
}

/** MAIL_RATES with Anutech Mail from the book (the same object when unchanged) — /rates. */
export function bookMailRates(
  book: Pick<PriceBook, "mailboxYearly">,
  rates: Readonly<Record<string, number>> = MAIL_RATES,
): Readonly<Record<string, number>> {
  const mo = bookMailboxMonthly(book);
  return rates["Anutech Mail"] === mo ? rates : { ...rates, "Anutech Mail": mo };
}

/** R-2083: the ex-GST price of one term of a paid support plan in this book, or null (Free / unknown). */
export function bookSupportPrice(book: Pick<PriceBook, "support">, plan: string, cycle: "monthly" | "yearly"): number | null {
  const sku = supportBookSku(plan, cycle);
  const p = sku ? book.support[sku] : undefined;
  return typeof p === "number" && p > 0 ? p : null;
}

/** The ex-GST rate for one hosting tier and cycle in this book, or null for an unknown tier. */
export function bookHostingRate(book: Pick<PriceBook, "tiers">, tier: string, yearly: boolean): number | null {
  const t = book.tiers.find((x) => x.name.toLowerCase() === tier.toLowerCase());
  return t ? Math.round(yearly ? t.yearlyTotal : t.monthly) : null;
}
