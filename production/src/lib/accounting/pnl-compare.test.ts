/**
 * R-1832 (compare) + R-1833 (statement sub-lines) — the P&L page's comparison and breakdown maths.
 */
import { describe, it, expect } from "vitest";
import {
  previousPeriod, samePeriodLastYear, compareRange, wholeMonths, periodChange, changeTone,
  formatChange, signedRupee, rangeLabel, periodName, runningNote, parseCompareMode,
  opexBreakdown, revenueBreakdown, licenceBreakdown, subSum, splitByWeight, pnlCsv, MAX_SUB_LINES,
} from "./pnl-compare";
import { assemblePnl, type PnlRpcRow, type PnlMasters, type PnLNumbers } from "./pnl-assemble";
import type { VendorInput } from "./pnl";

describe("R-1832 period maths", () => {
  it.each([
    // [label, from, to, previous, last year]
    ["month", "2026-10-01", "2026-10-31", ["2026-09-01", "2026-09-30"], ["2025-10-01", "2025-10-31"]],
    ["month after a 31-day month", "2026-09-01", "2026-09-30", ["2026-08-01", "2026-08-31"], ["2025-09-01", "2025-09-30"]],
    ["April → March across the FY boundary", "2026-04-01", "2026-04-30", ["2026-03-01", "2026-03-31"], ["2025-04-01", "2025-04-30"]],
    ["January → December across the year", "2027-01-01", "2027-01-31", ["2026-12-01", "2026-12-31"], ["2026-01-01", "2026-01-31"]],
    ["quarter Q1 FY", "2026-04-01", "2026-06-30", ["2026-01-01", "2026-03-31"], ["2025-04-01", "2025-06-30"]],
    ["quarter Q3", "2026-10-01", "2026-12-31", ["2026-07-01", "2026-09-30"], ["2025-10-01", "2025-12-31"]],
    ["FY", "2026-04-01", "2027-03-31", ["2025-04-01", "2026-03-31"], ["2025-04-01", "2026-03-31"]],
    ["leap month Feb 2028", "2028-02-01", "2028-02-29", ["2028-01-01", "2028-01-31"], ["2027-02-01", "2027-02-28"]],
    ["March 2028 → leap February", "2028-03-01", "2028-03-31", ["2028-02-01", "2028-02-29"], ["2027-03-01", "2027-03-31"]],
    ["custom 10 days", "2026-10-11", "2026-10-20", ["2026-10-01", "2026-10-10"], ["2025-10-11", "2025-10-20"]],
    ["custom across leap day", "2028-03-01", "2028-03-10", ["2028-02-20", "2028-02-29"], ["2027-03-01", "2027-03-10"]],
    ["custom on leap day", "2028-02-29", "2028-02-29", ["2028-02-28", "2028-02-28"], ["2027-02-28", "2027-02-28"]],
    ["custom one day", "2026-10-24", "2026-10-24", ["2026-10-23", "2026-10-23"], ["2025-10-24", "2025-10-24"]],
  ] as const)("%s", (_l, from, to, prev, yoy) => {
    expect(previousPeriod({ from, to })).toEqual({ from: prev[0], to: prev[1] });
    expect(samePeriodLastYear({ from, to })).toEqual({ from: yoy[0], to: yoy[1] });
  });

  it("compareRange: none → null", () => {
    expect(compareRange({ from: "2026-10-01", to: "2026-10-31" }, "none")).toBeNull();
    expect(compareRange({ from: "2026-10-01", to: "2026-10-31" }, "prev")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("wholeMonths only for 1st → last day", () => {
    expect(wholeMonths({ from: "2026-04-01", to: "2027-03-31" })).toBe(12);
    expect(wholeMonths({ from: "2026-04-02", to: "2026-04-30" })).toBeNull();
    expect(wholeMonths({ from: "2026-04-01", to: "2026-04-29" })).toBeNull();
  });

  it("parseCompareMode falls back to none", () => {
    expect(parseCompareMode("prev")).toBe("prev");
    expect(parseCompareMode("yoy")).toBe("yoy");
    expect(parseCompareMode("x")).toBe("none");
    expect(parseCompareMode(null)).toBe("none");
  });

  it("labels", () => {
    expect(rangeLabel({ from: "2026-10-01", to: "2026-10-31" })).toBe("1–31 Oct 2026");
    expect(rangeLabel({ from: "2026-09-01", to: "2026-10-31" })).toBe("1 Sep – 31 Oct 2026");
    expect(rangeLabel({ from: "2026-04-01", to: "2027-03-31" })).toBe("1 Apr 2026 – 31 Mar 2027");
    expect(periodName({ from: "2026-09-01", to: "2026-09-30" })).toBe("Sep 2026");
    expect(periodName({ from: "2026-07-01", to: "2026-09-30" })).toBe("Jul–Sep 2026");
    expect(periodName({ from: "2025-04-01", to: "2026-03-31" })).toBe("FY 2025-26");
    expect(periodName({ from: "2026-10-01", to: "2026-10-10" })).toBe("1–10 Oct 2026");
  });

  it("runningNote only while today is inside the range", () => {
    expect(runningNote({ from: "2026-10-01", to: "2026-10-31" }, "2026-10-24")).toBe("runs to today — 24 of 31 days so far");
    expect(runningNote({ from: "2026-09-01", to: "2026-09-30" }, "2026-10-24")).toBeNull();
  });
});

describe("R-1832 change", () => {
  it("% against the base, one decimal", () => {
    expect(periodChange(135_000, 120_000)).toEqual({ abs: 15_000, pct: 12.5 });
    expect(periodChange(90, 120)).toEqual({ abs: -30, pct: -25 });
    /* a loss that shrank: base is |was| */
    expect(periodChange(-50, -100)).toEqual({ abs: 50, pct: 50 });
  });

  it("zero base → % is null, shown as —, never Infinity or NaN", () => {
    expect(periodChange(5_000, 0)).toEqual({ abs: 5_000, pct: null });
    expect(periodChange(0, 0)).toEqual({ abs: 0, pct: null });
    const s = formatChange(periodChange(5_000, 0));
    expect(s).toBe("▲ ₹5,000 (—)");
    expect(s).not.toMatch(/Infinity|NaN/);
    expect(formatChange(periodChange(0, 0))).toBe("No change");
    expect(formatChange(periodChange(135_000, 120_000))).toBe("▲ ₹15,000 (12.5%)");
    expect(formatChange(periodChange(90_000, 120_000))).toBe("▼ ₹30,000 (25%)");
  });

  it("signedRupee: −₹ for negatives, never ₹-x or −₹0; a cost reads with a minus", () => {
    expect(signedRupee(-30_000)).toBe("−₹30,000");
    expect(signedRupee(500, true)).toBe("−₹500");
    expect(signedRupee(-500, true)).toBe("₹500");
    expect(signedRupee(0, true)).toBe("₹0");
  });

  it("colour by meaning: revenue/profit up is good, cost up is bad", () => {
    expect(changeTone(100, "more-is-good")).toBe("emerald");
    expect(changeTone(-100, "more-is-good")).toBe("rose");
    expect(changeTone(100, "more-is-bad")).toBe("rose");
    expect(changeTone(-100, "more-is-bad")).toBe("emerald");
    expect(changeTone(0, "more-is-good")).toBe("muted");
    expect(changeTone(100, "neutral")).toBe("muted");
  });
});

/* ── R-1833: a P&L from assemblePnl, so the sub-lines are checked against the real totals ── */

const GSTIN = "07AAACA1234A1Z5";
function row(over: Partial<PnlRpcRow> = {}): PnlRpcRow {
  return {
    inv_taxable: 500_000, inv_tax: 90_000, revenue_count: 5,
    cn_taxable: 20_000, cn_tax: 3_600, dn_taxable: 5_000, dn_tax: 900,
    revenue_by_project: [{ project_id: "p1", revenue: 120_000 }],
    cogs: 0, cogs_count: 0, bills_gst: 0, bill_itc_groups: [], cogs_by_category: [],
    expense_groups: [
      { category: "Rent", vendor_name: "Landlord", month: "2026-09", amount: 118_000, n: 1 },
      { category: "Salaries", vendor_name: null, month: "2026-09", amount: 90_000, n: 3 },
      { category: "Software", vendor_name: "Zoho", month: "2026-09", amount: 11_800, n: 2 },
    ],
    itc_groups: [
      { bill_type: "gst", category: "Rent", vendorGstin: GSTIN, gst_paid: 18_000, n: 1 },
      { bill_type: "gst", category: "Software", vendorGstin: GSTIN, gst_paid: 1_800, n: 1 },
    ],
    unassigned_by_category: [], project_expenses: [],
    commissions: 0, commissions_count: 0,
    ...over,
  };
}
const v = (vendor: string, revenue: number, estimatedCost: number): VendorInput =>
  ({ vendor, revenue, billedCost: null, estimatedCost, seats: 1, subscriptions: 1 });
const masters = (vendors: VendorInput[] = []): PnlMasters =>
  ({ vendors, allocations: [], monthlyGross: new Map(), projects: [], employeeNames: new Map() });
const SEP = { from: "2026-09-01", to: "2026-09-30" };
const pnl = (over: Partial<PnlRpcRow> = {}, vendors: VendorInput[] = []): PnLNumbers => assemblePnl(SEP, row(over), masters(vendors));

describe("R-1833 sub-lines add up to their parent line", () => {
  it("revenue: sales + projects − credit notes + debit notes = Revenue", () => {
    const d = pnl();
    const { lines } = revenueBreakdown(d);
    expect(lines.map((l) => l.key)).toEqual(["rev:sales", "rev:projects", "less:cn", "add:dn"]);
    expect(subSum(lines, "now")).toBe(d.model.revenue);
    expect(d.model.revenue).toBe(485_000);
  });

  it("revenue with no credit notes has no credit-note line", () => {
    const d = pnl({ cn_taxable: 0, dn_taxable: 0 });
    const { lines } = revenueBreakdown(d);
    expect(lines.find((l) => l.kind === "less")).toBeUndefined();
    expect(subSum(lines, "now")).toBe(d.model.revenue);
  });

  it("operating expenses: categories (GST paid) − GST claimed back = Operating expenses", () => {
    const d = pnl();
    const { lines } = opexBreakdown(d);
    expect(lines[0]).toMatchObject({ label: "Rent", now: 118_000 });   // largest first
    expect(lines.find((l) => l.key === "less:gst")?.now).toBe(19_800);
    expect(subSum(lines, "now")).toBe(d.expenses - d.model.projectCost);
  });

  it("licence cost, fully billed per vendor + other bills = licence cost", () => {
    const d = pnl({
      cogs: 70_000, cogs_count: 3,
      cogs_by_category: [
        { category: "COGS-Workspace", subtotal: 40_000, n: 1 },
        { category: "COGS-M365", subtotal: 20_000, n: 1 },
        { category: "COGS-Other", subtotal: 10_000, n: 1 },
      ],
    });
    const { lines } = licenceBreakdown(d);
    expect(lines.map((l) => [l.label, l.now, !!l.estimated])).toEqual([
      ["Google Workspace", 40_000, false], ["Microsoft 365", 20_000, false], ["Other vendor bills", 10_000, false],
    ]);
    expect(subSum(lines, "now")).toBe(d.model.licenceCogs);
  });

  it("licence cost partly estimated (R-1645 mixed): billed vendor + estimated vendors = licence cost", () => {
    const d = pnl(
      { cogs: 40_000, cogs_count: 1, cogs_by_category: [{ category: "COGS-Workspace", subtotal: 40_000, n: 1 }] },
      [v("google", 200_000, 120_000), v("microsoft", 100_000, 70_001), v("zoho", 50_000, 33_333)],
    );
    expect(d.model.cogsBasis).toBe("mixed");
    const { lines } = licenceBreakdown(d);
    expect(lines.find((l) => l.label === "Google Workspace")?.estimated).toBeFalsy();
    expect(lines.filter((l) => l.estimated).map((l) => l.label).sort()).toEqual(["Microsoft 365", "Zoho"]);
    expect(subSum(lines, "now")).toBe(d.model.licenceCogs);
  });

  it("splitByWeight adds up exactly", () => {
    const s = splitByWeight(100, [{ key: "a", w: 1 }, { key: "b", w: 1 }, { key: "c", w: 1 }]);
    expect([...s.values()].reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("more than 8 categories: top 7 + Other, still adding up; Show all lists every one", () => {
    const groups = Array.from({ length: 11 }, (_, i) => ({
      category: `Cat ${String(i).padStart(2, "0")}`, vendor_name: null, month: "2026-09", amount: 1_000 * (i + 1), n: 1,
    }));
    const d = pnl({ expense_groups: groups, itc_groups: [] });
    const short = opexBreakdown(d);
    expect(short.lines).toHaveLength(MAX_SUB_LINES);
    expect(short.lines[0].label).toBe("Cat 10");
    expect(short.lines[7]).toMatchObject({ kind: "other", label: "Other (4 categories)", now: 10_000 });
    expect(subSum(short.lines, "now")).toBe(d.expenses);
    expect(short.itemCount).toBe(11);
    const all = opexBreakdown(d, null, { showAll: true });
    expect(all.lines).toHaveLength(11);
    expect(subSum(all.lines, "now")).toBe(d.expenses);
  });

  it("compare: a category in only one period shows with ₹0 on the other side; both sides add up", () => {
    const cur = pnl();
    const prev = pnl({
      expense_groups: [
        { category: "Rent", vendor_name: null, month: "2026-08", amount: 100_000, n: 1 },
        { category: "Travel", vendor_name: null, month: "2026-08", amount: 7_000, n: 1 },
      ],
      itc_groups: [],
    });
    const { lines } = opexBreakdown(cur, prev);
    expect(lines.find((l) => l.label === "Travel")).toMatchObject({ now: 0, was: 7_000 });
    expect(lines.find((l) => l.label === "Salaries")).toMatchObject({ now: 90_000, was: 0 });
    expect(subSum(lines, "now")).toBe(cur.expenses);
    expect(subSum(lines, "was")).toBe(prev.expenses);
    const rev = revenueBreakdown(cur, pnl({ revenue_by_project: [], cn_taxable: 0 }));
    expect(subSum(rev.lines, "was")).toBe(475_000 + 30_000);
  });
});

describe("R-1832/R-1833 CSV", () => {
  it("without compare: two columns; sub-rows add up to their parent row", () => {
    const d = pnl();
    const { headers, rows } = pnlCsv(d, SEP);
    expect(headers).toEqual(["Line", "Amount (INR)"]);
    const idx = rows.findIndex((r) => r[0] === "Operating expenses");
    const subs = [];
    for (let i = idx + 1; String(rows[i][0]).startsWith("  "); i++) subs.push(rows[i][1] as number);
    expect(subs.reduce((a, b) => a + b, 0)).toBe(rows[idx][1]);
    expect(rows.some((r) => r[0] === "  Rent")).toBe(true);
    expect(rows.some((r) => r[0] === "  Less: credit notes" && r[1] === -20_000)).toBe(true);
  });

  it("with compare: compare amount, change ₹ and change %", () => {
    const cur = pnl();
    const prev = pnl({ inv_taxable: 400_000, revenue_by_project: [], cn_taxable: 0, dn_taxable: 0 });
    const { headers, rows } = pnlCsv(cur, SEP, { data: prev, range: { from: "2026-08-01", to: "2026-08-31" } });
    expect(headers).toEqual(["Line", "Amount (INR)", "Compare amount (INR)", "Change (INR)", "Change %"]);
    expect(rows[0]).toEqual(["Period", "2026-09-01 to 2026-09-30", "2026-08-01 to 2026-08-31", "", ""]);
    expect(rows.find((r) => r[0] === "Revenue")).toEqual(["Revenue", 485_000, 400_000, 85_000, 21.3]);
    expect(rows.find((r) => r[0] === "  Software projects")).toEqual(["  Software projects", 120_000, 0, 120_000, "—"]);
  });
});

/* ── R-1835: Revenue by what was sold (report_pnl_revenue_by_product) ── */

describe("R-1835 revenue sub-lines by product", () => {
  /* Adds up to row(): invoiced 5,00,000 · credit notes 20,000 · debit notes 5,000. */
  const byProduct: PnlRpcRow["revenue_by_product"] = [
    { family: "domain", invoiced: 5_000, credit_notes: 0, debit_notes: 0, invoice_count: 1 },
    { family: "google", invoiced: 300_000, credit_notes: 15_000, debit_notes: 0, invoice_count: 3 },
    { family: "hosting", invoiced: 15_000, credit_notes: 5_000, debit_notes: 0, invoice_count: 2 },
    { family: "microsoft", invoiced: 60_000, credit_notes: 0, debit_notes: 0, invoice_count: 1 },
    { family: "projects", invoiced: 120_000, credit_notes: 0, debit_notes: 5_000, invoice_count: 1 },
  ];

  it("one line per product, each net of its own notes, largest first — no separate note lines", () => {
    const d = pnl({ revenue_by_product: byProduct });
    const { lines } = revenueBreakdown(d);
    expect(lines.map((l) => [l.label, l.now, l.kind])).toEqual([
      ["Google Workspace", 285_000, "item"],
      ["Software projects", 125_000, "item"],
      ["Microsoft 365", 60_000, "item"],
      ["Hosting", 10_000, "item"],
      ["Domains", 5_000, "item"],
    ]);
    expect(subSum(lines, "now")).toBe(d.model.revenue);
    expect(d.model.revenue).toBe(485_000);
  });

  it("parts that do not add up to report_pnl are not shown — R-1833 lines instead", () => {
    const off = byProduct!.map((r) => (r.family === "google" ? { ...r, invoiced: r.invoiced + 1 } : r));
    const d = pnl({ revenue_by_product: off });
    expect(d.revenueByProduct).toBeNull();
    expect(revenueBreakdown(d).lines.map((l) => l.label)).toEqual([
      "Subscriptions, licences & other sales", "Software projects", "Less: credit notes", "Add: debit notes",
    ]);
  });

  it("compare: a product in only one period shows ₹0 on the other side; both sides add up", () => {
    const cur = pnl({ revenue_by_product: byProduct });
    const prev = pnl({
      inv_taxable: 400_000, cn_taxable: 0, dn_taxable: 0, revenue_by_project: [],
      revenue_by_product: [
        { family: "google", invoiced: 390_000, credit_notes: 0, debit_notes: 0, invoice_count: 4 },
        { family: "zoho", invoiced: 10_000, credit_notes: 0, debit_notes: 0, invoice_count: 1 },
      ],
    });
    const { lines } = revenueBreakdown(cur, prev);
    expect(lines.find((l) => l.label === "Google Workspace")).toMatchObject({ now: 285_000, was: 390_000 });
    expect(lines.find((l) => l.label === "Zoho")).toMatchObject({ now: 0, was: 10_000 });
    expect(lines.find((l) => l.label === "Microsoft 365")).toMatchObject({ now: 60_000, was: 0 });
    expect(subSum(lines, "now")).toBe(cur.model.revenue);
    expect(subSum(lines, "was")).toBe(prev.model.revenue);
  });

  it("compare with an older period that has no split: each side still adds up to its Revenue", () => {
    const cur = pnl({ revenue_by_product: byProduct });
    const prev = pnl({ inv_taxable: 400_000, cn_taxable: 8_000, dn_taxable: 0, revenue_by_project: [] });
    const { lines } = revenueBreakdown(cur, prev);
    expect(lines.find((l) => l.key === "less:cn")).toMatchObject({ now: 0, was: 8_000 });
    expect(subSum(lines, "now")).toBe(485_000);
    expect(subSum(lines, "was")).toBe(392_000);
  });

  it("a product below zero (a credit note on an earlier month's invoice) stays a minus line", () => {
    const d = pnl({
      inv_taxable: 10_000, cn_taxable: 3_000, dn_taxable: 0, revenue_by_project: [],
      revenue_by_product: [
        { family: "hosting", invoiced: 10_000, credit_notes: 0, debit_notes: 0, invoice_count: 1 },
        { family: "google", invoiced: 0, credit_notes: 3_000, debit_notes: 0, invoice_count: 0 },
      ],
    });
    const { lines } = revenueBreakdown(d);
    expect(lines.map((l) => [l.label, l.now])).toEqual([["Hosting", 10_000], ["Google Workspace", -3_000]]);
    expect(subSum(lines, "now")).toBe(7_000);
  });

  it("CSV: a row per product under Revenue, adding up to it, with compare columns", () => {
    const cur = pnl({ revenue_by_product: byProduct });
    const prev = pnl({
      inv_taxable: 400_000, cn_taxable: 0, dn_taxable: 0, revenue_by_project: [],
      revenue_by_product: [{ family: "google", invoiced: 400_000, credit_notes: 0, debit_notes: 0, invoice_count: 4 }],
    });
    const { rows } = pnlCsv(cur, SEP, { data: prev, range: { from: "2026-08-01", to: "2026-08-31" } });
    const idx = rows.findIndex((r) => r[0] === "Revenue");
    const subs: (string | number)[][] = [];
    for (let i = idx + 1; String(rows[i][0]).startsWith("  "); i++) subs.push(rows[i]);
    expect(subs.map((r) => r[0])).toEqual([
      "  Google Workspace", "  Software projects", "  Microsoft 365", "  Hosting", "  Domains",
    ]);
    expect(subs[0]).toEqual(["  Google Workspace", 285_000, 400_000, -115_000, -28.7]);
    expect(subs.reduce((s, r) => s + (r[1] as number), 0)).toBe(rows[idx][1]);
    expect(subs.reduce((s, r) => s + (r[2] as number), 0)).toBe(rows[idx][2]);
    expect(rows.some((r) => r[0] === "  Less: credit notes")).toBe(false);
  });
});
