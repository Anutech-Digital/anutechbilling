/**
 * R-2624 — the P&L "Management (matched)" view spreads prepaid multi-month revenue over the months
 * it pays for. Owner's case: a ₹12,000 yearly invoice dated 1 Oct is ₹1,000 a month Oct..Sep in
 * Management and ₹12,000 in October in "As invoiced (GST)".
 */
import { describe, it, expect } from "vitest";
import { assemblePnl, type PnlRpcRow, type PnlMasters } from "./pnl-assemble";
import {
  matchedRevenueOrNull, revenueBasisLabel, revenueHint, withMatchedRevenue, type MatchedRevenueRow,
} from "./pnl-basis";
import { revenueDrillRows, drillTie, type RevenueLineRow } from "./pnl-drill";
import { onBasis } from "@/lib/queries/pnl";

const OCT = { from: "2026-10-01", to: "2026-10-31" };
const masters: PnlMasters = { vendors: [], allocations: [], monthlyGross: new Map(), projects: [], employeeNames: new Map() };

/** report_pnl for October: the ₹12,000 yearly invoice + a ₹500 one-time invoice, by invoice date. */
function octRow(): PnlRpcRow {
  return {
    inv_taxable: 12_500, inv_tax: 2_250, revenue_count: 2, cn_taxable: 0, cn_tax: 0, dn_taxable: 0, dn_tax: 0,
    revenue_by_project: [], cogs: 0, cogs_count: 0, bills_gst: 0, bill_itc_groups: [], cogs_by_category: [],
    revenue_by_product: [
      { family: "google", invoiced: 12_000, credit_notes: 0, debit_notes: 0, invoice_count: 1 },
      { family: "other", invoiced: 500, credit_notes: 0, debit_notes: 0, invoice_count: 1 },
    ],
    expense_groups: [], itc_groups: [], unassigned_by_category: [], project_expenses: [],
    commissions: 0, commissions_count: 0,
  };
}

/** report_pnl_revenue_matched for October: 1/12 of the yearly invoice + the one-time invoice. */
const octRevenue: MatchedRevenueRow = {
  inv_taxable: 1_500, cn_taxable: 0, dn_taxable: 0, revenue_count: 2,
  by_product: [
    { family: "google", invoiced: 1_000, credit_notes: 0, debit_notes: 0, invoice_count: 1 },
    { family: "other", invoiced: 500, credit_notes: 0, debit_notes: 0, invoice_count: 1 },
  ],
};
const octCogs = { cogs: 0, cogs_count: 0, cogs_by_category: [], bills: [] };

const LINES: RevenueLineRow[] = [
  { doc_kind: "invoice", doc_id: "INV-Y1", invoice_id: "INV-Y1", customer_name: "Cust Y", doc_date: "2026-10-01", status: "paid",
    family: "google", amount: 1_000, doc_amount: 12_000, service_from: "2026-10-01", service_to: "2027-09-30", basis: "term" },
  { doc_kind: "invoice", doc_id: "INV-1", invoice_id: "INV-1", customer_name: "Cust O", doc_date: "2026-10-12", status: "paid",
    family: "other", amount: 500, doc_amount: 500, service_from: "2026-10-01", service_to: "2026-10-31", basis: "invoice_month" },
];

describe("R-2624: Management revenue = 1/12 a month; GST view unchanged", () => {
  it("management swaps revenue only: card, parts and product rows from the matched RPC", () => {
    const m = onBasis(OCT, octRow(), masters, "management", octCogs, octRevenue);
    expect(m.revenue).toBe(1_500);
    expect(m.revenueCount).toBe(2);
    expect(m.revenueParts?.invoiced).toBe(1_500);
    expect(m.revenueByProduct?.map((f) => [f.family, f.net])).toEqual([["google", 1_000], ["other", 500]]);
    expect(m.revenueSpread).toBe(true);
    /* GST collected stays as invoiced in both views (it is the government's, on the invoice). */
    const g = onBasis(OCT, octRow(), masters, "gst", undefined, undefined);
    expect(m.outputGST).toBe(g.outputGST);
    expect(m.model.revenue).toBe(1_500);
  });

  it("gst untouched: the GST view is exactly assemblePnl of report_pnl and never reads the matched revenue", () => {
    const g = onBasis(OCT, octRow(), masters, "gst", undefined, octRevenue);
    expect(g).toEqual(assemblePnl(OCT, octRow(), masters));
    expect(g.revenue).toBe(12_500);
    expect(g.revenueSpread).toBeUndefined();
  });

  it("revenue rpc missing: Management keeps the matched COGS, revenue as invoiced, and says so", () => {
    const m = onBasis(OCT, octRow(), masters, "management", octCogs, null);
    expect(m.basis).toBe("management");
    expect(m.revenue).toBe(12_500);
    expect(m.managementRevenueUnavailable).toBe(true);
    expect(m.revenueSpread).toBeUndefined();
  });

  it("matchedRevenueOrNull: null only for a missing function; other errors throw", () => {
    expect(matchedRevenueOrNull({ data: null, error: { code: "PGRST202", message: "no fn" } })).toBeNull();
    expect(matchedRevenueOrNull({ data: null, error: { code: "42883", message: "no fn" } })).toBeNull();
    expect(() => matchedRevenueOrNull({ data: null, error: { code: "57014", message: "timeout" } })).toThrow("timeout");
    const r = matchedRevenueOrNull({ data: [{ ...octRevenue, inv_taxable: "1500" }], error: null });
    expect(r?.inv_taxable).toBe(1_500);
    expect(r?.by_product).toHaveLength(2);
  });

  it("withMatchedRevenue keeps output GST and the project split", () => {
    const row = withMatchedRevenue(octRow(), octRevenue);
    expect(row.inv_tax).toBe(2_250);
    expect(row.inv_taxable).toBe(1_500);
    expect(row.revenue_by_product).toEqual(octRevenue.by_product);
  });
});

describe("R-2624: the revenue drill in Management shows the service period and ties", () => {
  it("drill ties: rows = the card, each with 'for <period>' and the part of the invoice", () => {
    const rows = revenueDrillRows(LINES, {});
    expect(rows.map((r) => r.amount)).toEqual([1_000, 500]);
    expect(rows[0].sub).toContain("for Oct 2026 – Sep 2027");
    expect(rows[0].sub).toContain("part of ₹12,000 spread over the whole period");
    expect(rows[0].sub).toContain("subscription term");
    expect(rows[1].sub).not.toContain("part of");
    const total = rows.reduce((s, r) => s + r.amount, 0);
    expect(drillTie(total, 1_500)?.ties).toBe(true);
  });

  it("a product row opens only its family", () => {
    const rows = revenueDrillRows(LINES, { families: ["google"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(1_000);
  });

  it("GST rows (no period fields) read as before", () => {
    const rows = revenueDrillRows([{ ...LINES[1], doc_amount: undefined, service_from: undefined, service_to: undefined, basis: undefined }], {});
    expect(rows[0].sub).toBe("INV-1 · paid");
  });

  it("basis labels", () => {
    expect(revenueBasisLabel("billing_part")).toBe("billing part");
    expect(revenueBasisLabel("line_dates")).toBe("dates on the line");
    expect(revenueBasisLabel("term")).toBe("subscription term");
    expect(revenueBasisLabel("invoice_month")).toBe("invoice month");
    expect(revenueBasisLabel("mixed")).toBe("mixed periods");
  });
});

describe("R-2624: the line under Revenue never adds spread revenue to invoiced GST", () => {
  const money = (n: number) => `₹${n.toLocaleString("en-IN")}`;
  it("GST view: invoiced − GST, as before", () => {
    expect(revenueHint({ revenue: 12_000, outputGST: 2_160, revenueCount: 1 }, money)).toBe("₹14,160 invoiced − ₹2,160 GST · 1 invoice");
  });
  it("Management: says what the spread figure is", () => {
    expect(revenueHint({ revenue: 1_000, outputGST: 2_160, revenueCount: 1, revenueSpread: true }, money))
      .toBe("₹1,000 earned this period before GST · 1 invoice · prepaid terms spread over their months");
  });
});

describe("R-2624: the FY months in one call", () => {
  it("missing function → null (trend shows revenue as invoiced); rows keyed by month; other errors throw", async () => {
    const { fetchMatchedRevenueMonths } = await import("./pnl-basis");
    const rpcOf = (res: unknown) => ({ rpc: () => Promise.resolve(res) });
    expect(await fetchMatchedRevenueMonths(rpcOf({ data: null, error: { code: "PGRST202", message: "x" } }), { from: "2026-04-01", to: "2026-05-31" })).toBeNull();
    const m = await fetchMatchedRevenueMonths(rpcOf({ data: [{ month: "2026-05-01", ...octRevenue }], error: null }), { from: "2026-04-01", to: "2026-05-31" });
    expect(m?.get("2026-05")?.inv_taxable).toBe(1_500);
    expect(m?.has("2026-04")).toBe(false);
    await expect(fetchMatchedRevenueMonths(rpcOf({ data: null, error: { code: "57014", message: "timeout" } }), { from: "2026-04-01", to: "2026-05-31" })).rejects.toThrow("timeout");
  });
});
