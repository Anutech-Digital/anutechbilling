/**
 * R-1786 (Phase 2 of R-1784) — the price book: code prices with CATALOG_FROM_DB off, the
 * `items` rows with it on, and the code price (never ₹0) for any SKU the catalogue misses.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  bookCerts, bookHostingRate, buildPriceBook, catalogFromDbEnabled, codePrice, codePriceBook,
  CORE_SKUS, publicCatalog, type CatalogRow,
} from "./catalog-prices";
import { HOSTING_TIERS } from "@/site/lib/data/hosting-landing-v2";
import { hostingPriceTable, hostingRate, hostingRateIn } from "@/lib/checkout/hosting-prices";
import { MAILBOX_YR } from "@/site/lib/data/domains-landing";
import { CERTS } from "@/site/lib/data/catalog";

/** The rows R-1785 seeded, exactly (catalog-seed-parity.test.ts proves = the code prices). */
const SEEDED: Record<string, number> = {
  "HOST-STARTER-YR": 600, "HOST-STARTER-MO": 100,
  "HOST-STANDARD-YR": 1500, "HOST-STANDARD-MO": 250,
  "HOST-PLUS-YR": 2246, "HOST-PLUS-MO": 374,
  "MAIL-ANUTECH-YR": 948,
  "SSL-POSITIVE-YR": 899, "SSL-WILDCARD-YR": 4499, "SSL-OVEV-YR": 6999,
};

function rows(over: Record<string, number | string | null> = {}, drop: string[] = []): CatalogRow[] {
  return CORE_SKUS.filter((c) => !drop.includes(c.sku)).map((c) => ({
    sku: c.sku,
    name: c.name,
    msrp: (c.sku in over ? over[c.sku] : SEEDED[c.sku]) as number,
    hsn: c.hsn,
    term_months: c.termMonths,
    fulfilment: c.fulfilment,
    engine_ref: c.engineRef,
    is_public: true,
  }));
}

describe("CATALOG_FROM_DB", () => {
  it("is off unless set to 1/true/on/yes", () => {
    expect(catalogFromDbEnabled({})).toBe(false);
    expect(catalogFromDbEnabled({ CATALOG_FROM_DB: "" })).toBe(false);
    expect(catalogFromDbEnabled({ CATALOG_FROM_DB: "0" })).toBe(false);
    expect(catalogFromDbEnabled({ CATALOG_FROM_DB: "false" })).toBe(false);
    for (const v of ["1", "true", "TRUE", "on", " yes "]) expect(catalogFromDbEnabled({ CATALOG_FROM_DB: v })).toBe(true);
  });
});

describe("flag off — the code book is today's prices, unchanged", () => {
  const book = codePriceBook();
  it("tiers are HOSTING_TIERS themselves", () => {
    expect(book.source).toBe("code");
    expect(book.tiers).toEqual(HOSTING_TIERS);
    book.tiers.forEach((t, i) => expect(t).toBe(HOSTING_TIERS[i]));
  });
  it("every rate = hostingRate, and the panel table is identical", () => {
    for (const t of HOSTING_TIERS) for (const y of [true, false]) {
      expect(bookHostingRate(book, t.name, y)).toBe(hostingRate(t.name, y));
      expect(hostingRateIn(book.tiers, t.name, y)).toBe(hostingRate(t.name, y));
    }
    expect(hostingPriceTable(book.tiers)).toEqual(hostingPriceTable());
  });
  it("mailbox = MAILBOX_YR, SSL = CERTS, nothing reported as a fallback", () => {
    expect(book.mailboxYearly).toBe(MAILBOX_YR);
    expect(bookCerts(book)).toEqual([...CERTS]);
    expect(book.fallbacks).toEqual([]);
    for (const sku of Object.keys(SEEDED)) expect(codePrice(sku)).toBe(SEEDED[sku]);
  });
});

describe("flag on — prices come from the catalogue rows", () => {
  it("rows at the seeded prices: same tiers objects, same table (no ₹50 for ₹49.99)", () => {
    const book = buildPriceBook(rows());
    expect(book.source).toBe("catalog");
    expect(book.fallbacks).toEqual([]);
    book.tiers.forEach((t, i) => expect(t).toBe(HOSTING_TIERS[i]));
    expect(hostingPriceTable(book.tiers)).toEqual(hostingPriceTable());
    expect(book.mailboxYearly).toBe(MAILBOX_YR);
    expect(bookCerts(book)).toEqual([...CERTS]);
  });

  it("Starter Yearly edited to ₹610 → checkout rate 610, monthly and other tiers untouched", () => {
    const book = buildPriceBook(rows({ "HOST-STARTER-YR": 610 }));
    expect(bookHostingRate(book, "starter", true)).toBe(610);
    expect(bookHostingRate(book, "starter", false)).toBe(100);
    expect(bookHostingRate(book, "standard", true)).toBe(1500);
    const starter = book.tiers.find((t) => t.name === "Starter")!;
    expect(starter.yearlyTotal).toBe(610);
    expect(starter.yearlyMo).toBe(50.83);
    expect(hostingPriceTable(book.tiers)[0].yearly).toEqual({ months: 12, exGst: 610, inclGst: 720 });
  });

  it("mailbox and SSL edits reach the book; a fractional rupee is rounded", () => {
    const book = buildPriceBook(rows({ "MAIL-ANUTECH-YR": 999.6, "SSL-WILDCARD-YR": "4999" }));
    expect(book.mailboxYearly).toBe(1000);
    expect(book.ssl["SSL-WILDCARD-YR"]).toBe(4999);
    const wc = bookCerts(book).find((c) => c.name === "Wildcard")!;
    expect(wc.price).toBe("₹4,999");
    expect(wc.addPrice).toBe(4999);
    expect(bookCerts(book).find((c) => c.name === "OV / EV")!.addPrice).toBeNull(); // still "Talk to us"
  });

  it("a missing row falls back to the code price and is reported", () => {
    const book = buildPriceBook(rows({}, ["HOST-PLUS-MO", "MAIL-ANUTECH-YR"]));
    expect(bookHostingRate(book, "plus", false)).toBe(374);
    expect(book.mailboxYearly).toBe(948);
    expect(book.fallbacks).toEqual(["HOST-PLUS-MO", "MAIL-ANUTECH-YR"]);
  });

  it("never ₹0: a zero, negative or junk price falls back too", () => {
    const book = buildPriceBook(rows({ "HOST-STARTER-YR": 0, "HOST-STANDARD-YR": -5, "SSL-POSITIVE-YR": "abc", "MAIL-ANUTECH-YR": null }));
    expect(bookHostingRate(book, "starter", true)).toBe(600);
    expect(bookHostingRate(book, "standard", true)).toBe(1500);
    expect(book.ssl["SSL-POSITIVE-YR"]).toBe(899);
    expect(book.mailboxYearly).toBe(948);
    expect(book.fallbacks).toHaveLength(4);
  });

  it("an empty catalogue (company not seeded) = the code prices, every SKU reported", () => {
    const book = buildPriceBook([]);
    expect(hostingPriceTable(book.tiers)).toEqual(hostingPriceTable());
    expect(book.fallbacks).toHaveLength(CORE_SKUS.length);
  });
});

describe("public catalogue shape", () => {
  const KEYS = ["engineRef", "exGst", "fulfilment", "function", "gstRate", "hsn", "inclGst", "name", "sku", "termMonths"];

  it("only the whitelisted fields — no cost, wholesale or margin even when the row carries them", () => {
    const leaky = rows().map((r) => ({ ...r, wholesale: 123, margin_pct: 40, partner_price: 77 }));
    const out = publicCatalog(buildPriceBook(leaky));
    expect(out).toHaveLength(10);
    for (const item of out) expect(Object.keys(item).sort()).toEqual(KEYS);
    expect(JSON.stringify(out)).not.toMatch(/wholesale|margin|cost|partner/i);
  });

  it("inclGst = 18% the way checkout rounds it; filter by function", () => {
    const out = publicCatalog(buildPriceBook(rows()), "hosting");
    expect(out.map((i) => i.sku)).toEqual(["HOST-STARTER-YR", "HOST-STARTER-MO", "HOST-STANDARD-YR", "HOST-STANDARD-MO", "HOST-PLUS-YR", "HOST-PLUS-MO"]);
    expect(out[0]).toMatchObject({ exGst: 600, inclGst: 708, gstRate: 18, termMonths: 12, engineRef: "Starter", fulfilment: "hosting_panel" });
    expect(publicCatalog(codePriceBook(), "mail")).toEqual([
      expect.objectContaining({ sku: "MAIL-ANUTECH-YR", exGst: 948, inclGst: 1119 }),
    ]);
    expect(publicCatalog(codePriceBook(), "ssl")).toHaveLength(3);
  });

  it("a row the owner marked not public is left out", () => {
    const r = rows().map((x) => (x.sku === "SSL-OVEV-YR" ? { ...x, is_public: false } : x));
    expect(publicCatalog(buildPriceBook(r)).map((i) => i.sku)).not.toContain("SSL-OVEV-YR");
  });
});

describe("CORE_SKUS = the R-1785 seed", () => {
  it("same SKUs, names, terms, HSN, fulfilment and engine refs as the migration", () => {
    const src = readFileSync("supabase/migrations/20261023114500_r1785_catalog_phase1.sql", "utf8");
    const block = src.slice(src.indexOf("with seed("), src.indexOf("ins as ("));
    const re = /^\s*\('([A-Z0-9-]+)',\s*'([^']+)',\s*'(\w+)',\s*'(\d+)',\s*(\d+),\s*'(\w+)',\s*(\d+),\s*'(\w+)',\s*(?:'([^']+)'|null)\)/gm;
    const seed = [...block.matchAll(re)].map((m) => ({
      sku: m[1], name: m[2], hsn: m[4], msrp: Number(m[5]), termMonths: Number(m[7]), fulfilment: m[8], engineRef: m[9] ?? null,
    }));
    expect(seed).toHaveLength(CORE_SKUS.length);
    expect(CORE_SKUS.map(({ sku, name, hsn, termMonths, fulfilment, engineRef }) => ({ sku, name, hsn, termMonths, fulfilment, engineRef })))
      .toEqual(seed.map(({ msrp: _m, ...rest }) => rest));
    for (const s of seed) expect(SEEDED[s.sku]).toBe(s.msrp);
  });
});
