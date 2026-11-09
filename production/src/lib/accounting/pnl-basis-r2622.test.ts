/**
 * R-2622 — the P&L "Management (matched)" view: cost of goods in the month the licence was used.
 *
 * Owner's case (Oct 2026 P&L, 30 Oct): Google bill 7 Oct "Google Portal Bill (Aug 2026)" ₹10,33,617
 * + a small COGS-Other bill ₹451. As invoiced (GST) October carries the Google bill; Management
 * October does not (it is August's cost) and Google falls back to its subscription estimate.
 */
import { describe, it, expect } from "vitest";
import { assemblePnl, type PnlRpcRow, type PnlMasters } from "./pnl-assemble";
import {
  defaultPnlBasis, matchedRowOrNull, serviceBasisLabel, withMatchedCogs,
  type MatchedBill, type MatchedCogsRow,
} from "./pnl-basis";
import { lineTarget, licenceLineTarget, matchedCogsDrillRows, drillTie, type CogsBillRow } from "./pnl-drill";
import { licenceBreakdown, licenceEstimates } from "./pnl-compare";

const OCT = { from: "2026-10-01", to: "2026-10-31" };
const AUG = { from: "2026-08-01", to: "2026-08-31" };

const google = { vendor: "google", revenue: 100_000, billedCost: null, estimatedCost: 70_000, seats: 100, subscriptions: 5 };
const masters: PnlMasters = { vendors: [google], allocations: [], monthlyGross: new Map(), projects: [], employeeNames: new Map() };

/** report_pnl for October: both bills by bill date; ₹900 of GST on the small bill is not claimable. */
function octRow(): PnlRpcRow {
  return {
    inv_taxable: 200_000, inv_tax: 36_000, revenue_count: 4, cn_taxable: 0, cn_tax: 0, dn_taxable: 0, dn_tax: 0,
    revenue_by_project: [], cogs: 1_034_068, cogs_count: 2, bills_gst: 900,
    bill_itc_groups: [{ document_type: "proforma", category: "COGS-Other", vendorGstin: null, cgst: 0, sgst: 0, igst: 900, n: 1, ownStateCode: "07" }],
    cogs_by_category: [
      { category: "COGS-Other", subtotal: 451, n: 1 },
      { category: "COGS-Workspace", subtotal: 1_033_617, n: 1 },
    ],
    expense_groups: [], itc_groups: [], unassigned_by_category: [], project_expenses: [],
    commissions: 0, commissions_count: 0,
  };
}

const SMALL: MatchedBill = {
  id: "b-small", vendor_name: "Sidhshree", bill_no: "S-12", bill_date: "2026-10-12", category: "COGS-Other",
  subtotal: 451, service_from: "2026-10-01", service_to: "2026-10-31", basis: "bill_month", amount: 451,
};
const GOOGLE_AUG: MatchedBill = {
  id: "b-google", vendor_name: "Google", bill_no: "5667984259", bill_date: "2026-10-07", category: "COGS-Workspace",
  subtotal: 1_033_617, service_from: "2026-08-01", service_to: "2026-08-31", basis: "reference", amount: 1_033_617,
};
const octMatched: MatchedCogsRow = {
  cogs: 451, cogs_count: 1, cogs_by_category: [{ category: "COGS-Other", subtotal: 451, n: 1 }], bills: [SMALL],
};
const augMatched: MatchedCogsRow = {
  cogs: 1_033_617, cogs_count: 1, cogs_by_category: [{ category: "COGS-Workspace", subtotal: 1_033_617, n: 1 }], bills: [GOOGLE_AUG],
};
/** report_pnl for August: no bills dated in August. */
function augRow(): PnlRpcRow {
  return { ...octRow(), cogs: 0, cogs_count: 0, bills_gst: 0, bill_itc_groups: [], cogs_by_category: [] };
}

describe("R-2622: GST view unchanged, Management view moves the bill to its licence month", () => {
  it("gst view unchanged: assembling without the matched row is exactly today's P&L", () => {
    const before = assemblePnl(OCT, octRow(), masters);
    expect(before.cogs).toBe(1_034_068 + 900);
    expect(before.model.cogsBasis).toBe("billed");
    expect(before.model.licenceCogs).toBe(1_034_968);
  });

  it("aug bill moves: Management October has no Google bill — Google is estimated; August carries the bill", () => {
    const oct = assemblePnl(OCT, withMatchedCogs(octRow(), octMatched), masters);
    /* ₹451 billed + ₹900 GST not claimable (bill date, both views) + Google's estimate. */
    expect(oct.model.billedLicenceCogs).toBe(451 + 900);
    expect(oct.model.estimatedLicenceCogs).toBe(Math.round(200_000 * (70_000 / 100_000)));
    expect(oct.model.cogsBasis).toBe("mixed");
    /* Revenue, expenses and the GST snapshot are the same as the GST view. */
    const gst = assemblePnl(OCT, octRow(), masters);
    expect(oct.revenue).toBe(gst.revenue);
    expect(oct.inputGST).toBe(gst.inputGST);
    expect(oct.outputGST).toBe(gst.outputGST);
    expect(oct.itcBlocked).toBe(gst.itcBlocked);

    const aug = assemblePnl(AUG, withMatchedCogs(augRow(), augMatched), masters);
    expect(aug.model.billedLicenceCogs).toBe(1_033_617);
    expect(aug.model.estimatedLicenceCogs).toBe(0);
    expect(aug.model.cogsBasis).toBe("billed");
    expect(assemblePnl(AUG, augRow(), masters).model.billedLicenceCogs).toBe(0);
  });

  it("negative matched: a vendor credit netting to ≤ 0 keeps that vendor's estimate (same rule as GST view)", () => {
    const credit: MatchedCogsRow = {
      cogs: -5_000, cogs_count: 1, cogs_by_category: [{ category: "COGS-Workspace", subtotal: -5_000, n: 1 }],
      bills: [{ ...GOOGLE_AUG, subtotal: -5_000, amount: -5_000, service_from: "2026-10-01", service_to: "2026-10-31" }],
    };
    const p = assemblePnl(OCT, withMatchedCogs(augRow(), credit), masters);
    expect(p.model.estimatedLicenceCogs).toBe(140_000);
  });

  it("rpc missing falls back: only a missing function gives null; any other failure throws (never GST under the Management label)", () => {
    expect(matchedRowOrNull({ data: null, error: { code: "PGRST202", message: "not found" } })).toBeNull();
    expect(matchedRowOrNull({ data: null, error: { code: "42883", message: "function does not exist" } })).toBeNull();
    expect(() => matchedRowOrNull({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } })).toThrow(/timeout/);
    expect(matchedRowOrNull({ data: [], error: null })).toBeNull();
    expect(matchedRowOrNull({ data: [octMatched], error: null })).toEqual(octMatched);
  });

  it("default basis by role: accountant (CA) → GST; owner / manager → Management; unknown → GST", () => {
    expect(defaultPnlBasis("accountant")).toBe("gst");
    expect(defaultPnlBasis("owner")).toBe("management");
    expect(defaultPnlBasis("manager")).toBe("management");
    expect(defaultPnlBasis(undefined)).toBe("gst");
    expect(defaultPnlBasis(null)).toBe("gst");
  });

  it("basis labels: each way a month was decided reads in plain words", () => {
    expect(serviceBasisLabel("set")).toBe("set on the bill");
    expect(serviceBasisLabel("reference")).toBe("read from the bill text");
    expect(serviceBasisLabel("vendor_default")).toMatch(/month before the bill date/);
    expect(serviceBasisLabel("bill_month")).toBe("bill month");
  });
});

/** The bills dated in October as the drill reads them (for the GST-not-claimable row). */
const OCT_BILLS_BY_DATE: CogsBillRow[] = [
  { id: "b-google", vendor_name: "Google", bill_no: "5667984259", bill_date: "2026-10-07", subtotal: 1_033_617, category: "COGS-Workspace",
    cgst: 0, sgst: 0, igst: 186_051, document_type: "tax_invoice", vendor_gstin: "29AACCG0527D1Z8" },
  { id: "b-small", vendor_name: "Sidhshree", bill_no: "S-12", bill_date: "2026-10-12", subtotal: 451, category: "COGS-Other",
    cgst: 0, sgst: 0, igst: 900, document_type: "proforma", vendor_gstin: null },
];

describe("R-2622: the Management drill adds up to the card", () => {
  it("matched drill rows tie: bills by service month + GST not claimable + Google's estimate = Cost of goods", () => {
    const d = assemblePnl(OCT, withMatchedCogs(octRow(), octMatched), masters);
    const t = lineTarget("cogs", d);
    const rows = matchedCogsDrillRows(octMatched.bills, OCT_BILLS_BY_DATE, t, "07", OCT);
    const total = rows.reduce((s, r) => s + r.amount, 0);
    expect(drillTie(total, t.expected)).toEqual({ ties: true, diff: 0 });
    /* The Google bill (August's cost) is NOT listed in October. */
    expect(rows.find((r) => r.id === "b-google")).toBeUndefined();
    const small = rows.find((r) => r.id === "b-small")!;
    expect(small.sub).toContain("for Oct 2026");
    expect(small.sub).toContain("bill month");
    const gstRow = rows.find((r) => r.id === "gst:b-small")!;
    expect(gstRow.amount).toBe(900);
    expect(gstRow.sub).toMatch(/GST not claimable.*bill date/);
    expect(rows.some((r) => r.estimated && r.primary === "Google Workspace")).toBe(true);
  });

  it("matched drill rows tie for a vendor sub-line and show part of a multi-month bill", () => {
    const quarter: MatchedBill = { ...GOOGLE_AUG, service_from: "2026-07-01", service_to: "2026-09-30", basis: "set", subtotal: 3_000, amount: 1_000 };
    const m: MatchedCogsRow = { cogs: 1_000, cogs_count: 1, cogs_by_category: [{ category: "COGS-Workspace", subtotal: 1_000, n: 1 }], bills: [quarter] };
    const d = assemblePnl(AUG, withMatchedCogs(augRow(), m), masters);
    const line = licenceBreakdown(d, null).lines.find((l) => l.key === "lic:google")!;
    const t = licenceLineTarget(line, licenceEstimates(d));
    const rows = matchedCogsDrillRows(m.bills, [], t, "07", AUG);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(1_000);
    expect(rows[0].sub).toContain("for Jul–Sep 2026");
    expect(rows[0].sub).toContain("set on the bill");
    expect(drillTie(rows[0].amount, t.expected)!.ties).toBe(true);
  });

  it("blocked gst row ties on the GST view's sub-line split too (vendor filter applies to GST rows)", () => {
    const d = assemblePnl(OCT, withMatchedCogs(octRow(), octMatched), masters);
    const line = licenceBreakdown(d, null).lines.find((l) => l.key === "lic:other-bills")!;
    expect(line.now).toBe(451 + 900);
    const t = licenceLineTarget(line, licenceEstimates(d));
    const rows = matchedCogsDrillRows(octMatched.bills, OCT_BILLS_BY_DATE, t, "07", OCT);
    expect(drillTie(rows.reduce((s, r) => s + r.amount, 0), t.expected)!.ties).toBe(true);
  });

  it("a vendor whose matched amount nets to 0 or less has no line of its own — its rows open under Other vendor bills", () => {
    const credit: MatchedBill = { ...GOOGLE_AUG, subtotal: -300, amount: -300, service_from: "2026-10-01", service_to: "2026-10-31", basis: "set" };
    const m: MatchedCogsRow = {
      cogs: 451 - 300, cogs_count: 2,
      cogs_by_category: [{ category: "COGS-Other", subtotal: 451, n: 1 }, { category: "COGS-Workspace", subtotal: -300, n: 1 }],
      bills: [SMALL, credit],
    };
    const d = assemblePnl(OCT, withMatchedCogs(octRow(), m), masters);
    const lines = licenceBreakdown(d, null).lines;
    const other = lines.find((l) => l.key === "lic:other-bills")!;
    const t = licenceLineTarget(other, licenceEstimates(d));
    const rows = matchedCogsDrillRows(m.bills, OCT_BILLS_BY_DATE, t, "07", OCT);
    expect(rows.map((r) => r.id).sort()).toEqual(["b-google", "b-small", "gst:b-small"]);
    expect(drillTie(rows.reduce((s, r) => s + r.amount, 0), t.expected)!.ties).toBe(true);
    /* And the card as a whole still ties. */
    const all = lineTarget("cogs", d);
    const allRows = matchedCogsDrillRows(m.bills, OCT_BILLS_BY_DATE, all, "07", OCT);
    expect(drillTie(allRows.reduce((s, r) => s + r.amount, 0), all.expected)!.ties).toBe(true);
  });

  it("a month whose bills net to a credit: the card counts no billed cost, and the drill lists none (still ties)", () => {
    const credit: MatchedBill = { ...GOOGLE_AUG, subtotal: -5_000, amount: -5_000, service_from: "2026-10-01", service_to: "2026-10-31", basis: "set" };
    const m: MatchedCogsRow = { cogs: -5_000, cogs_count: 1, cogs_by_category: [{ category: "COGS-Workspace", subtotal: -5_000, n: 1 }], bills: [credit] };
    const d = assemblePnl(OCT, withMatchedCogs(augRow(), m), masters);
    const t = lineTarget("cogs", d);
    const rows = matchedCogsDrillRows(m.bills, [], t, "07", OCT);
    expect(rows.every((r) => r.estimated)).toBe(true);
    expect(drillTie(rows.reduce((s, r) => s + r.amount, 0), t.expected)!.ties).toBe(true);
  });
});
