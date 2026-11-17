/**
 * R-1855 — Schedule III (Division I) Balance Sheet for a Private Limited company.
 *
 * A RE-GROUPING of the Balance Sheet the page already shows, never a second calculation: the page
 * hands this file the same figures it prints (the report's auto figures, the loan split, the equity
 * section, the unexplained difference) and this file only decides under which Schedule III head each
 * account line sits. Every number is one of those figures; nothing is computed from the books again.
 *
 * ONE mapping table (ACCOUNT_HEAD): account line → head. Every line the builder produces looks its
 * head up there; a hand-entered line whose label is not covered by MANUAL_RULES goes to the visible
 * "Unmapped — please classify" block — never dropped, never guessed. AUTO_FIELD_KEYS names, for every
 * field of BalanceSheetAuto, the account line(s) it becomes — typed as Record<keyof BalanceSheetAuto>,
 * so a new report figure does not compile until it is classified here (the test checks both tables).
 *
 * Order and wording follow Schedule III Division I (Companies Act 2013), Part I — Balance Sheet.
 * Previous-period column: the Balance Sheet is "as of today" only (manual lines, equity, the loan
 * split and GST are not dated), so a previous-period figure does not exist yet — the column is there
 * and says n/a; it is never filled with a guess (follow-up card).
 * Whole rupees, same as the sheet. Pure.
 */
import type { BalanceSheetAuto, BalanceSheetItem } from "@/lib/queries/balance-sheet";
import type { EquitySection, ManualEquityLine } from "@/lib/accounting/equity-section";
import type { LoanSplitLine } from "@/lib/accounting/loans-current-split";

export type HeadId =
  | "share_capital" | "reserves_surplus" | "share_warrants"
  | "share_application_money"
  | "lt_borrowings" | "deferred_tax_liab" | "other_lt_liab" | "lt_provisions"
  | "st_borrowings" | "trade_payables_msme" | "trade_payables_others" | "other_current_liab" | "st_provisions"
  | "ppe_intangible" | "nc_investments" | "deferred_tax_assets" | "lt_loans_advances" | "other_nc_assets"
  | "current_investments" | "inventories" | "trade_receivables" | "cash" | "st_loans_advances" | "other_current_assets";

export type Side = "equity_liab" | "assets";

export interface HeadDef {
  id: HeadId;
  side: Side;
  /** Numbered group, e.g. "(1) Shareholders' funds"; null = a stand-alone numbered head. */
  group: string | null;
  /** "(a)" … ; "(2)" for a stand-alone head. */
  letter: string;
  label: string;
  /** Note number printed in the Note column (heads sharing one note — MSME / others — share a number). */
  note: number;
}

/** The statutory order. Do not reorder — the view and the CSV read this array top to bottom. */
export const HEADS: readonly HeadDef[] = [
  { id: "share_capital", side: "equity_liab", group: "(1) Shareholders' funds", letter: "(a)", label: "Share capital", note: 1 },
  { id: "reserves_surplus", side: "equity_liab", group: "(1) Shareholders' funds", letter: "(b)", label: "Reserves and surplus", note: 2 },
  { id: "share_warrants", side: "equity_liab", group: "(1) Shareholders' funds", letter: "(c)", label: "Money received against share warrants", note: 3 },
  { id: "share_application_money", side: "equity_liab", group: null, letter: "(2)", label: "Share application money pending allotment", note: 4 },
  { id: "lt_borrowings", side: "equity_liab", group: "(3) Non-current liabilities", letter: "(a)", label: "Long-term borrowings", note: 5 },
  { id: "deferred_tax_liab", side: "equity_liab", group: "(3) Non-current liabilities", letter: "(b)", label: "Deferred tax liabilities (net)", note: 6 },
  { id: "other_lt_liab", side: "equity_liab", group: "(3) Non-current liabilities", letter: "(c)", label: "Other long-term liabilities", note: 7 },
  { id: "lt_provisions", side: "equity_liab", group: "(3) Non-current liabilities", letter: "(d)", label: "Long-term provisions", note: 8 },
  { id: "st_borrowings", side: "equity_liab", group: "(4) Current liabilities", letter: "(a)", label: "Short-term borrowings", note: 9 },
  { id: "trade_payables_msme", side: "equity_liab", group: "(4) Current liabilities", letter: "(b)", label: "Trade payables — dues of micro and small enterprises (MSME)", note: 10 },
  { id: "trade_payables_others", side: "equity_liab", group: "(4) Current liabilities", letter: "(b)", label: "Trade payables — dues of creditors other than micro and small enterprises", note: 10 },
  { id: "other_current_liab", side: "equity_liab", group: "(4) Current liabilities", letter: "(c)", label: "Other current liabilities", note: 11 },
  { id: "st_provisions", side: "equity_liab", group: "(4) Current liabilities", letter: "(d)", label: "Short-term provisions", note: 12 },
  { id: "ppe_intangible", side: "assets", group: "(1) Non-current assets", letter: "(a)", label: "Property, Plant and Equipment and Intangible assets", note: 13 },
  { id: "nc_investments", side: "assets", group: "(1) Non-current assets", letter: "(b)", label: "Non-current investments", note: 14 },
  { id: "deferred_tax_assets", side: "assets", group: "(1) Non-current assets", letter: "(c)", label: "Deferred tax assets (net)", note: 15 },
  { id: "lt_loans_advances", side: "assets", group: "(1) Non-current assets", letter: "(d)", label: "Long-term loans and advances", note: 16 },
  { id: "other_nc_assets", side: "assets", group: "(1) Non-current assets", letter: "(e)", label: "Other non-current assets", note: 17 },
  { id: "current_investments", side: "assets", group: "(2) Current assets", letter: "(a)", label: "Current investments", note: 18 },
  { id: "inventories", side: "assets", group: "(2) Current assets", letter: "(b)", label: "Inventories", note: 19 },
  { id: "trade_receivables", side: "assets", group: "(2) Current assets", letter: "(c)", label: "Trade receivables", note: 20 },
  { id: "cash", side: "assets", group: "(2) Current assets", letter: "(d)", label: "Cash and cash equivalents", note: 21 },
  { id: "st_loans_advances", side: "assets", group: "(2) Current assets", letter: "(e)", label: "Short-term loans and advances", note: 22 },
  { id: "other_current_assets", side: "assets", group: "(2) Current assets", letter: "(f)", label: "Other current assets", note: 23 },
];

/**
 * THE mapping table — account line (the keys below) → Schedule III head. Defaults the CA has not
 * confirmed yet are listed on card R-1855 (needsDecision): TDS / advance tax / GST credit, credit
 * card dues, EMI and business loans (no current-maturity split exists), director loans, licence provision.
 */
export const ACCOUNT_HEAD = {
  // — assets —
  cash_and_bank: "cash",
  undeposited_funds: "cash",
  expenses_paid_unbanked: "cash",           // negative: money already gone, bank line not matched
  receivables: "trade_receivables",
  project_receivable: "trade_receivables",
  tds_receivable: "st_loans_advances",      // balance with government authorities
  advance_tax_paid: "st_loans_advances",
  gst_itc: "st_loans_advances",
  employee_loans_current: "st_loans_advances",
  loans_given_current: "st_loans_advances",
  employee_advances: "st_loans_advances",
  vendor_advances: "st_loans_advances",
  employee_loans_non_current: "lt_loans_advances",
  employee_loans_plain: "lt_loans_advances", // split unknown → non-current, as the sheet's own current ratio does
  loans_given_non_current: "lt_loans_advances",
  loans_given_undecided: "lt_loans_advances", // no due date, not answered → non-current, as the sheet does
  loans_given_plain: "lt_loans_advances",
  fixed_assets: "ppe_intangible",
  // — liabilities —
  payables_msme: "trade_payables_msme",
  payables_others: "trade_payables_others",
  advances_from_customers: "other_current_liab",
  salary_payable: "other_current_liab",
  statutory_dues: "other_current_liab",
  reimbursements_payable: "other_current_liab",
  expenses_payable: "other_current_liab",
  salary_deductions_held: "other_current_liab",
  commission_payable: "other_current_liab",
  credit_card_payable: "other_current_liab",
  gst_payable: "other_current_liab",
  licence_provision: "st_provisions",
  bank_overdraft: "st_borrowings",          // repayable on demand
  emi_loans: "lt_borrowings",
  loans_from_directors: "lt_borrowings",
  business_loans: "lt_borrowings",
  manual_director_loan: "lt_borrowings",
  manual_fixed_asset: "ppe_intangible",
  // — equity —
  equity_share_capital: "share_capital",
  equity_reserves: "reserves_surplus",
  opening_balance_adjustments: "reserves_surplus",
  unexplained_difference: "reserves_surplus", // the balancing figure; flagged on screen until resolved
} as const satisfies Record<string, HeadId>;

export type AccountKey = keyof typeof ACCOUNT_HEAD;

/** Every field of the report's auto figures → the account line(s) it becomes (or why it is not a line of its own). */
export const AUTO_FIELD_KEYS: Record<keyof BalanceSheetAuto, readonly AccountKey[] | "part-of-other-line" | "not-an-amount"> = {
  cashAndBank: ["cash_and_bank"],
  undepositedFunds: ["undeposited_funds"],
  receivables: ["receivables"],
  advancesFromCustomers: ["advances_from_customers"],
  projectReceivable: ["project_receivable"],
  tdsReceivable: ["tds_receivable"],
  employeeLoans: ["employee_loans_current", "employee_loans_non_current", "employee_loans_plain"],
  loansGiven: ["loans_given_current", "loans_given_non_current", "loans_given_undecided", "loans_given_plain"],
  loansCurrent: "part-of-other-line",
  prepaidAdvances: ["employee_advances", "vendor_advances"],
  fixedAssets: ["fixed_assets"],
  fixedAssetsCost: "part-of-other-line",
  accumulatedDepreciation: "part-of-other-line",
  payables: ["payables_msme", "payables_others"],
  salaryPayable: ["salary_payable"],
  salaryDuesPayable: ["statutory_dues"],
  reimbursementsPayable: ["reimbursements_payable"],
  creditCardPayable: ["credit_card_payable"],
  bankOverdraft: ["bank_overdraft"],
  emiLoansPayable: ["emi_loans"],
  businessLoansPayable: ["loans_from_directors", "business_loans"],
  gstPayable: ["gst_itc", "gst_payable"],
  gstPaid: "part-of-other-line",
  advanceTaxPaid: ["advance_tax_paid"],
  expensesPayable: ["expenses_payable"],
  expensesPaidUnbanked: ["expenses_paid_unbanked"],
  salaryOtherDeductions: ["salary_deductions_held"],
  commissionsPayable: ["commission_payable"],
  openingBalanceAdjustments: ["opening_balance_adjustments"],
  fyLabel: "not-an-amount",
};

/**
 * Hand-entered Balance Sheet lines have free labels. Only these clear cases are classified; anything
 * else is shown under "Unmapped — please classify". Equity lines never come here (the equity section
 * already files them under Share capital / Reserves and surplus).
 */
export const MANUAL_RULES: readonly { side: "asset" | "liability"; test: RegExp; key: AccountKey }[] = [
  { side: "asset", test: /fixed asset|furniture|computer|laptop|vehicle|machinery|equipment|building|plant|intangible|software|goodwill/i, key: "manual_fixed_asset" },
  { side: "liability", test: /director/i, key: "manual_director_loan" },
];

export const UNMAPPED_LABEL = "Unmapped — please classify";

export interface DetailLine { accountKey: AccountKey | "unmapped"; label: string; amount: number; side?: Side }

export interface ScheduleIIIInput {
  auto: BalanceSheetAuto | undefined;
  /** Same values the page prints. */
  gstCredit: number;
  gstPayable: number;
  licenceProvision: number | null;
  loanLines: readonly LoanSplitLine[];
  advanceSplit: { employee: number; vendor: number };
  loansTaken: { fromDirectors: number; others: number };
  manualAssets: readonly Pick<BalanceSheetItem, "label" | "amount">[];
  manualLiabilities: readonly Pick<BalanceSheetItem, "label" | "amount">[];
  equity: EquitySection<ManualEquityLine>;
  openingBalanceAdjustments: number;
  /** The page's "Unexplained difference" (balancing figure). */
  unexplained: number;
  /** MSME vendors' outstanding (msme_payables_aging) — null = not read; all payables then sit under "others". */
  msmePayable: number | null;
}

export type RowKind = "section" | "group" | "head" | "detail" | "unmapped_head" | "total";

export interface ScheduleRow {
  kind: RowKind;
  /** Statutory letter / number, e.g. "(a)". */
  ref: string;
  label: string;
  note: number | null;
  /** Current period, whole rupees; null on a heading row. */
  amount: number | null;
  /** Previous period — null until the Balance Sheet can be read as at a past date. */
  previous: null;
  headId: HeadId | null;
  accountKey: AccountKey | "unmapped" | null;
}

export interface ScheduleIII {
  rows: ScheduleRow[];
  totalEquityLiabilities: number;
  totalAssets: number;
  unmapped: DetailLine[];
}

const R = (n: number | null | undefined) => Math.round(n ?? 0);

/** Every account line the sheet holds, with its key (before heads). */
export function accountLines(i: ScheduleIIIInput): DetailLine[] {
  const a = i.auto;
  const out: DetailLine[] = [];
  const add = (accountKey: AccountKey | "unmapped", label: string, amount: number, side?: Side) => {
    if (amount !== 0) out.push({ accountKey, label, amount, ...(side ? { side } : {}) });
  };
  add("cash_and_bank", "Cash & bank balances", R(a?.cashAndBank));
  add("undeposited_funds", "Received, not yet in bank", R(a?.undepositedFunds));
  add("expenses_paid_unbanked", "Less: expenses paid, not yet in bank", -R(a?.expensesPaidUnbanked));
  add("receivables", "Trade receivables (invoiced, unpaid)", R(a?.receivables));
  add("project_receivable", "Project receivables", R(a?.projectReceivable));
  add("tds_receivable", "TDS receivable", R(a?.tdsReceivable));
  add("advance_tax_paid", `Advance tax paid${a?.fyLabel ? ` (${a.fyLabel})` : ""}`, R(a?.advanceTaxPaid));
  add("gst_itc", "GST input credit (ITC)", R(i.gstCredit));
  for (const l of i.loanLines) {
    const base = l.key === "staff" ? "employee_loans" : "loans_given";
    const place = l.place === "non_current" ? "non_current" : l.place;
    add(`${base}_${place}` as AccountKey, l.label, R(l.amount));
  }
  add("employee_advances", "Advances to employees", R(i.advanceSplit.employee));
  add("vendor_advances", "Prepaid / vendor advances", R(i.advanceSplit.vendor));
  add("fixed_assets", "Fixed assets (net block)", R(a?.fixedAssets));
  const payables = R(a?.payables);
  const msme = i.msmePayable === null ? 0 : Math.min(Math.max(0, R(i.msmePayable)), Math.max(0, payables));
  add("payables_msme", "Vendor bills unpaid — MSME vendors", msme);
  add("payables_others", "Vendor bills unpaid — other vendors", payables - msme);
  add("advances_from_customers", "Advances from customers", R(a?.advancesFromCustomers));
  add("salary_payable", "Salary payable", R(a?.salaryPayable));
  add("statutory_dues", "Statutory dues payable (TDS, PF, ESI)", R(a?.salaryDuesPayable));
  add("reimbursements_payable", "Reimbursements payable", R(a?.reimbursementsPayable));
  add("expenses_payable", "Expenses payable", R(a?.expensesPayable));
  add("salary_deductions_held", "Salary deductions held (other)", R(a?.salaryOtherDeductions));
  add("commission_payable", "Commission payable (partners)", R(a?.commissionsPayable));
  add("credit_card_payable", "Credit card payable", R(a?.creditCardPayable));
  add("gst_payable", "GST payable", R(i.gstPayable));
  add("licence_provision", "Licence cost provision (estimate, no vendor bill yet)", R(i.licenceProvision));
  add("bank_overdraft", "Bank overdraft", R(a?.bankOverdraft));
  add("emi_loans", "EMI / asset loans", R(a?.emiLoansPayable));
  add("loans_from_directors", "Loans from directors (unsecured)", R(i.loansTaken.fromDirectors));
  add("business_loans", "Bank / business loans", R(i.loansTaken.others));
  for (const [side, rows] of [["asset", i.manualAssets], ["liability", i.manualLiabilities]] as const) {
    for (const r of rows) {
      const rule = MANUAL_RULES.find((m) => m.side === side && m.test.test(r.label));
      add(rule ? rule.key : "unmapped", `${r.label} (hand-entered)`, R(r.amount), side === "asset" ? "assets" : "equity_liab");
    }
  }
  for (const g of i.equity.groups) {
    const key: AccountKey = g.key === "share_capital" ? "equity_share_capital" : "equity_reserves";
    for (const r of g.rows) {
      if (r.kind === "manual") for (const it of r.items) add(key, it.label, R(it.amount));
      else add(key, r.label, R(r.amount));
    }
  }
  add("opening_balance_adjustments", "Opening Balance Adjustments (invoices imported from Zoho Books)", R(i.openingBalanceAdjustments));
  add("unexplained_difference", "Unexplained difference (balancing figure — resolve before filing)", R(i.unexplained));
  return out;
}

export function buildScheduleIII(i: ScheduleIIIInput): ScheduleIII {
  const lines = accountLines(i);
  const headTotals = new Map<HeadId, number>();
  const headLines = new Map<HeadId, DetailLine[]>();
  const unmapped: DetailLine[] = [];
  for (const l of lines) {
    if (l.accountKey === "unmapped") { unmapped.push(l); continue; }
    const head = ACCOUNT_HEAD[l.accountKey];
    headTotals.set(head, (headTotals.get(head) ?? 0) + l.amount);
    headLines.set(head, [...(headLines.get(head) ?? []), l]);
  }

  const rows: ScheduleRow[] = [];
  const base = { previous: null } as const;
  let eqLiab = 0, assets = 0;
  const sections: { side: Side; title: string }[] = [
    { side: "equity_liab", title: "I. EQUITY AND LIABILITIES" },
    { side: "assets", title: "II. ASSETS" },
  ];
  for (const s of sections) {
    rows.push({ kind: "section", ref: "", label: s.title, note: null, amount: null, headId: null, accountKey: null, ...base });
    let group: string | null | undefined;
    for (const h of HEADS.filter((x) => x.side === s.side)) {
      if (h.group !== group && h.group !== null) {
        rows.push({ kind: "group", ref: "", label: h.group, note: null, amount: null, headId: null, accountKey: null, ...base });
      }
      group = h.group;
      const amount = headTotals.get(h.id) ?? 0;
      if (s.side === "assets") assets += amount; else eqLiab += amount;
      rows.push({ kind: "head", ref: h.letter, label: h.label, note: h.note, amount, headId: h.id, accountKey: null, ...base });
      for (const d of headLines.get(h.id) ?? []) {
        rows.push({ kind: "detail", ref: "", label: d.label, note: null, amount: d.amount, headId: h.id, accountKey: d.accountKey, ...base });
      }
    }
    const un = unmapped.filter((u) => (u.side ?? "equity_liab") === s.side);
    if (un.length) {
      const sum = un.reduce((t, u) => t + u.amount, 0);
      if (s.side === "assets") assets += sum; else eqLiab += sum;
      rows.push({ kind: "unmapped_head", ref: "", label: UNMAPPED_LABEL, note: null, amount: sum, headId: null, accountKey: "unmapped", ...base });
      for (const u of un) rows.push({ kind: "detail", ref: "", label: u.label, note: null, amount: u.amount, headId: null, accountKey: "unmapped", ...base });
    }
    rows.push({
      kind: "total", ref: "", label: s.side === "assets" ? "TOTAL ASSETS" : "TOTAL EQUITY AND LIABILITIES", note: null,
      amount: s.side === "assets" ? assets : eqLiab, headId: null, accountKey: null, ...base,
    });
  }
  return { rows, totalEquityLiabilities: eqLiab, totalAssets: assets, unmapped };
}

/** Does the Schedule III tie to the Balance Sheet the page shows? The differences say what is missing / extra. */
export function scheduleIIITie(
  s: Pick<ScheduleIII, "totalAssets" | "totalEquityLiabilities">,
  sheet: { totalAssets: number; totalLiab: number; netWorth: number },
) {
  const assetsDiff = s.totalAssets - R(sheet.totalAssets);
  const eqLiabDiff = s.totalEquityLiabilities - R(sheet.totalLiab + sheet.netWorth);
  return { ties: assetsDiff === 0 && eqLiabDiff === 0 && s.totalAssets === s.totalEquityLiabilities, assetsDiff, eqLiabDiff };
}

export const CSV_HEADERS = ["Particulars", "Note", "Current period (INR)", "Previous period (INR)", "Account line / head"];
export const PREVIOUS_NA = "n/a";

/** CSV = the view's rows, one for one, same amounts. */
export function scheduleIIICsvRows(s: ScheduleIII, asOf: string, companyName: string | null): (string | number)[][] {
  const out: (string | number)[][] = [
    [companyName ? `${companyName} — Balance Sheet as at ${asOf}` : `Balance Sheet as at ${asOf}`, "", "", "", ""],
    ["(Schedule III, Division I — all amounts in INR)", "", "", "", ""],
  ];
  for (const r of s.rows) {
    const indent = r.kind === "detail" ? "      " : r.kind === "head" ? "   " : "";
    const where = r.kind === "detail"
      ? `${r.accountKey} → ${r.headId ?? "unmapped"}`
      : r.kind === "head" ? (r.headId ?? "") : r.kind === "unmapped_head" ? "unmapped" : "";
    out.push([
      `${indent}${r.ref ? `${r.ref} ` : ""}${r.label}`,
      r.note ?? "",
      r.amount === null ? "" : r.amount,
      r.amount === null ? "" : PREVIOUS_NA,
      where,
    ]);
  }
  return out;
}
