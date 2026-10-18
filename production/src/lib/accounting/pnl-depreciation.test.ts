/**
 * R-1578 — a ₹1,20,000 laptop bought as an 'Equipment' expense and turned into a fixed asset.
 *
 * Before: report_pnl kept the whole ₹1,20,000 as a cost AND the Balance Sheet carried the laptop
 * at cost — one rupee in two places; the P&L had no Depreciation line at all; the Trial Balance
 * had neither the depreciation expense nor accumulated depreciation.
 *
 * After (this file + supabase/tests/r1578_capitalised_expense_pnl.test.sql for the SQL half):
 *   · the P&L for a period carries only that period's depreciation (IT Act WDV from the register,
 *     spread over the days in use), not the purchase;
 *   · the Balance Sheet shows the net block (cost − depreciation charged so far);
 *   · the Trial Balance shows cost, accumulated depreciation and the year's Depreciation, and
 *     turning the expense into an asset does not move its Difference line.
 */
import { describe, it, expect } from "vitest";
import { assemblePnl, type PnlRpcRow, type PnlMasters } from "./pnl-assemble";
import { balanceSheetFromRpc, type BalanceSheetRpcRow } from "./report-rpc";
import { buildTrialBalance } from "./trial-balance";
import { depreciationInFy, type AssetLike } from "./depreciation";

const laptop: AssetLike & { emi_purchase_id: null } = {
  id: "fa1", name: "Dell laptop", block: "computers", cost: 120_000, put_to_use: "2026-10-05", emi_purchase_id: null,
};

/* report_pnl's answer. `withLaptop` = the bug (or the period before the asset was made): the
   expense is a cost. Without it = what the fixed SQL returns once the asset exists. */
function pnlRow(withLaptop: boolean): PnlRpcRow {
  const groups = [
    { category: "Office Rent", vendor_name: "Landlord", month: "2026-10", amount: 5_000, n: 1 },
    ...(withLaptop ? [{ category: "Equipment", vendor_name: "Laptop Shop", month: "2026-10", amount: 120_000, n: 1 }] : []),
  ];
  return {
    inv_taxable: 300_000, inv_tax: 54_000, revenue_count: 3,
    cn_taxable: 0, cn_tax: 0, dn_taxable: 0, dn_tax: 0, revenue_by_project: [],
    cogs: 0, cogs_count: 0, bills_gst: 0,
    expense_groups: groups, itc_groups: [], bill_itc_groups: [],
    unassigned_by_category: groups.map((g) => ({ category: g.category, amount: g.amount })),
    project_expenses: [], commissions: 0, commissions_count: 0,
  };
}
const masters = (assets: AssetLike[]): PnlMasters => ({
  vendors: [], allocations: [], monthlyGross: new Map(), projects: [], employeeNames: new Map(), assets,
});

function bsRow(asOf: string, assets: (AssetLike & { emi_purchase_id: string | null })[]): BalanceSheetRpcRow {
  return {
    as_of: asOf, fy_start_year: 2026, fy_label: "FY 2026-27",
    cash_and_bank: 500_000 - 125_000, undeposited_funds: 0, credit_card_payable: 0, receivables: 0,
    advances_from_customers: 0, project_receivable: 0, tds_receivable: 0, employee_loans: 0, prepaid_advances: 0,
    emi_unregistered_cost: 0, emi_loans_payable: 0, business_loans_payable: 0, payables: 0, salary_payable: 0,
    dues_salary_tds: 0, dues_pf: 0, dues_esi: 0, dues_vendor_tds: 0, dues_paid: [], reimbursements_payable: 0,
    gst_output: 0, bills_gst: 0, itc_groups: [], bill_itc_groups: [], fixed_assets: assets, tax_payments: [],
    expenses_payable: 0, expenses_paid_unbanked: 0, salary_other_deductions: 0,
  };
}

/* Laptop put to use 5 Oct 2026 → 178 days to 31 Mar 2027 (< 180) → half of 40% = 20% →
   ₹24,000 for FY 2026-27, spread over those 178 days. 5–31 Oct = 27 days → 24,000 × 27/178. */
const OCT_DEP = Math.round((24_000 * 27) / 178);   // 3,640

describe("R-1578 — capitalised expense + depreciation through P&L, Balance Sheet, Trial Balance", () => {
  it("the register's charge for FY 2026-27 is ₹24,000 (half rate, under 180 days)", () => {
    expect(depreciationInFy(laptop, 2026)).toBe(24_000);
    expect(OCT_DEP).toBe(3_640);
  });

  it("P&L for October: the laptop is not a cost; that month's depreciation is", () => {
    const p = assemblePnl({ from: "2026-10-01", to: "2026-10-31" }, pnlRow(false), masters([laptop]));
    expect(p.expenses).toBe(5_000);
    expect(p.depreciation).toBe(OCT_DEP);
    expect(p.netProfit).toBe(300_000 - 5_000 - OCT_DEP);
    expect(p.model.netProfit).toBe(300_000 - 5_000 - OCT_DEP);
  });

  it("P&L before the laptop was bought has no depreciation; a whole FY has exactly the register's ₹24,000", () => {
    expect(assemblePnl({ from: "2026-09-01", to: "2026-09-30" }, pnlRow(false), masters([laptop])).depreciation).toBe(0);
    expect(assemblePnl({ from: "2026-04-01", to: "2027-03-31" }, pnlRow(false), masters([laptop])).depreciation).toBe(24_000);
    // month by month adds up to the year — no rupee lost to rounding
    const months = ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"];
    const ends: Record<string, string> = { "2026-10": "31", "2026-11": "30", "2026-12": "31", "2027-01": "31", "2027-02": "28", "2027-03": "31" };
    const sum = months.reduce((s, m) => s + assemblePnl({ from: `${m}-01`, to: `${m}-${ends[m]}` }, pnlRow(false), masters([laptop])).depreciation, 0);
    expect(sum).toBe(24_000);
  });

  it("Balance Sheet on 31 Oct: net block = cost − depreciation charged (₹1,16,360)", () => {
    const bs = balanceSheetFromRpc(bsRow("2026-10-31", [laptop]));
    expect(bs.fixedAssets).toBe(120_000 - OCT_DEP);
    expect(bs.fixedAssetsCost).toBe(120_000);
    expect(bs.accumulatedDepreciation).toBe(OCT_DEP);
    // next year (FY 2027-28 has 29 Feb 2028 → 366 days): last year's ₹24,000 plus this year's part
    const next = balanceSheetFromRpc(bsRow("2027-04-30", [laptop]));
    expect(next.accumulatedDepreciation).toBe(24_000 + Math.round((38_400 * 30) / 366));
  });

  it("Trial Balance: depreciation + accumulated depreciation rows, and capitalising does not move the Difference", () => {
    const range = { from: "2026-04-01", to: "2026-10-31" };
    // A: laptop still an expense, no asset.
    const tbExpense = buildTrialBalance({
      bs: balanceSheetFromRpc(bsRow("2026-10-31", [])),
      pnl: assemblePnl(range, pnlRow(true), masters([])),
      items: [],
    });
    // B: laptop turned into an asset — report_pnl leaves it out, register depreciates it.
    const tbAsset = buildTrialBalance({
      bs: balanceSheetFromRpc(bsRow("2026-10-31", [laptop])),
      pnl: assemblePnl(range, pnlRow(false), masters([laptop])),
      items: [],
    });
    const row = (head: string) => tbAsset.rows.find((r) => r.head === head);
    expect(row("Fixed assets (at cost)")).toMatchObject({ debit: 120_000, credit: 0 });
    expect(row("Less: accumulated depreciation")).toMatchObject({ debit: 0, credit: OCT_DEP });
    expect(row("Depreciation")).toMatchObject({ group: "Expenses", debit: OCT_DEP, credit: 0 });
    expect(tbAsset.rows.some((r) => r.head === "Equipment")).toBe(false);
    expect(tbAsset.difference).toBe(tbExpense.difference);
    expect(tbAsset.totalDebit).toBe(tbAsset.totalCredit);
  });

  it("the bug, pinned: the same expense kept in the P&L while the asset exists moves the Difference by the cost", () => {
    const range = { from: "2026-04-01", to: "2026-10-31" };
    const ok = buildTrialBalance({ bs: balanceSheetFromRpc(bsRow("2026-10-31", [])), pnl: assemblePnl(range, pnlRow(true), masters([])), items: [] });
    const both = buildTrialBalance({ bs: balanceSheetFromRpc(bsRow("2026-10-31", [laptop])), pnl: assemblePnl(range, pnlRow(true), masters([laptop])), items: [] });
    expect(both.difference - ok.difference).toBe(120_000);
  });
});
