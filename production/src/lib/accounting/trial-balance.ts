/**
 * Trial Balance — har ledger head ka Dr / Cr balance, ek page par.
 *
 * ─── KAHAN SE AATA HAI ──────────────────────────────────────────────────────
 * Koi naya hisaab nahi. Balance-sheet heads `report_balance_sheet` (useBalanceSheetAuto)
 * se, P&L heads FY start → aaj ke `report_pnl` (usePnL) se, aur haath se daali lines
 * balance_sheet_items se. Teesri definition banate to TB, P&L aur Balance Sheet teen
 * alag number dikhate — CA sabse pehle yahi pakadta hai.
 *
 * ─── YE DOUBLE-ENTRY KA TB NAHI HAI, AUR SCREEN YE KEHTI HAI ────────────────
 * ResellerOS single-entry "books-lite" hai: har record apni table me hai, journal nahi.
 * Isliye Dr aur Cr apne aap barabar nahi hote. Farq — pichhle saalon ka retained earnings,
 * owner ka capital, aur jo kuch app me record hi nahi — ek alag, saaf label wali line me
 * jaata hai ("Difference — opening capital & retained earnings b/f"). Balance Sheet ka
 * equity plug bhi yahi karta hai. Us line ko chhupana TB ko "tally" dikhata par jhooth hota.
 *
 * S45 slice 1 (7 Oct 2026): har money event ke pehle/baad Dr − Cr naapa
 * (supabase/tests/tb_money_events_balanced.test.sql). Part payment, TDS wala payment aur
 * invoice ke baad customer ka bakaaya (overpayment / paid invoice par credit note) TB ko
 * hilaate the — migration 20261007290000 ne theek kiye. Abhi bhi hilaate hain (slice 2,
 * asli journal): Razorpay fee, bina bank line ka cash expense, salary "other" deduction.
 * Isliye ye line abhi bhi zaroori hai — par ab usme sirf opening capital / pichhle saal ka
 * profit / upar ke known gaps hain, roz ke receipts nahi.
 *
 * ─── EXPENSE HEADS GROSS, ITC ALAG ─────────────────────────────────────────
 * P&L ki category list GST-inclusive `amount` hai, aur P&L ka `expenses` usme se claimable
 * ITC ghata kar. TB dono dikhata hai: category heads gross (Dr) + ek Cr line "ITC inside
 * the expenses above" — taaki expense ka net P&L se milta rahe aur GST payable (jo ITC
 * already ghata chuka hai) do baar na gine.
 *
 * Paisa poore rupees (AGENTS.md §1). Negative balance ulte column me jaata hai (overpaid
 * card, GST credit), minus sign ke saath nahi — Tally aisa hi chhapta hai.
 */
import type { BalanceSheetAuto, BalanceSheetItem } from "@/lib/queries/balance-sheet";
import type { PnLNumbers } from "@/lib/accounting/pnl-assemble";

export type TbGroup = "Assets" | "Liabilities" | "Equity" | "Income" | "Expenses" | "Difference";

export interface TbRow {
  group: TbGroup;
  head: string;
  debit: number;
  credit: number;
  /** Chhota "kahan se" — screen par head ke neeche. */
  source: string;
}

export interface TrialBalance {
  rows: TbRow[];
  totalDebit: number;
  totalCredit: number;
  /** Plug ki raqam (Dr − Cr, plug se pehle). 0 = records apne aap tally. */
  difference: number;
  fyLabel: string;
}

export function buildTrialBalance(args: {
  bs: BalanceSheetAuto;
  /** FY start → as-of ka P&L. */
  pnl: PnLNumbers;
  items: readonly BalanceSheetItem[];
}): TrialBalance {
  const { bs, pnl, items } = args;
  const rows: TbRow[] = [];

  /* natural = jis column me positive balance baithta hai. */
  const put = (group: TbGroup, head: string, amount: number, natural: "debit" | "credit", source: string) => {
    if (!amount) return;
    const onNatural = amount > 0;
    const side = onNatural ? natural : natural === "debit" ? "credit" : "debit";
    const v = Math.abs(amount);
    rows.push({ group, head, source, debit: side === "debit" ? v : 0, credit: side === "credit" ? v : 0 });
  };

  // ── Assets ──
  put("Assets", "Cash & bank", bs.cashAndBank, "debit", "Bank accounts: opening + credits − debits");
  put("Assets", "Received, not yet in bank", bs.undepositedFunds, "debit", "Customer receipts not matched to any bank line (undeposited funds)");
  put("Assets", "Trade receivables", bs.receivables, "debit", "Pending / overdue invoices (project milestones excluded)");
  put("Assets", "Project receivables", bs.projectReceivable, "debit", "Invoiced project milestones − received");
  put("Assets", "TDS receivable", bs.tdsReceivable, "debit", "TDS deducted by customers, not yet claimed");
  put("Assets", "Loans & advances to employees", bs.employeeLoans, "debit", "Employee loans − repayments");
  put("Assets", "Prepaid / vendor advances", bs.prepaidAdvances, "debit", "Advances paid − consumed");
  put("Assets", "Fixed assets (WDV)", bs.fixedAssets, "debit", "Asset register at written-down value");
  put("Assets", `Advance income tax (${bs.fyLabel})`, bs.advanceTaxPaid, "debit", "Advance + self-assessment tax paid");
  for (const it of items.filter((i) => i.section === "asset")) put("Assets", it.label, it.amount, "debit", "Balance sheet — manual line");

  // ── Liabilities ──
  put("Liabilities", "Trade payables", bs.payables, "credit", "Vendor bills − paid");
  put("Liabilities", "Advances from customers", bs.advancesFromCustomers, "credit",
    "Received before an invoice was raised, plus anything paid over an invoice or credited after payment");
  put("Liabilities", "Salary payable", bs.salaryPayable, "credit", "Net salary booked, not yet paid");
  put("Liabilities", "Statutory dues (TDS / PF / ESI)", bs.salaryDuesPayable, "credit", "Withheld + employer share − challans");
  put("Liabilities", "Reimbursements payable", bs.reimbursementsPayable, "credit", "Paid from someone's own pocket, not yet repaid");
  put("Liabilities", "Credit card payable", bs.creditCardPayable, "credit", "Company cards: amount owed");
  put("Liabilities", "EMI / asset loans", bs.emiLoansPayable, "credit", "Financed − principal repaid");
  put("Liabilities", "Business loans", bs.businessLoansPayable, "credit", "Borrowed − principal repaid");
  put("Liabilities", bs.gstPayable >= 0 ? "GST payable" : "GST input credit carried forward", bs.gstPayable, "credit",
    "Output GST − eligible ITC − GST paid (cumulative, estimate before filing)");
  for (const it of items.filter((i) => i.section === "liability")) put("Liabilities", it.label, it.amount, "credit", "Balance sheet — manual line");

  // ── Equity ──
  for (const it of items.filter((i) => i.section === "equity")) put("Equity", it.label, it.amount, "credit", "Balance sheet — manual line");

  // ── Income / Expenses (FY to date) ──
  put("Income", "Sales (net of credit / debit notes)", pnl.revenue, "credit", `Taxable value of invoices, ${bs.fyLabel} to date`);
  put("Expenses", "Cost of goods — vendor bills", pnl.cogs, "debit", "COGS-* vendor bills (pre-GST)");
  const grossExpenses = pnl.expensesByCategory.reduce((s, c) => s + c.total, 0);
  for (const c of [...pnl.expensesByCategory].sort((a, b) => a.category.localeCompare(b.category))) {
    put("Expenses", c.category, c.total, "debit", `${c.count} expense${c.count === 1 ? "" : "s"} (GST-inclusive)`);
  }
  /* Gross heads me jo GST credit ban kar GST payable se ghat chuka — wo kharcha nahi. */
  put("Expenses", "Less: ITC inside the expenses above", -(grossExpenses - pnl.expenses), "debit",
    "Claimable GST on expenses — already reduces GST payable");
  put("Expenses", "Referral / partner commissions", pnl.commissions, "debit", "Gross commission earned by partners");

  const dr = rows.reduce((s, r) => s + r.debit, 0);
  const cr = rows.reduce((s, r) => s + r.credit, 0);
  const difference = dr - cr;
  put("Difference", "Difference — opening capital & retained earnings b/f", difference, "credit",
    "Derived, not a ledger: what the records alone cannot explain (earlier years' profit, capital, anything unrecorded)");

  return {
    rows,
    totalDebit: rows.reduce((s, r) => s + r.debit, 0),
    totalCredit: rows.reduce((s, r) => s + r.credit, 0),
    difference,
    fyLabel: bs.fyLabel,
  };
}

/** CSV — CA ke liye, Tally jaisi do-column shakal. */
export function trialBalanceCsvRows(tb: TrialBalance): (string | number)[][] {
  return [
    ...tb.rows.map((r) => [r.group, r.head, r.debit || "", r.credit || ""]),
    ["", "Total", tb.totalDebit, tb.totalCredit],
  ];
}
