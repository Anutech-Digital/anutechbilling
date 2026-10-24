/**
 * R-1646 — Trial Balance, P&L and Balance Sheet state ONE profit, to the rupee.
 *
 * Before: the P&L headline and the Balance Sheet's retained earnings used `model.netProfit`
 * (licence cost estimated from the subscription book when no vendor bill exists), while the
 * Trial Balance booked only `pnl.cogs` — billed cost (trial-balance.ts "Cost of goods — vendor
 * bills"). With subscriptions and no bills, the TB's income − expenses was higher than the P&L
 * by the whole estimate, the Balance Sheet's "unexplained difference" carried it, and the TB
 * header still said "Same numbers as the Balance Sheet and P&L".
 *
 * Rule (recorded on the card): the estimate is used EVERYWHERE and marked everywhere — it is
 * an accrual. TB books it as its own expense head ("Licence cost — estimated, not yet billed")
 * with its other side as a provision liability; the Balance Sheet carries the same provision,
 * so the estimate never lands in the unexplained difference (and is never "booked as owner's
 * capital" by the one-click button).
 */
import { describe, it, expect } from "vitest";
import { assemblePnl, reportProfit, type PnlRpcRow, type PnlMasters, type PnLNumbers } from "./pnl-assemble";
import { buildTrialBalance, type TrialBalance } from "./trial-balance";
import { balanceSheetTotals } from "./balance-sheet-totals";
import type { BalanceSheetAuto, BalanceSheetItem } from "@/lib/queries/balance-sheet";
import type { VendorInput } from "./pnl";

const google: VendorInput = { vendor: "google", revenue: 100_000, billedCost: null, estimatedCost: 62_500, seats: 100, subscriptions: 5 };
const zoho: VendorInput = { vendor: "zoho", revenue: 20_000, billedCost: null, estimatedCost: 12_000, seats: 40, subscriptions: 2 };

const row = (over: Partial<PnlRpcRow> = {}): PnlRpcRow => ({
  inv_taxable: 240_000, inv_tax: 43_200, revenue_count: 6, cn_taxable: 0, cn_tax: 0, dn_taxable: 0, dn_tax: 0,
  revenue_by_project: [], cogs: 0, cogs_count: 0, bills_gst: 0,
  expense_groups: [
    { category: "Salaries", vendor_name: null, month: "2026-05", amount: 60_000, n: 2 },
    { category: "Software", vendor_name: "Figma", month: "2026-06", amount: 11_800, n: 1 },
  ],
  itc_groups: [{ bill_type: "tax_invoice", category: "Software", vendorGstin: "06AAACF1234A1Z5", gst_paid: 1_800, n: 1 }],
  bill_itc_groups: [], cogs_by_category: [],
  unassigned_by_category: [], project_expenses: [], commissions: 3_000, commissions_count: 1,
  ...over,
});
const masters = (vendors: VendorInput[]): PnlMasters => ({
  vendors, allocations: [], monthlyGross: new Map(), projects: [], employeeNames: new Map(),
});
const FY = { from: "2026-04-01", to: "2026-10-23" };

const bs: BalanceSheetAuto = {
  cashAndBank: 300_000, undepositedFunds: 0, receivables: 50_000, advancesFromCustomers: 0, projectReceivable: 0,
  tdsReceivable: 0, employeeLoans: 0, prepaidAdvances: 0, fixedAssets: 0,
  payables: 2_000, salaryPayable: 0, salaryDuesPayable: 0, reimbursementsPayable: 0,
  creditCardPayable: 0, emiLoansPayable: 0, businessLoansPayable: 0,
  gstPayable: 41_400, gstPaid: 0, advanceTaxPaid: 0,
  expensesPayable: 0, expensesPaidUnbanked: 0, salaryOtherDeductions: 0, fyLabel: "FY 2026-27",
};
const items: BalanceSheetItem[] = [];

/** Income − expenses as the Trial Balance states them. */
function tbProfit(tb: TrialBalance): number {
  const side = (g: string) => tb.rows.filter((r) => r.group === g).reduce((s, r) => s + r.credit - r.debit, 0);
  return side("Income") + side("Expenses");
}

/** The three reports built from one fixture — books start this FY, so the Balance Sheet's
 *  cumulative P&L is the same range as the FY P&L. */
function threeReports(pnl: PnLNumbers) {
  const provision = pnl.model.estimatedLicenceCogs;
  const tb = buildTrialBalance({ bs, pnl, items, opening: null, licenceProvision: provision });
  const totals = balanceSheetTotals(bs, items, { licenceProvision: provision });
  const bsProfit = reportProfit(pnl);
  return { pnlProfit: pnl.model.netProfit, tbProfit: tbProfit(tb), bsProfit, tb, unexplained: totals.retained - bsProfit };
}

describe("R-1646: one profit across Trial Balance, P&L and Balance Sheet", () => {
  it("subscriptions, no vendor bills (estimate) — the three agree to the rupee", () => {
    const pnl = assemblePnl(FY, row(), masters([google, zoho]));
    expect(pnl.model.cogsBasis).toBe("estimated");
    expect(pnl.model.estimatedLicenceCogs).toBe(149_000);   // 240,000 × 74,500 / 120,000
    const r = threeReports(pnl);
    expect(r.pnlProfit).not.toBeNull();
    expect(r.tbProfit).toBe(r.pnlProfit);
    expect(r.bsProfit).toBe(r.pnlProfit);
    /* The estimate is a marked head with its provision — not a hidden part of another line. */
    const est = r.tb.rows.find((x) => x.head === "Licence cost — estimated, not yet billed")!;
    expect(est.group).toBe("Expenses");
    expect(est.debit).toBe(149_000);
    const prov = r.tb.rows.find((x) => x.head === "Licence cost provision (estimate, not yet billed)")!;
    expect(prov.group).toBe("Liabilities");
    expect(prov.credit).toBe(149_000);
  });

  it("one vendor billed, the other estimated (mixed) — still one profit", () => {
    const pnl = assemblePnl(FY, row({ cogs: 64_000, cogs_count: 3, cogs_by_category: [{ category: "COGS-Workspace", subtotal: 64_000, n: 3 }] }), masters([google, zoho]));
    expect(pnl.model.cogsBasis).toBe("mixed");
    const r = threeReports(pnl);
    expect(r.tbProfit).toBe(r.pnlProfit);
    expect(r.bsProfit).toBe(r.pnlProfit);
  });

  it("only bills — no estimate, no provision line, still one profit", () => {
    const pnl = assemblePnl(FY, row({ cogs: 70_000, cogs_count: 2, cogs_by_category: [{ category: "COGS-Workspace", subtotal: 64_000, n: 1 }, { category: "COGS-Zoho", subtotal: 6_000, n: 1 }] }), masters([google, zoho]));
    expect(pnl.model.cogsBasis).toBe("billed");
    const r = threeReports(pnl);
    expect(r.tbProfit).toBe(r.pnlProfit);
    expect(r.bsProfit).toBe(r.pnlProfit);
    expect(r.tb.rows.some((x) => x.head.startsWith("Licence cost provision"))).toBe(false);
  });

  it("the estimate does not leak into the Balance Sheet's unexplained difference", () => {
    const withBook = threeReports(assemblePnl(FY, row(), masters([google, zoho])));
    const noBook = threeReports(assemblePnl(FY, row(), masters([])));
    expect(withBook.unexplained).toBe(noBook.unexplained);
  });

  it("the Trial Balance difference line is not moved by the estimate either", () => {
    const withBook = threeReports(assemblePnl(FY, row(), masters([google, zoho])));
    const noBook = threeReports(assemblePnl(FY, row(), masters([])));
    expect(withBook.tb.difference).toBe(noBook.tb.difference);
  });
});
