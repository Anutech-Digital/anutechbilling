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
 * S45 slice 2 (9 Oct 2026, migration 20261009170000): wo teen gaps bhi band — Razorpay /
 * settlement fee ab "Bank Charges" kharcha, unpaid kharche "Expenses payable", cash / UPI
 * kharche jinki bank line match nahi "Paid, not yet matched in bank" (Cr), salary ka "other"
 * deduction ek liability. Aur owner CA ke opening capital + retained earnings b/f Balance
 * Sheet page par bhar sakta hai — bhare hon to wo Equity me aate hain aur Difference me sirf
 * wahi bachta hai jo sach me kahin record nahi.
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
import type { BalanceSheetAuto, BalanceSheetItem, OpeningBalances } from "@/lib/queries/balance-sheet";
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

export const LICENCE_ESTIMATE_HEAD = "Licence cost — estimated, not yet billed";
export const LICENCE_PROVISION_HEAD = "Licence cost provision (estimate, not yet billed)";

export function buildTrialBalance(args: {
  bs: BalanceSheetAuto;
  /** FY start → as-of ka P&L. */
  pnl: PnLNumbers;
  items: readonly BalanceSheetItem[];
  /** CA ke opening balances (owner ne bhare). null / undefined = nahi bhare — Difference jaisa tha. */
  opening?: OpeningBalances | null;
  /**
   * R-1646: the licence-cost provision as at today — the Balance Sheet's figure (the estimated,
   * not-yet-billed licence cost inside the profit it carries; balance-sheet-totals.ts licenceProvisionOf).
   * Not given → this FY's estimate, so the expense head always has its other side.
   */
  licenceProvision?: number | null;
}): TrialBalance {
  const { bs, pnl, items, opening } = args;
  /* R-1646: the P&L and the Balance Sheet count the licence cost estimated from the
     subscription book (no vendor bill yet) as cost; the TB booked only the billed part, so its
     income − expenses was higher by the whole estimate. One rule now: the estimate is cost
     everywhere, on its own marked head, against a provision. Unknown cost (model.netProfit
     null) has no estimate. */
  const estimatedLicence = pnl.model?.netProfit == null ? 0 : (pnl.model.estimatedLicenceCogs ?? 0);
  const licenceProvision = args.licenceProvision ?? estimatedLicence;
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
  /* Asset ka ulta: paisa ja chuka, bank line abhi match nahi — Cr column me baithta hai. */
  put("Assets", "Less: expenses paid, not yet matched in bank", -bs.expensesPaidUnbanked, "debit",
    "Cash / UPI expenses marked paid with no bank line matched yet");
  put("Assets", "Received, not yet in bank", bs.undepositedFunds, "debit", "Customer receipts not matched to any bank line (undeposited funds)");
  put("Assets", "Trade receivables", bs.receivables, "debit", "Pending / overdue invoices (project milestones excluded)");
  put("Assets", "Project receivables", bs.projectReceivable, "debit", "Invoiced project milestones − received");
  put("Assets", "TDS receivable", bs.tdsReceivable, "debit", "TDS deducted by customers, not yet claimed");
  put("Assets", "Loans & advances to employees", bs.employeeLoans, "debit", "Employee loans − repayments");
  put("Assets", "Loans given (outside parties)", bs.loansGiven ?? 0, "debit", "Loans given − principal repaid");
  put("Assets", "Prepaid / vendor advances", bs.prepaidAdvances, "debit", "Advances paid − consumed");
  /* R-1578: cost Dr + accumulated depreciation Cr (the depreciation the P&L has charged), so the
     year's Depreciation expense below has its other side. Older callers (no split) → one net line. */
  if (bs.fixedAssetsCost != null && bs.accumulatedDepreciation != null) {
    put("Assets", "Fixed assets (at cost)", bs.fixedAssetsCost, "debit", "Asset register at cost + EMI purchases not yet registered");
    put("Assets", "Less: accumulated depreciation", -bs.accumulatedDepreciation, "debit",
      "Depreciation charged on the assets still held, up to today (Income-tax WDV rates)");
  } else {
    put("Assets", "Fixed assets (WDV)", bs.fixedAssets, "debit", "Asset register at written-down value");
  }
  put("Assets", `Advance income tax (${bs.fyLabel})`, bs.advanceTaxPaid, "debit", "Advance + self-assessment tax paid");
  for (const it of items.filter((i) => i.section === "asset")) put("Assets", it.label, it.amount, "debit", "Balance sheet — manual line");

  // ── Liabilities ──
  put("Liabilities", "Trade payables", bs.payables, "credit", "Vendor bills − paid");
  put("Liabilities", "Advances from customers", bs.advancesFromCustomers, "credit",
    "Received before an invoice was raised, plus anything paid over an invoice or credited after payment");
  put("Liabilities", "Salary payable", bs.salaryPayable, "credit", "Net salary booked, not yet paid");
  put("Liabilities", "Statutory dues (TDS / PF / ESI)", bs.salaryDuesPayable, "credit", "Withheld + employer share − challans");
  put("Liabilities", "Reimbursements payable", bs.reimbursementsPayable, "credit", "Paid from someone's own pocket, not yet repaid");
  put("Liabilities", "Expenses payable", bs.expensesPayable, "credit", "Expenses marked unpaid (amount − TDS), no bank line matched");
  put("Liabilities", "Salary deductions held (other)", bs.salaryOtherDeductions, "credit", "\"Other\" deductions withheld from salary");
  /* R-1580: commission P&L me gross; Cr = abhi na diya net (yahan) + 194H TDS (statutory dues). */
  put("Liabilities", "Commission payable (partners)", bs.commissionsPayable ?? 0, "credit",
    "Partner commission earned, not yet paid (net of TDS — the TDS is in statutory dues)");
  put("Liabilities", "Credit card payable", bs.creditCardPayable, "credit", "Company cards: amount owed");
  put("Liabilities", "EMI / asset loans", bs.emiLoansPayable, "credit", "Financed − principal repaid");
  put("Liabilities", "Business loans", bs.businessLoansPayable, "credit", "Borrowed − principal repaid");
  put("Liabilities", LICENCE_PROVISION_HEAD, licenceProvision, "credit",
    "Licence cost estimated from your subscription book, no vendor bill entered yet — same figure as the Balance Sheet");
  put("Liabilities", bs.gstPayable >= 0 ? "GST payable" : "GST input credit carried forward", bs.gstPayable, "credit",
    "Output GST − eligible ITC − GST paid (cumulative, estimate before filing)");
  for (const it of items.filter((i) => i.section === "liability")) put("Liabilities", it.label, it.amount, "credit", "Balance sheet — manual line");

  // ── Equity ──
  if (opening) {
    put("Equity", "Owner's capital (opening, from CA)", opening.ownerCapital ?? 0, "credit", `Opening balances as at ${opening.asOf}`);
    put("Equity", "Retained earnings b/f (from CA)", opening.retainedEarnings ?? 0, "credit", `Earlier years' profit as at ${opening.asOf}`);
  }
  /* R-1739: the Cr side of the open balances imported from Zoho Books (their Dr is in Trade receivables). */
  put("Equity", "Opening Balance Adjustments", bs.openingBalanceAdjustments ?? 0, "credit",
    "Balance due on invoices imported from Zoho Books, as imported (account name to confirm with your CA)");
  for (const it of items.filter((i) => i.section === "equity")) put("Equity", it.label, it.amount, "credit", "Balance sheet — manual line");

  // ── Income / Expenses (FY to date) ──
  put("Income", "Sales (net of credit / debit notes)", pnl.revenue, "credit", `Taxable value of invoices, ${bs.fyLabel} to date`);
  put("Expenses", "Cost of goods — vendor bills", pnl.cogs, "debit", "COGS-* vendor bills (pre-GST)");
  put("Expenses", LICENCE_ESTIMATE_HEAD, estimatedLicence, "debit",
    `Estimate — subscription book's wholesale rates, ${bs.fyLabel} to date, for vendors with no bill; the P&L counts the same`);
  const grossExpenses = pnl.expensesByCategory.reduce((s, c) => s + c.total, 0);
  for (const c of [...pnl.expensesByCategory].sort((a, b) => a.category.localeCompare(b.category))) {
    put("Expenses", c.category, c.total, "debit", `${c.count} expense${c.count === 1 ? "" : "s"} (GST-inclusive)`);
  }
  /* Gross heads me jo GST credit ban kar GST payable se ghat chuka — wo kharcha nahi. */
  put("Expenses", "Less: ITC inside the expenses above", -(grossExpenses - pnl.expenses), "debit",
    "Claimable GST on expenses — already reduces GST payable");
  put("Expenses", "Referral / partner commissions", pnl.commissions, "debit", "Gross commission earned by partners");
  put("Expenses", "Depreciation", pnl.depreciation ?? 0, "debit",
    `Asset register, ${bs.fyLabel} to date (Income-tax WDV rates; an expense turned into an asset is here, not above)`);

  const dr = rows.reduce((s, r) => s + r.debit, 0);
  const cr = rows.reduce((s, r) => s + r.credit, 0);
  const difference = dr - cr;
  put("Difference", opening ? "Difference — not explained by records or opening balances" : "Difference — opening capital & retained earnings b/f",
    difference, "credit",
    opening
      ? "Derived, not a ledger: what the records and the CA's opening balances still do not explain"
      : "Derived, not a ledger: what the records alone cannot explain (earlier years' profit, capital, anything unrecorded)");

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
