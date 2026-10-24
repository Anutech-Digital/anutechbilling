/**
 * R-1645 — one vendor's bill must not switch off every other vendor's licence cost.
 *
 * Before: pnl.ts buildPnl took `billedCogs > 0` as "the period is billed" and dropped the
 * subscription estimate for EVERY vendor. A ₹500 Zoho bill made the whole Google licence cost
 * (₹70,340 here) disappear and the profit jumped by it.
 *
 * Now: the estimate switches off per vendor — a vendor with a bill in the period is costed from
 * its bills, every vendor without one keeps its estimate, and the basis says "mixed".
 */
import { describe, it, expect } from "vitest";
import { buildPnl, cogsBasisNote, vendorOfCogsCategory, type VendorInput } from "./pnl";
import { assemblePnl, type PnlRpcRow, type PnlMasters } from "./pnl-assemble";

const google: VendorInput = { vendor: "google", revenue: 108_552, billedCost: null, estimatedCost: 70_340, seats: 199, subscriptions: 9 };
const zoho: VendorInput = { vendor: "zoho", revenue: 10_000, billedCost: null, estimatedCost: 6_000, seats: 20, subscriptions: 2 };
/* Invoiced revenue = the book's revenue, so the ratio maths stays readable. */
const REVENUE = 118_552;

describe("R-1645: buildPnl — the estimate switches off per vendor", () => {
  it("a Zoho bill keeps Google's estimated licence cost", () => {
    const p = buildPnl({ revenue: REVENUE, expenses: 0, billedCogs: 500, billedByVendor: { zoho: 500 }, vendors: [google, zoho] });
    expect(p.billedLicenceCogs).toBe(500);
    expect(p.estimatedLicenceCogs).toBe(70_340);   // Google only — Zoho is costed from its bill
    expect(p.licenceCogs).toBe(70_840);
    expect(p.cogsBasis).toBe("mixed");
    expect(p.netProfit).toBe(REVENUE - 70_840);
    expect(cogsBasisNote(p)).toMatch(/vendor bills/i);
    expect(cogsBasisNote(p)).toMatch(/estimated/i);
    /* The vendor line shows the bill for Zoho and the estimate for Google. */
    expect(p.byVendor.find((v) => v.vendor === "zoho")!.cost).toBe(500);
    expect(p.byVendor.find((v) => v.vendor === "google")!.cost).toBe(70_340);
  });

  it("bills for every vendor in the book → billed, no estimate left", () => {
    const p = buildPnl({ revenue: REVENUE, expenses: 0, billedCogs: 66_000, billedByVendor: { google: 60_000, zoho: 6_000 }, vendors: [google, zoho] });
    expect(p.cogsBasis).toBe("billed");
    expect(p.estimatedLicenceCogs).toBe(0);
    expect(p.licenceCogs).toBe(66_000);
  });

  it("a bill not tied to a resold vendor (COGS-Other) adds to cost and switches nothing off", () => {
    const p = buildPnl({ revenue: REVENUE, expenses: 0, billedCogs: 1_200, billedByVendor: {}, vendors: [google, zoho] });
    expect(p.billedLicenceCogs).toBe(1_200);
    expect(p.estimatedLicenceCogs).toBe(76_340);
    expect(p.cogsBasis).toBe("mixed");
  });

  it("no bills → estimated, same rupees as before", () => {
    const p = buildPnl({ revenue: REVENUE, expenses: 0, billedCogs: null, billedByVendor: {}, vendors: [google, zoho] });
    expect(p.cogsBasis).toBe("estimated");
    expect(p.licenceCogs).toBe(76_340);
    expect(p.billedLicenceCogs).toBe(0);
  });

  it("without a per-vendor split (older database) the old global rule stays", () => {
    const p = buildPnl({ revenue: REVENUE, expenses: 0, billedCogs: 500, vendors: [google, zoho] });
    expect(p.cogsBasis).toBe("billed");
    expect(p.licenceCogs).toBe(500);
  });

  it("maps the bill categories to the subscription vendors", () => {
    expect(vendorOfCogsCategory("COGS-Workspace")).toBe("google");
    expect(vendorOfCogsCategory("COGS-M365")).toBe("microsoft");
    expect(vendorOfCogsCategory("COGS-Zoho")).toBe("zoho");
    expect(vendorOfCogsCategory("COGS-Other")).toBeNull();
    expect(vendorOfCogsCategory(null)).toBeNull();
  });
});

const emptyRow: PnlRpcRow = {
  inv_taxable: REVENUE, inv_tax: 0, revenue_count: 3, cn_taxable: 0, cn_tax: 0, dn_taxable: 0, dn_tax: 0,
  revenue_by_project: [], cogs: 0, cogs_count: 0, bills_gst: 0, expense_groups: [], itc_groups: [],
  bill_itc_groups: [], unassigned_by_category: [], project_expenses: [], commissions: 0, commissions_count: 0,
};
const masters: PnlMasters = { vendors: [google, zoho], allocations: [], monthlyGross: new Map(), projects: [], employeeNames: new Map() };
const range = { from: "2026-10-01", to: "2026-10-31" };

describe("R-1645: assemblePnl reads the bills per category from report_pnl", () => {
  it("a ₹500 Zoho bill: Google's estimate stays, profit does not jump", () => {
    const p = assemblePnl(range, {
      ...emptyRow, cogs: 500, cogs_count: 1,
      cogs_by_category: [{ category: "COGS-Zoho", subtotal: 500, n: 1 }],
    }, masters);
    expect(p.model.cogsBasis).toBe("mixed");
    expect(p.model.licenceCogs).toBe(70_840);
    expect(p.model.netProfit).toBe(REVENUE - 70_840);
  });

  it("blocked GST on a Zoho bill is part of Zoho's billed cost (R-1576), not a second estimate", () => {
    const p = assemblePnl(range, {
      ...emptyRow, cogs: 500, cogs_count: 1, bills_gst: 90,
      cogs_by_category: [{ category: "COGS-Zoho", subtotal: 500, n: 1 }],
      /* A proforma — its GST is never credit, so it is cost. */
      bill_itc_groups: [{ document_type: "proforma", category: "COGS-Zoho", vendorGstin: null, cgst: 45, sgst: 45, igst: 0, n: 1, ownStateCode: "06" }],
    }, masters);
    expect(p.cogs).toBe(590);
    expect(p.model.billedLicenceCogs).toBe(590);
    expect(p.model.estimatedLicenceCogs).toBe(70_340);
  });
});
