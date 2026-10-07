import { describe, it, expect } from "vitest";
import {
  listPriceMrr, workspaceEdition, itemListMrr, withListPriceMrr, hasNoPrice, type ListPriceItem,
} from "./list-price-mrr";
import { buildPlanPriceIndex } from "./plan-match";
import { classifyRows } from "@/components/features/subscriptions/google-subs-parse";

/* The Anutech catalogue rows as read from the local DB on 7 Oct 2026 (prices are whatever
   the catalogue says — the code under test never carries a price of its own). */
const CATALOG: ListPriceItem[] = [
  { id: "GW-STR", name: "Google Workspace Business Starter", vendor: "google", kind: "main", msrp: 136,
    prices: { annual: { msrp: 136, wholesale: 110 }, monthly: { msrp: 170, wholesale: 138 } } },
  { id: "GW-STD", name: "Google Workspace Standard", vendor: "google", kind: "main", msrp: 736, prices: {} },
  { id: "GW-PLS", name: "Google Workspace Plus", vendor: "google", kind: "main", msrp: 1380,
    prices: { annual: { msrp: 1380, wholesale: 1150 } } },
  { id: "GW-ENT", name: "Google Workspace Enterprise", vendor: "google", kind: "main", msrp: 2400, prices: {} },
  { id: "GW-ENT-UP", name: "Google Workspace Enterprise (upgrade)", vendor: "google", kind: "addon", msrp: 9999, prices: {} },
  { id: "GV-STD", name: "Google Voice Standard", vendor: "google", kind: "main", msrp: 800, prices: {} },
  { id: "M365-BS", name: "Microsoft 365 Business Standard", vendor: "microsoft", kind: "main", msrp: 990, prices: {} },
  { id: "SUP-STD", name: "Standard", vendor: "support", kind: "main", msrp: 0, prices: { annual_total: { msrp: 9990 } } },
];

describe("R-317 bug: the Google importer wrote mrr 0 for a KNOWN edition", () => {
  it("old wiring — index keyed vendor|planKey, looked up by bare planKey — gives 0", () => {
    /* Exactly what import-google-subs-dialog.tsx did before R-317. */
    const idx = buildPlanPriceIndex(CATALOG.map((it) => ({ name: it.name, vendor: it.vendor, msrpPerSeatMonth: it.msrp })));
    const rows = classifyRows(
      [{ domain: "a.com", sku: "Google Workspace Business Starter", seats: 5, status: "active" }],
      { byNumber: new Map(), byDomain: new Map(), appSubDomains: new Set() },
      new Map(idx.prices),
    );
    expect(rows[0].estMrr).toBe(0);              // the defect, pinned
    /* The fix: list price × seats from the catalogue. */
    expect(withListPriceMrr(rows, CATALOG, "google")[0].estMrr).toBe(136 * 5);
  });
});

describe("workspaceEdition — never guesses", () => {
  it.each([
    ["Google Workspace Business Starter", "starter"],
    ["Business Starter", "starter"],
    ["Google Workspace · Business Starter (annual)", "starter"],
    ["Google Workspace Standard", "standard"],
    ["G Suite Business Plus", "plus"],
    ["Google Workspace Enterprise", "enterprise"],
  ])("%s → %s", (plan, ed) => expect(workspaceEdition(plan)).toBe(ed));

  it.each([
    "Google Workspace",            // the 145 local rows — no edition
    "Google Workspace Enterprise Standard",  // two editions
    "Google Voice Standard",       // a different product
    "Google Workspace Individual",
    "",
  ])("%s → null", (plan) => expect(workspaceEdition(plan)).toBeNull());
});

describe("listPriceMrr", () => {
  it("known edition → list price × seats (plan text)", () => {
    expect(listPriceMrr(CATALOG, { vendor: "google", plan: "Business Starter", seats: 2 }))
      .toEqual({ ok: true, mrr: 272, itemId: "GW-STR", via: "edition" });
    expect(listPriceMrr(CATALOG, { vendor: "google", plan: "Google Workspace Business Standard", seats: 3 }))
      .toEqual({ ok: true, mrr: 736 * 3, itemId: "GW-STD", via: "name" });
  });

  it("item_id wins over the plan text", () => {
    expect(listPriceMrr(CATALOG, { vendor: "google", plan: "Google Workspace", seats: 4, item_id: "GW-PLS" }))
      .toEqual({ ok: true, mrr: 1380 * 4, itemId: "GW-PLS", via: "item_id" });
  });

  it("exact catalogue name works for any vendor", () => {
    expect(listPriceMrr(CATALOG, { vendor: "microsoft", plan: "Microsoft 365 Business Standard", seats: 10 }))
      .toEqual({ ok: true, mrr: 9900, itemId: "M365-BS", via: "name" });
    expect(listPriceMrr(CATALOG, { vendor: "google", plan: "Google Voice Standard", seats: 1 }))
      .toMatchObject({ ok: true, itemId: "GV-STD" });
  });

  it("a year-total price is divided by 12, whole rupees", () => {
    expect(listPriceMrr(CATALOG, { vendor: "support", plan: "Standard", seats: 1 }))
      .toMatchObject({ ok: true, mrr: 833 });
  });

  it("unknown edition → not ok, MRR stays unknown (no guess)", () => {
    expect(listPriceMrr(CATALOG, { vendor: "google", plan: "Google Workspace", seats: 1 }))
      .toEqual({ ok: false, reason: "unknown_edition" });
    expect(listPriceMrr(CATALOG, { vendor: "google", plan: "Google Workspace Enterprise Plus", seats: 1 }))
      .toEqual({ ok: false, reason: "unknown_edition" });
    expect(withListPriceMrr([{ plan: "Google Workspace", seats: 1, estMrr: 0 }], CATALOG, "google")[0].estMrr).toBe(0);
  });

  it("addon rows are not an edition's price", () => {
    expect(listPriceMrr(CATALOG, { vendor: "google", plan: "Enterprise", seats: 1 }))
      .toMatchObject({ ok: true, itemId: "GW-ENT", mrr: 2400 });
  });

  it("two catalogue rows disagreeing → ambiguous", () => {
    const clash = [...CATALOG, { id: "GW-STR-2", name: "Google Workspace Starter", vendor: "google", kind: "main", msrp: 270, prices: {} }];
    expect(listPriceMrr(clash, { vendor: "google", plan: "Business Starter", seats: 1 }))
      .toEqual({ ok: false, reason: "ambiguous" });
  });

  it("unpriced / inactive rows and zero seats are refused", () => {
    expect(itemListMrr({ id: "x", name: "x", vendor: "google", msrp: 0, prices: {} }, 3)).toBeNull();
    const inactive = CATALOG.map((it) => (it.id === "GW-PLS" ? { ...it, is_active: false } : it));
    expect(listPriceMrr(inactive, { vendor: "google", plan: "Business Plus", seats: 1 }))
      .toEqual({ ok: false, reason: "no_catalog_price" });
    expect(listPriceMrr(CATALOG, { vendor: "google", plan: "Business Plus", seats: 0 }))
      .toEqual({ ok: false, reason: "no_seats" });
  });
});

describe("hasNoPrice — the Reports 'no price' count", () => {
  it("counts active rows at ₹0 only", () => {
    const subs = [
      { status: "active", mrr: 0 }, { status: "active", mrr: 0 }, { status: "active", mrr: 500 },
      { status: "paused", mrr: 0 }, { status: "cancelled", mrr: 0 },
    ];
    expect(subs.filter(hasNoPrice)).toHaveLength(2);
  });
});

describe("R-317: CSV import with no price column — known edition gets list × seats", () => {
  const custs = new Map([["c-1", { id: "cust-1", name: "One" }]]);
  const csv = (row: string) => `Customer Number,Item Name,Quantity,Domain Name\n${row}`;

  it("known edition → mrr = list × seats (was refused before R-317)", async () => {
    const { parseSubsCsv } = await import("@/components/features/subscriptions/import-subscriptions-dialog");
    const [r] = parseSubsCsv(csv("C-1,Google Workspace - Business Starter,4,one.com"), custs, new Map(), CATALOG);
    expect(r.error).toBeUndefined();
    expect(r.mrr).toBe(136 * 4);
    expect(r.listPriced).toBe(true);
  });

  it("unknown edition → still refused, with a reason, never a guessed price", async () => {
    const { parseSubsCsv } = await import("@/components/features/subscriptions/import-subscriptions-dialog");
    const [r] = parseSubsCsv(csv("C-1,Google Workspace,1,one.com"), custs, new Map(), CATALOG);
    expect(r.mrr).toBe(0);
    expect(r.error).toMatch(/no edition/);
  });

  it("a price in the file is never replaced by the list price", async () => {
    const { parseSubsCsv } = await import("@/components/features/subscriptions/import-subscriptions-dialog");
    const [r] = parseSubsCsv(
      "Customer Number,Item Name,Quantity,MRR (₹/month)\nC-1,Google Workspace Business Starter,4,999", custs, new Map(), CATALOG,
    );
    expect(r.mrr).toBe(999);
    expect(r.listPriced).toBe(false);
  });
});
