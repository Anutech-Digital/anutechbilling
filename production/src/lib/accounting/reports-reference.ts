/**
 * PARITY ORACLE — S17 se pehle ke report hooks ka hisaab, jaisa ka taisa.
 *
 * 28 Sep 2026 ko Balance Sheet, P&L aur Ledger ka jod SQL me gaya (migration
 * 20260928110000). Shart thi: numbers BILKUL wahi rahein. Ye file us shart ka saboot hai —
 * `useBalanceSheetAuto` / `usePnL` / ledger hooks ke purane queryFn ki body, fetch hata kar,
 * line-by-line. Input wahi rows jo purane supabase-js reads laate the (same filters);
 * tests/parity/reports-parity.test.ts wo rows local DB se nikaal kar isme daalta hai aur
 * RPC + mapper ke jawab se milata hai.
 *
 * APP ISE IMPORT NAHI KARTA. Isme "sudhaar" mat karo — sudhaar SQL + mapper me hota hai,
 * aur tab yahan wahi badlaav jaan-boojh kar, test ke saath, kiya jaata hai. Warna parity
 * test ek aisi cheez se milata rahega jo kabhi chali hi nahi.
 */
import { computeCustomerAdvances, computeOwedBackToCustomers, computeTradeReceivables, type BalanceSheetAuto } from "@/lib/queries/balance-sheet";
import type { LedgerEntry } from "@/lib/accounting/ledger";
import type { LedgerVendor } from "@/lib/queries/ledger";
import { incomeTaxPaidForFy, type TaxPaymentLike } from "@/lib/accounting/tax-payments";
import { splitItc } from "@/lib/gst/itc";
import { statutoryDues } from "@/lib/accounting/tds-deductor";
import { bookValueNow, type AssetLike } from "@/lib/accounting/depreciation";
import { buildPnl } from "@/lib/accounting/pnl";
import { buildExpenseReport } from "@/lib/accounting/expense-report";
import { projectCostForPeriod } from "@/lib/accounting/project-cost";
import type { PnLNumbers, PnlMasters } from "@/lib/accounting/pnl-assemble";
import { toIstDate } from "@/lib/dates/ist";

type N = number | null;

/* ═══ Balance sheet ═════════════════════════════════════════════════════════ */

export interface BsRawRows {
  accounts: { id: string; opening_balance: N; account_type: string }[];
  /** bank_account_current_balance(id) har account ka — purana N+1. */
  balanceOf: Record<string, number | null>;
  /** R-179: received payments jin par koi bank line match nahi, aur project payments bina bank_txn_id. */
  /** S45: `tds` = tds_receivable.tds_amount on that payment (never cash). */
  unbankedPays: { amount: N; tds?: N }[];
  unbankedProjPays: { amount: N }[];
  openInv: { id: string; amount: N; net_payable: N; paid_amount?: N; status: string }[];
  msInv: { invoice_id: string | null }[];
  recdPays: { quote_id: string | null; amount: N; status: string }[];
  quoteInv: { id: string; invoice_id: string | null }[];
  /** S45: each quote's single, non-project invoice — received vs invoice ± notes. */
  invoicedQuotes?: { received: number; invoice_amount: number; credit_notes: number; debit_notes: number }[];
  projs: { id: string }[];
  ms: { project_id: string; total_amount: N; invoice_id: string | null }[];
  projPays: { project_id: string; amount: N }[];
  tds: { tds_amount: N; status: string }[];
  loans: { id: string; principal: N }[];
  loanReps: { amount: N }[];
  advs: { total_amount: N; consumed_amount: N }[];
  emiP: { id: string; total_cost: N; financed: N }[];
  emiPay: { principal_part: N }[];
  fa: (AssetLike & { emi_purchase_id: string | null })[];
  bizLoans: { id: string; principal: N }[];
  bizPays: { principal_part: N }[];
  bills: { total: N; paid_amount: N; status: string }[];
  salRows: { net: N; paid_amount: N; tds: N; pf: N; esi: N; pf_employer: N; esi_employer: N; paid_status: string }[];
  duesPaid: { kind: string; amount: N }[];
  vendorTdsRows: { tds_amount: N }[];
  reimb: { amount: N; status: string }[];
  invoices: { amount: N; tax_amount: N; tax_rate: N; invoice_date: string; status: string }[];
  cnFy: { tax_amount: N; credit_date: string }[];
  dnFy: { tax_amount: N; debit_date: string }[];
  fyBills: { cgst: N; sgst: N; igst: N; bill_date: string }[];
  fyExp: { gst_paid: N; expense_date: string; vendor_id: string | null; bill_type: string | null; category: string | null }[];
  vendorRows: { id: string; gstin: string | null }[];
  taxRows: TaxPaymentLike[];
}

/** `todayIso` = IST aaj (purana `new Date(Date.now() + 5.5h).toISOString().slice(0, 10)`). */
export function referenceBalanceSheet(r: BsRawRows, todayIso: string): BalanceSheetAuto {
  let cashAndBank = 0;
  let creditCardPayable = 0;
  for (const a of r.accounts) {
    const bal = r.balanceOf[a.id];
    const balance = (bal as number | null) ?? a.opening_balance ?? 0;
    if (a.account_type === "credit_card") {
      if (balance < 0) creditCardPayable += -balance;
      else             cashAndBank += balance;
    } else {
      cashAndBank += balance;
    }
  }

  /* R-179 — jaan-boojh kar badlaav (migration 20261006140000): mila paisa jo bank line se
     match nahi hua, asset. Pehle ye kahin nahi gina jaata tha. */
  /* S45 — jaan-boojh kar badlaav (migration 20261007290000): payment ka TDS cash nahi
     (tds_receivable me hai); part payment receivable ghatata hai; invoice ke baad customer
     ka bakaaya (overpayment / paid invoice par credit note) liability. */
  const undepositedFunds = r.unbankedPays.reduce((s, p) => s + (p.amount ?? 0) - (p.tds ?? 0), 0)
                         + r.unbankedProjPays.reduce((s, p) => s + (p.amount ?? 0), 0);

  const projectInvoiceIds = new Set(r.msInv.map((m) => m.invoice_id as string));
  const receivables = computeTradeReceivables(r.openInv, projectInvoiceIds);
  const advancesFromCustomers = computeCustomerAdvances(r.recdPays, r.quoteInv)
                              + computeOwedBackToCustomers(r.invoicedQuotes ?? []);

  const projIds = r.projs.map((p) => p.id);
  let projectReceivable = 0;
  if (projIds.length > 0) {
    const invoicedByProject = new Map<string, number>();
    for (const m of r.ms) if (m.invoice_id) invoicedByProject.set(m.project_id, (invoicedByProject.get(m.project_id) ?? 0) + (m.total_amount ?? 0));
    const paidByProject = new Map<string, number>();
    for (const p of r.projPays) paidByProject.set(p.project_id, (paidByProject.get(p.project_id) ?? 0) + (p.amount ?? 0));
    for (const id of projIds) projectReceivable += Math.max(0, (invoicedByProject.get(id) ?? 0) - (paidByProject.get(id) ?? 0));
  }

  const tdsReceivable = r.tds.reduce((s, x) => s + (x.tds_amount ?? 0), 0);

  const loanPrincipal = r.loans.reduce((s, l) => s + (l.principal ?? 0), 0);
  const loanRepaid    = r.loanReps.reduce((s, x) => s + (x.amount ?? 0), 0);
  const employeeLoans = Math.max(0, loanPrincipal - loanRepaid);

  const prepaidAdvances = r.advs.reduce((s, a) => s + Math.max(0, (a.total_amount ?? 0) - (a.consumed_amount ?? 0)), 0);

  const registeredEmi = new Set(r.fa.map((a) => a.emi_purchase_id).filter(Boolean));
  const fixedAssets     = r.fa.reduce((s, a) => s + bookValueNow(a as AssetLike, todayIso), 0)
                        + r.emiP.filter((x) => !registeredEmi.has(x.id)).reduce((s, x) => s + (x.total_cost ?? 0), 0);
  const emiFinanced     = r.emiP.reduce((s, x) => s + (x.financed ?? 0), 0);
  const emiPrincipalPaid = r.emiPay.reduce((s, x) => s + (x.principal_part ?? 0), 0);
  const emiLoansPayable = Math.max(0, emiFinanced - emiPrincipalPaid);

  const bizBorrowed  = r.bizLoans.reduce((s, l) => s + (l.principal ?? 0), 0);
  const bizPrincipalPaid = r.bizPays.reduce((s, p) => s + (p.principal_part ?? 0), 0);
  const businessLoansPayable = Math.max(0, bizBorrowed - bizPrincipalPaid);

  const payables = r.bills.reduce((s, b) => s + Math.max(0, (b.total ?? 0) - (b.paid_amount ?? 0)), 0);

  const salaryPayable = r.salRows
    .filter((x) => x.paid_status !== "paid")
    .reduce((s, x) => s + Math.max(0, (x.net ?? 0) - (x.paid_amount ?? 0)), 0);
  const salaryDuesPayable = statutoryDues({
    salaries: r.salRows,
    vendorTds: r.vendorTdsRows.reduce((s, x) => s + (x.tds_amount ?? 0), 0),
    paid: r.duesPaid,
  }).payable;

  const reimbursementsPayable = r.reimb.reduce((s, x) => s + (x.amount ?? 0), 0);

  const [y, m] = todayIso.split("-").map(Number);
  const fyStartYear = m < 4 ? y - 1 : y;
  const fyLabel = `FY ${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}`;

  const invGST = r.invoices.reduce(
    (s, i) => s + (i.tax_amount ?? Math.round((i.amount ?? 0) * (i.tax_rate ?? 18) / (100 + (i.tax_rate ?? 18)))), 0);
  const cnGST = r.cnFy.reduce((s, n) => s + (n.tax_amount ?? 0), 0);
  const dnGST = r.dnFy.reduce((s, n) => s + (n.tax_amount ?? 0), 0);
  const outputGST = invGST - cnGST + dnGST;

  const billsGst = r.fyBills.reduce((s, b) => s + (b.cgst ?? 0) + (b.sgst ?? 0) + (b.igst ?? 0), 0);

  const vendorGstinOf = new Map(r.vendorRows.map((v) => [v.id, v.gstin ?? null]));
  const expGst = splitItc(r.fyExp.map((e) => ({
    gst_paid: e.gst_paid, bill_type: e.bill_type, category: e.category,
    vendorGstin: e.vendor_id ? vendorGstinOf.get(e.vendor_id) ?? null : null,
  }))).eligible;

  const gstPaid = r.taxRows.filter((p) => p.kind === "gst").reduce((s, p) => s + (p.amount ?? 0), 0);
  const advanceTaxPaid = incomeTaxPaidForFy(r.taxRows, fyStartYear);
  const gstPayable = outputGST - billsGst - expGst - gstPaid;

  return { cashAndBank, undepositedFunds, receivables, advancesFromCustomers, projectReceivable, tdsReceivable, employeeLoans, prepaidAdvances, fixedAssets, payables, salaryPayable, salaryDuesPayable, reimbursementsPayable, creditCardPayable, emiLoansPayable, businessLoansPayable, gstPayable, gstPaid, advanceTaxPaid,
    /* S45 slice 2 heads (migration 20261009170000) are SQL-only — the old per-row code never had them. */
    expensesPayable: 0, expensesPaidUnbanked: 0, salaryOtherDeductions: 0, fyLabel };
}

/* ═══ P&L ═══════════════════════════════════════════════════════════════════ */

export interface PnlRawRows {
  invoices: { id: string; amount: N; status: string; invoice_date: string; net_payable: N; taxable_value: N; tax_amount: N; tax_rate: N }[];
  cnP: { invoice_id: string | null; taxable_value: N; tax_amount: N; credit_date: string }[];
  dnP: { invoice_id: string | null; taxable_value: N; tax_amount: N; debit_date: string }[];
  bills: { total: N; subtotal: N; cgst: N; sgst: N; igst: N; category: string }[];
  expenses: {
    amount: N; gst_paid: N; category: string | null; vendor_name: string | null; vendor_id: string | null;
    bill_type: string | null; expense_date: string; project_id: string | null; description: string | null;
  }[];
  vendorRows: { id: string; gstin: string | null }[];
  comms: { gross_commission: N; earned_date: string; status: string }[];
  milestones: { project_id: string; invoice_id: string | null }[];
}

export function referencePnl(range: { from: string; to: string }, r: PnlRawRows, m: PnlMasters): PnLNumbers {
  const invoices = r.invoices;
  const invTaxable = (i: { amount: N; taxable_value: N; tax_rate: N }) =>
    i.taxable_value ?? Math.round((i.amount ?? 0) * 100 / (100 + (i.tax_rate ?? 18)));
  const invTax = (i: { amount: N; tax_amount: N; taxable_value: N; tax_rate: N }) =>
    i.tax_amount ?? ((i.amount ?? 0) - invTaxable(i));

  const cnP = r.cnP, dnP = r.dnP;
  const cnTaxable = cnP.reduce((s, n) => s + (n.taxable_value ?? 0), 0);
  const cnTax     = cnP.reduce((s, n) => s + (n.tax_amount ?? 0), 0);
  const dnTaxable = dnP.reduce((s, n) => s + (n.taxable_value ?? 0), 0);
  const dnTax     = dnP.reduce((s, n) => s + (n.tax_amount ?? 0), 0);

  const revenue       = invoices.reduce((s, i) => s + invTaxable(i), 0) - cnTaxable + dnTaxable;
  const revenueCount  = invoices.length;
  const outputGST     = invoices.reduce((s, i) => s + invTax(i), 0) - cnTax + dnTax;

  const bills = r.bills;
  const cogs      = bills.reduce((s, b) => s + (b.subtotal ?? 0), 0);
  const cogsCount = bills.length;
  const billsGst  = bills.reduce((s, b) => s + (b.cgst ?? 0) + (b.sgst ?? 0) + (b.igst ?? 0), 0);

  const expenses = r.expenses;
  const expenseReport = buildExpenseReport(expenses);

  const vendorGstin = new Map(r.vendorRows.map((v) => [v.id, v.gstin ?? null]));
  const itc = splitItc(expenses.map((e) => ({
    gst_paid: e.gst_paid, bill_type: e.bill_type, category: e.category,
    vendorGstin: e.vendor_id ? vendorGstin.get(e.vendor_id) ?? null : null,
  })));

  const expensesPaid  = expenses.reduce((s, e) => s + (e.amount ?? 0), 0);
  const expensesTotal = expensesPaid - itc.eligible;
  const expensesCount = expenses.length;
  const expensesGst   = itc.eligible;

  const catAgg = expenses.reduce<Record<string, { total: number; count: number }>>((acc, e) => {
    const c = e.category || "Uncategorised";
    (acc[c] ??= { total: 0, count: 0 }).total += e.amount ?? 0;
    acc[c].count += 1;
    return acc;
  }, {});
  const expensesByCategory = Object.entries(catAgg)
    .map(([category, v]) => ({ category, total: v.total, count: v.count }))
    .sort((a, b) => b.total - a.total);

  const commissions      = r.comms.reduce((s, c) => s + (c.gross_commission ?? 0), 0);
  const commissionsCount = r.comms.length;

  const projectByInvoice = new Map(r.milestones.map((x) => [String(x.invoice_id), x.project_id]));
  const revenueByProjectMap = new Map<string, number>();
  for (const i of invoices) {
    const pid = projectByInvoice.get(String(i.id));
    if (pid) revenueByProjectMap.set(pid, (revenueByProjectMap.get(pid) ?? 0) + invTaxable(i));
  }
  for (const n of dnP) {
    const pid = n.invoice_id ? projectByInvoice.get(String(n.invoice_id)) : undefined;
    if (pid) revenueByProjectMap.set(pid, (revenueByProjectMap.get(pid) ?? 0) + (n.taxable_value ?? 0));
  }
  for (const n of cnP) {
    const pid = n.invoice_id ? projectByInvoice.get(String(n.invoice_id)) : undefined;
    if (pid) revenueByProjectMap.set(pid, (revenueByProjectMap.get(pid) ?? 0) - (n.taxable_value ?? 0));
  }
  const revenueByProject = [...revenueByProjectMap.entries()].map(([project_id, rev]) => ({ project_id, revenue: rev }));
  const projectRevenue = revenueByProject.reduce((s, x) => s + x.revenue, 0);

  const projectCost = projectCostForPeriod({
    from: range.from, to: range.to,
    allocations: m.allocations,
    monthlyGross: m.monthlyGross,
    projects: m.projects,
    expenses,
    revenueByProject,
  });

  const model = buildPnl({
    revenue,
    expenses: expensesTotal + commissions,
    billedCogs: cogs > 0 ? cogs : null,
    vendors: m.vendors,
    projectCost: projectCost.total,
    projectRevenue,
  });

  const grossMargin = revenue - cogs;
  const netProfit   = grossMargin - expensesTotal - commissions;
  const inputGST    = billsGst + expensesGst;
  const netGST      = outputGST - inputGST;
  const marginPct = revenue > 0 ? (grossMargin / revenue) * 100 : 0;
  const profitPct = revenue > 0 ? (netProfit / revenue) * 100   : 0;

  return {
    revenue, revenueCount, cogs, cogsCount, grossMargin,
    expenses: expensesTotal, expensesCount, expensesByCategory, expenseReport,
    commissions, commissionsCount, netProfit,
    outputGST, inputGST, netGST, itcBlocked: itc.blocked,
    marginPct, profitPct, model, projectCost, employeeNames: m.employeeNames,
  };
}

/** P&L trend page ka purana per-row input (monthlySeries isi ko bucket karta tha). */
export function referencePnlMonthlyRows(
  inv: { invoice_date: string; amount: N; taxable_value: N; tax_rate: N }[],
  exp: { expense_date: string; amount: N }[],
  /* S39: credit note us mahine ka revenue ghataata hai, debit note badhata hai — headline
     referencePnl jaisa. (Pehle trend inhe chhod deta tha; ye niyam jaan-boojh kar badla gaya.) */
  cn: { credit_date: string; taxable_value: N }[] = [],
  dn: { debit_date: string; taxable_value: N }[] = [],
) {
  return {
    revenue: [
      ...inv.map((i) => ({
        date: i.invoice_date,
        amount: i.taxable_value ?? Math.round((i.amount ?? 0) * 100 / (100 + (i.tax_rate ?? 18))),
      })),
      ...cn.map((c) => ({ date: c.credit_date, amount: -(c.taxable_value ?? 0) })),
      ...dn.map((d) => ({ date: d.debit_date, amount: d.taxable_value ?? 0 })),
    ],
    expenses: exp.map((e) => ({ date: e.expense_date, amount: e.amount ?? 0 })),
  };
}

/* ═══ Ledger ════════════════════════════════════════════════════════════════ */

function isoDay(v: string | null | undefined): string | null {
  return v ? v.slice(0, 10) : null;
}

/** S39: timestamp (received_at / refunded_at) ka IST din. Pehle `.slice(0, 10)` UTC din deta
 *  tha, to 00:00–05:30 IST ka payment pichhle din chadhta tha. Sirf timestamps ke liye —
 *  `date` columns (invoice_date, credit_date) par isoDay hi sahi hai. */
function istDay(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return isoDay(v);
  return toIstDate(t);
}

export function referenceCustomerLedgerEntries(r: {
  inv: { id: string; invoice_date: string; amount: N; customer_name: string; status: string }[];
  pay: { id: string; receipt_voucher_no: string | null; amount: N; received_at: string; refunded_at: string | null; status: string; method: string; reference: string | null }[];
  cn: { id: string; credit_date: string; amount: N; reason: string | null; invoice_id: string | null }[];
  dn: { id: string; debit_date: string; amount: N; reason: string | null; invoice_id: string | null }[];
}): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const i of r.inv) {
    const d = isoDay(i.invoice_date);
    if (!d) continue;
    entries.push({ date: d, reference: i.id, voucher: "Sales", narration: null, amount: i.amount ?? 0, increasesLiability: true });
  }
  for (const p of r.pay) {
    const received = istDay(p.received_at);
    if (received) {
      entries.push({
        date: received, reference: p.receipt_voucher_no ?? p.id, voucher: "Receipt",
        narration: [p.method, p.reference].filter(Boolean).join(" · ") || null,
        amount: p.amount ?? 0, increasesLiability: false,
      });
    }
    const refunded = istDay(p.refunded_at);
    if (p.status === "refunded" && refunded) {
      entries.push({
        date: refunded, reference: `${p.receipt_voucher_no ?? p.id} · refunded`, voucher: "Refund",
        narration: "Payment returned to the customer", amount: p.amount ?? 0, increasesLiability: true,
      });
    }
  }
  for (const c of r.cn) {
    const d = isoDay(c.credit_date);
    if (!d) continue;
    entries.push({
      date: d, reference: c.id, voucher: "Credit Note",
      narration: c.reason ?? (c.invoice_id ? `against ${c.invoice_id}` : null),
      amount: c.amount ?? 0, increasesLiability: false,
    });
  }
  for (const d0 of r.dn) {
    const d = isoDay(d0.debit_date);
    if (!d) continue;
    entries.push({
      date: d, reference: d0.id, voucher: "Debit Note",
      narration: d0.reason ?? (d0.invoice_id ? `against ${d0.invoice_id}` : null),
      amount: d0.amount ?? 0, increasesLiability: true,
    });
  }
  return entries;
}

export function referenceVendorLedgerEntries(rows: {
  id: string; bill_no: string | null; category: string | null; amount: N; expense_date: string;
  paid: boolean; paid_date: string | null; payment_method: string | null;
}[]): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const e of rows) {
    const billed = isoDay(e.expense_date);
    const ref = e.bill_no ?? e.id;
    if (billed) {
      entries.push({ date: billed, reference: ref, voucher: "Purchase", narration: e.category ?? null, amount: e.amount ?? 0, increasesLiability: true });
    }
    const paidOn = isoDay(e.paid_date);
    if (e.paid && paidOn) {
      entries.push({ date: paidOn, reference: `${ref} · paid`, voucher: "Payment", narration: e.payment_method ?? null, amount: e.amount ?? 0, increasesLiability: false });
    }
  }
  return entries;
}

/** Purane useLedgerVendors ka jod — isPayroll ke bina (wo mapper aur ye dono ek hi niyam se). */
export function referenceLedgerVendors(rows: { vendor_name: string | null; amount: N; category: string | null }[]): Omit<LedgerVendor, "isPayroll">[] {
  const byName = new Map<string, { billed: number; bills: number; cats: Map<string, number> }>();
  for (const r of rows) {
    const name = (r.vendor_name ?? "").trim();
    if (!name) continue;
    const prev = byName.get(name) ?? { billed: 0, bills: 0, cats: new Map<string, number>() };
    prev.billed += r.amount ?? 0;
    prev.bills += 1;
    const cat = (r.category ?? "").trim();
    if (cat) prev.cats.set(cat, (prev.cats.get(cat) ?? 0) + (r.amount ?? 0));
    byName.set(name, prev);
  }
  return [...byName.entries()]
    .map(([name, v]) => ({ name, billed: v.billed, bills: v.bills, categories: [...v.cats.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c) }))
    .sort((a, b) => b.billed - a.billed);
}
