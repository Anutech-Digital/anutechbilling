/**
 * R-1785 (Phase 1 of R-1784, one product catalog) — the `items` rows seeded by
 * 20261023114500_r1785_catalog_phase1.sql carry EXACTLY the rupees the code charges today.
 *
 * Until Phase 2 (R-1786) the site, cart and checkout still price hosting, the Anutech Mail
 * mailbox and SSL from code (LANDING_PLANS → hostingRate, MAILBOX_YR, CERTS). The catalogue
 * rows are the copy that will replace them, so the two must not drift in between: change a
 * price in code and this fails until a new migration moves the catalogue too (and the other
 * way round). It reads the migration's seed list as text — no database needed — and
 * supabase/tests/r1785_catalog_phase1.test.sql proves the same list lands in the table.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { LANDING_PLANS } from "@/site/lib/data/hosting-landing";
import { hostingRate, hostingPriceTable } from "@/lib/checkout/hosting-prices";
import { MAILBOX_YR } from "@/site/lib/data/domains-landing";
import { CERTS } from "@/site/lib/data/catalog";
import { billingUnitOf, unitYearMultiplier } from "@/lib/catalog/billing-unit";
import { headlinePrice } from "@/lib/catalog/headline-price";

const MIGRATION = "supabase/migrations/20261023114500_r1785_catalog_phase1.sql";

interface SeedRow {
  sku: string;
  name: string;
  vendor: string;
  hsn: string;
  msrp: number;
  unit: string;
  termMonths: number;
  fulfilment: string;
  engineRef: string | null;
}

/** The `values` rows of the seed CTE inside seed_core_catalog. */
function seedRows(): SeedRow[] {
  const src = readFileSync(MIGRATION, "utf8");
  const start = src.indexOf("with seed(");
  const end = src.indexOf("ins as (", start);
  expect(start, "seed CTE not found in the migration").toBeGreaterThan(0);
  const block = src.slice(start, end);
  const re =
    /^\s*\('([A-Z0-9-]+)',\s*'([^']+)',\s*'(\w+)',\s*'(\d+)',\s*(\d+),\s*'(\w+)',\s*(\d+),\s*'(\w+)',\s*(?:'([^']+)'|null)\)/gm;
  return [...block.matchAll(re)].map((m) => ({
    sku: m[1], name: m[2], vendor: m[3], hsn: m[4], msrp: Number(m[5]), unit: m[6],
    termMonths: Number(m[7]), fulfilment: m[8], engineRef: m[9] ?? null,
  }));
}

const rows = seedRows();
const bySku = new Map(rows.map((r) => [r.sku, r]));

describe("R-1785 catalogue seed = the prices the code charges", () => {
  it("reads every seed row (a parser that read nothing would pass everything)", () => {
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((r) => r.sku)).size).toBe(rows.length);
  });

  it.each(LANDING_PLANS.map((p) => p.planId))("hosting %s — yearly and monthly = hostingRate", (tier) => {
    const plan = LANDING_PLANS.find((p) => p.planId === tier)!;
    for (const [cycle, yearly, months, unit] of [["YR", true, 12, "unit_year"], ["MO", false, 1, "unit_month"]] as const) {
      const row = bySku.get(`HOST-${tier.toUpperCase()}-${cycle}`);
      expect(row, `HOST-${tier.toUpperCase()}-${cycle} missing from the seed`).toBeDefined();
      expect(row!.msrp).toBe(hostingRate(tier, yearly));
      expect(row!.termMonths).toBe(months);
      expect(row!.unit).toBe(unit);
      expect(row!.vendor).toBe("hosting");
      expect(row!.fulfilment).toBe("hosting_panel");
      // DirectAdmin package name = the plan's display name (Starter / Standard / Plus).
      expect(row!.engineRef).toBe(plan.name);
    }
  });

  it("matches the table the hosting panel reads (/api/public/hosting-prices)", () => {
    for (const p of hostingPriceTable()) {
      expect(bySku.get(`HOST-${p.id.toUpperCase()}-YR`)?.msrp).toBe(p.yearly.exGst);
      expect(bySku.get(`HOST-${p.id.toUpperCase()}-MO`)?.msrp).toBe(p.monthly.exGst);
    }
  });

  it("the known figures, written out (600/100, 1500/250, 2246/374 — R-1785 card)", () => {
    expect([...rows].filter((r) => r.vendor === "hosting").map((r) => [r.sku, r.msrp])).toEqual([
      ["HOST-STARTER-YR", 600], ["HOST-STARTER-MO", 100],
      ["HOST-STANDARD-YR", 1500], ["HOST-STANDARD-MO", 250],
      ["HOST-PLUS-YR", 2246], ["HOST-PLUS-MO", 374],
    ]);
  });

  it("Anutech Mail mailbox = MAILBOX_YR (₹948 a year)", () => {
    const row = bySku.get("MAIL-ANUTECH-YR");
    expect(row?.msrp).toBe(MAILBOX_YR);
    expect(row?.msrp).toBe(948);
    expect(row?.termMonths).toBe(12);
    expect(row?.unit).toBe("unit_year");
  });

  it("every SSL certificate with a price = CERTS", () => {
    const sslSku: Record<string, string> = {
      "Positive SSL": "SSL-POSITIVE-YR",
      Wildcard: "SSL-WILDCARD-YR",
      "OV / EV": "SSL-OVEV-YR",
    };
    const priced = CERTS.filter((c) => Number(c.price.replace(/[^\d]/g, "")) > 0);
    expect(priced.length).toBe(3);
    for (const c of priced) {
      const sku = sslSku[c.name];
      expect(sku, `no SKU mapped for certificate "${c.name}" — add it to the seed and to this map`).toBeDefined();
      const rupees = Number(c.price.replace(/[^\d]/g, ""));
      expect(bySku.get(sku)?.msrp).toBe(rupees);
      if (c.addPrice !== null) expect(bySku.get(sku)?.msrp).toBe(c.addPrice);
      expect(c.unit).toBe("/yr");
      expect(bySku.get(sku)?.termMonths).toBe(12);
    }
    expect(rows.filter((r) => r.sku.startsWith("SSL-")).length).toBe(priced.length);
  });

  it("every row is whole rupees and is shown / quoted for its own term (R-526 billing unit)", () => {
    for (const r of rows) {
      expect(Number.isInteger(r.msrp)).toBe(true);
      const item = { msrp: r.msrp, vendor: r.vendor, item_type: "subscription", prices: { billing_unit: r.unit } };
      // What a quote line charges for one year of this row = the term price × charges a year.
      const unit = billingUnitOf(item);
      expect(unit).toBe(r.unit);
      expect(unitYearMultiplier(unit)).toBe(12 / r.termMonths);
      expect(headlinePrice(item)).toEqual({ amount: r.msrp, unit: r.termMonths === 12 ? "yr" : "mo" });
    }
  });

  it("no seeded name is one the cart's hosting-line lookup matches ('<tier> hosting')", () => {
    const cartNames = new Set(LANDING_PLANS.map((p) => `${p.planId} hosting`));
    for (const r of rows) expect(cartNames.has(r.name.trim().toLowerCase())).toBe(false);
  });
});
