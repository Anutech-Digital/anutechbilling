/**
 * P&L ko `report_pnl` RPC ke jode hue aankdon se banana — pure, taaki test ho sake.
 *
 * S17 (28 Sep 2026): pehle usePnL har invoice aur har expense browser me kheenchta tha, aur
 * Balance Sheet ka retained-earnings wala P&L BOOKS_START (2000) se aaj tak ka hai — yaani
 * poori kitaab, har baar. PostgREST ka row cap lagte hi wo sum chup-chaap chhota ho jaata.
 * Ab SQL jodta hai (migration 20260928110000) aur yahan sirf wahi niyam chalte hain jo
 * pehle chalte the — splitItc, buildExpenseReport, projectCostForPeriod, buildPnl — un
 * par grouped rows (`n` = kitni asli rows) ke saath.
 *
 * Purana per-row hisaab src/lib/accounting/reports-reference.ts me oracle ke roop me hai;
 * tests/parity/reports-parity.test.ts dono ko ek hi fixture par milata hai.
 */
import { buildPnl, vendorOfCogsCategory, type PnlPeriod, type VendorInput } from "@/lib/accounting/pnl";
import { buildExpenseReport, type ExpenseReport } from "@/lib/accounting/expense-report";
import { splitItc } from "@/lib/gst/itc";
import { splitBillGroups, type BillItcGroup } from "@/lib/gst/bill-itc";
import {
  projectCostForPeriod, type ProjectCostResult, type LabourAllocation, type ProjectInfo, type CostExpense,
} from "@/lib/accounting/project-cost";
import { registerDepreciationForRange, type AssetLike } from "@/lib/accounting/depreciation";

export interface PnLNumbers {
  revenue:        number;   // Invoices ≥ status='pending' within period
  revenueCount:   number;
  cogs:           number;   // Vendor bills category 'COGS-*' within period
  cogsCount:      number;
  grossMargin:    number;
  expenses:       number;
  expensesCount:  number;
  expensesByCategory: { category: string; total: number; count: number }[];
  /** The same expense rows as a report — category, vendor, month (lib/accounting/expense-report). */
  expenseReport: ExpenseReport;
  commissions:      number;   // referral / channel-partner commissions (gross)
  commissionsCount: number;
  /** R-1578: the fixed-asset register's depreciation that falls in the period (IT Act WDV,
   *  lib/accounting/depreciation.ts). An expense turned into an asset is not in `expenses`
   *  (report_pnl leaves it out) — this line is how its cost reaches the P&L. */
  depreciation:   number;
  netProfit:      number;

  // GST snapshot
  outputGST: number;        // 18% of invoice subtotal proxy (using net_payable for simplicity)
  inputGST:  number;        // CLAIMABLE GST on bills (lib/gst/bill-itc.ts) + CLAIMABLE gst_paid on expenses (lib/gst/itc.ts)
  /** GST that is not credit — expenses (kaccha bill, no vendor GSTIN, s.17(5)) stay inside `expenses`; COGS bills (R-1576: proforma, no GSTIN, wrong head, s.17(5)) inside `cogs`. */
  itcBlocked: number;
  netGST:    number;

  // For quick scan
  marginPct: number;        // gross margin / revenue
  profitPct: number;        // net profit / revenue

  /**
   * The figures that know their own basis — lib/accounting/pnl.ts.
   *
   * Kept ALONGSIDE the flat fields above rather than replacing them: the GST snapshot,
   * the CSV export and the drill-down all read those, and swapping them wholesale would
   * be a large diff to change one number. Where the two disagree — and on this tenant
   * they do, because `cogs` reads an empty table — **`model` is the one to trust.**
   */
  model: PnlPeriod;
  /** Salary on customer projects + project-tagged expenses — lib/accounting/project-cost.ts. */
  projectCost: ProjectCostResult;
  /**
   * R-1833: what the Revenue line is made of (ex-GST), so the statement can show it as sub-lines
   * that add up to `revenue`: invoiced − credit notes + debit notes; `projects` is the part of
   * `invoiced` raised against projects.
   */
  revenueParts?: { invoiced: number; creditNotes: number; debitNotes: number; projects: number };
  /** R-1833: billed licence cost per subscription vendor (R-1645), null before that migration. */
  licenceBillsByVendor?: Readonly<Record<string, number>> | null;
  /** employee id → name, for the project-cost drill-down. */
  employeeNames: Map<string, string>;
}

/** `report_pnl` ki ek row — migration 20260928110000 ka RETURNS TABLE, naam wahi. */
export interface PnlRpcRow {
  inv_taxable: number;
  inv_tax: number;
  revenue_count: number;
  cn_taxable: number;
  cn_tax: number;
  dn_taxable: number;
  dn_tax: number;
  revenue_by_project: { project_id: string; revenue: number }[];
  cogs: number;
  cogs_count: number;
  bills_gst: number;
  expense_groups: { category: string | null; vendor_name: string | null; month: string; amount: number; n: number }[];
  itc_groups: { bill_type: string | null; category: string | null; vendorGstin: string | null; gst_paid: number; n: number }[];
  /** R-1576: the COGS bills grouped for the ITC rule (lib/gst/bill-itc.ts). Absent before that migration. */
  bill_itc_groups?: BillItcGroup[] | null;
  /** R-1645: COGS bills per category (pre-GST subtotal). Absent before that migration — then the
   *  P&L keeps the old rule (any bill switches the whole licence estimate off). */
  cogs_by_category?: { category: string | null; subtotal: number; n: number }[] | null;
  unassigned_by_category: { category: string | null; amount: number }[];
  project_expenses: {
    project_id: string; amount: number; category: string | null; expense_date: string | null;
    vendor_name: string | null; description: string | null;
  }[];
  commissions: number;
  commissions_count: number;
}

/** Master data jo TS me hi padha jaata hai (subscriptions → vendors, project labour). */
export interface PnlMasters {
  vendors: VendorInput[];
  allocations: LabourAllocation[];
  monthlyGross: ReadonlyMap<string, number>;
  projects: ProjectInfo[];
  employeeNames: Map<string, string>;
  /** R-1578: the fixed-asset register. Absent = no depreciation line (₹0). */
  assets?: readonly AssetLike[];
}

/**
 * R-1645: billed licence cost per subscription vendor — each COGS category's subtotal plus the
 * GST on those bills that is not credit (R-1576, same rule as `cogs` below). Null when the
 * database has no per-category split yet.
 */
export function billedByVendor(r: Pick<PnlRpcRow, "cogs_by_category" | "bill_itc_groups">): Record<string, number> | null {
  if (!Array.isArray(r.cogs_by_category)) return null;
  const groups = Array.isArray(r.bill_itc_groups) ? r.bill_itc_groups : [];
  const out: Record<string, number> = {};
  for (const c of r.cogs_by_category) {
    const vendor = vendorOfCogsCategory(c.category);
    if (!vendor) continue;
    const blocked = splitBillGroups(groups.filter((g) => g.category === c.category)).blocked;
    out[vendor] = (out[vendor] ?? 0) + Number(c.subtotal) + blocked;
  }
  return out;
}

/**
 * R-1646: THE profit of a period — what the P&L headline shows, what the Balance Sheet carries
 * as retained earnings and what the Trial Balance's income − expenses come to. `model` (with the
 * licence-cost estimate, marked) when it can be stated; the flat figure when the cost is unknown.
 */
export function reportProfit(p: Pick<PnLNumbers, "model" | "netProfit">): number {
  return p.model.netProfit ?? p.netProfit;
}

export function assemblePnl(range: { from: string; to: string }, r: PnlRpcRow, m: PnlMasters): PnLNumbers {
  const revenue      = r.inv_taxable - r.cn_taxable + r.dn_taxable;
  const revenueCount = r.revenue_count;
  const outputGST    = r.inv_tax - r.cn_tax + r.dn_tax;

  /* R-1576: only a bill's CREDITABLE GST is input GST; the rest (proforma, no vendor GSTIN,
     wrong head, s.17(5)) is part of what the goods cost. Before the migration (no groups):
     the old figures — never a silent 0 credit. */
  const billItc   = Array.isArray(r.bill_itc_groups) ? splitBillGroups(r.bill_itc_groups) : null;
  const billsGst  = billItc ? billItc.eligible : r.bills_gst;
  const billsGstBlocked = billItc ? billItc.blocked : 0;
  const cogs      = r.cogs + billsGstBlocked;
  const cogsCount = r.cogs_count;

  /* Mahina "YYYY-MM" aata hai; report sirf slice(0, 7) padhta hai, isliye pehli tareekh. */
  const expenseRows = r.expense_groups.map((g) => ({
    amount: g.amount, category: g.category, vendor_name: g.vendor_name,
    expense_date: `${g.month}-01`, n: g.n,
  }));
  const expenseReport = buildExpenseReport(expenseRows);

  const itc = splitItc(r.itc_groups);
  const expensesPaid  = expenseRows.reduce((s, e) => s + e.amount, 0);
  const expensesTotal = expensesPaid - itc.eligible;   // claimable GST is not a cost
  const expensesCount = expenseRows.reduce((s, e) => s + e.n, 0);
  const expensesGst   = itc.eligible;

  /* Purane hook jaisa: `category || "Uncategorised"` (trim nahi), bade se chhota. Barabar
     total par naam se — pehle DB ka row-order tay karta tha, jo tay hi nahi hota. */
  const catAgg = new Map<string, { total: number; count: number }>();
  for (const e of expenseRows) {
    const c = e.category || "Uncategorised";
    const g = catAgg.get(c) ?? { total: 0, count: 0 };
    g.total += e.amount; g.count += e.n;
    catAgg.set(c, g);
  }
  const expensesByCategory = [...catAgg.entries()]
    .map(([category, v]) => ({ category, total: v.total, count: v.count }))
    .sort((a, b) => b.total - a.total || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));

  const commissions      = r.commissions;
  const commissionsCount = r.commissions_count;

  /* Salary pool project-cost me sirf un-tagged rows ki category se banta hai, aur direct
     cost har tagged row se — isliye un-tagged category-war jod + tagged rows ek-ek. */
  const costExpenses: CostExpense[] = [
    ...r.unassigned_by_category.map((c) => ({ amount: c.amount, category: c.category, project_id: null })),
    ...r.project_expenses,
  ];
  const revenueByProject = r.revenue_by_project;
  const projectRevenue = revenueByProject.reduce((s, x) => s + x.revenue, 0);
  const projectCost = projectCostForPeriod({
    from: range.from, to: range.to,
    allocations: m.allocations,
    monthlyGross: m.monthlyGross,
    projects: m.projects,
    expenses: costExpenses,
    revenueByProject,
  });

  /* R-1578: depreciation is an operating expense of the period — the register's yearly charge,
     the part that falls inside the range (lib/accounting/depreciation.ts). */
  const depreciation = registerDepreciationForRange(m.assets ?? [], range.from, range.to);

  const model = buildPnl({
    revenue,
    expenses: expensesTotal + commissions + depreciation,
    billedCogs: cogs > 0 ? cogs : null,
    billedByVendor: billedByVendor(r),
    vendors: m.vendors,
    projectCost: projectCost.total,
    /* R-1649: salaries this role cannot read → the project cost is hidden, never ₹0. */
    projectCostHidden: projectCost.salaryHidden > 0,
    projectRevenue,
  });

  const grossMargin = revenue - cogs;
  const netProfit   = grossMargin - expensesTotal - commissions - depreciation;
  const inputGST    = billsGst + expensesGst;
  const netGST      = outputGST - inputGST;
  const marginPct = revenue > 0 ? (grossMargin / revenue) * 100 : 0;
  const profitPct = revenue > 0 ? (netProfit / revenue) * 100   : 0;

  return {
    revenue, revenueCount,
    cogs, cogsCount,
    grossMargin,
    expenses: expensesTotal, expensesCount, expensesByCategory, expenseReport,
    commissions, commissionsCount,
    depreciation,
    netProfit,
    outputGST, inputGST, netGST, itcBlocked: itc.blocked + billsGstBlocked,
    marginPct, profitPct,
    model,
    projectCost,
    employeeNames: m.employeeNames,
    revenueParts: {
      invoiced: r.inv_taxable, creditNotes: r.cn_taxable, debitNotes: r.dn_taxable,
      projects: Math.min(Math.max(0, projectRevenue), r.inv_taxable),
    },
    licenceBillsByVendor: billedByVendor(r),
  };
}
