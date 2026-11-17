/**
 * R-2681 (17 Nov 2026) — Zoho's OWN account type keeps balance-sheet accounts out of the FY purchase
 * import, whatever the owner mapped them to (the category map is shared with bills and editable).
 * Excel's 727 no-vendor Zoho expenses hold ~Rs 1.25 Cr on such accounts: fixed deposit, Output GST,
 * GST Return, loans, advances.
 *
 * The types come from Zoho's chart of accounts (fy-fetch.ts readChartOfAccounts), stored per company in
 * zoho_account_types by the server when it reads from Zoho (route.ts). The SQL import
 * (import_zoho_fy_purchases, migration 20261117125913) is the last word; the preview (plan.ts) says the
 * same sentences in the same order:
 *   1. the company's types never read → TYPES_NOT_READ (fail closed);
 *   2. a line whose type is known and not an expense type → "Not an expense — needs another path: …";
 *      else a line whose account is missing from the read types → "… is not read yet" (fail closed);
 *   3. owner decision 17 Nov ("Haan, teeno"): a line on an UNMAPPED account leaves the document out —
 *      no more "Unmapped — review" landing; a Zoho expense with no vendor keeps R-2676's own sentence.
 *   4. R-2911 (17 Nov, corrects R-2681's salary part): a line on a SALARY account (Salaries can never be
 *      mapped — it is Payroll's category) is not "unmapped": it comes in as Salaries, unless Payroll
 *      already books that salary for the month (salaryPayrollRefusal). Why: Excel's Payroll starts Jun
 *      2026, so for FY 2025-26 Zoho's salary expenses are the ONLY salary record — refusing them dropped
 *      real cost from the books.
 */
import type { ZohoAccount } from "../fy-fetch";
import { periodLabelShort } from "@/lib/payroll/period-label";

/** Zoho's P&L cost types — the same list as SQL _r2681_is_expense_type. */
export const EXPENSE_TYPES: readonly string[] = ["expense", "other_expense", "cost_of_goods_sold"];

export const isExpenseType = (t: string | null | undefined): boolean =>
  typeof t === "string" && EXPENSE_TYPES.includes(t.trim().toLowerCase());

/** "other_current_liability" → "other current liability" (as the SQL's replace(type, '_', ' ')). */
export const typeLabel = (t: string): string => t.replace(/_/g, " ");

export const TYPES_NOT_READ = "Zoho account types are not read yet — press Read from Zoho again, then preview again.";
/** A Zoho line with no account cannot be typed or mapped — it never comes in by itself. */
export const NO_ACCOUNT_LINE = "A line has no account in Zoho — add it by hand.";

/** Stored types older than this are read again with the next Zoho read (one call per 200 accounts). */
export const TYPES_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export const NOT_AN_EXPENSE_PREFIX = "Not an expense — needs another path";

export function notAnExpenseReason(name: string, type: string): string {
  return `${NOT_AN_EXPENSE_PREFIX}: in Zoho, "${name}" is an account of type "${typeLabel(type)}". Fixed deposits, loans, GST, assets and advances are never booked as an expense.`;
}

interface Line { accountId: string; accountName: string }
const nameOf = (l: Line) => l.accountName.trim() || l.accountId.trim() || "?";

/**
 * Why a document cannot come in by Zoho's account type; null when every line is an expense type.
 * `types` = this company's stored types (Zoho account id → type); empty = never read.
 */
export function accountTypeRefusal(lines: readonly Line[], types: Readonly<Record<string, string>>): string | null {
  if (lines.some((l) => !l.accountId.trim())) return NO_ACCOUNT_LINE;
  if (Object.keys(types).length === 0) return TYPES_NOT_READ;
  const known = lines.find((l) => {
    const t = types[l.accountId];
    return t !== undefined && !isExpenseType(t);
  });
  if (known) return notAnExpenseReason(nameOf(known), types[known.accountId]);
  const missing = lines.find((l) => types[l.accountId] === undefined);
  if (missing) return `Zoho's account type for "${nameOf(missing)}" is not read yet — press Read from Zoho again, then preview again.`;
  return null;
}

/**
 * R-2911: a Zoho account whose NAME says salary — "salar…" or the word "wage(s)", each at a word start
 * (the same pattern as SQL _r2911_is_salary_account). "Sewage" and "Payroll processing fees" are not.
 */
const SALARY = /\b(salar|wages?\b)/i;
export const isSalaryAccount = (accountName: string): boolean => SALARY.test(accountName ?? "");

/** R-2676's sentence for a Zoho expense with no vendor on an unmapped account (R-2911: a salary no longer "stays out"). */
export function noVendorUnmappedReason(name: string): string {
  return `Zoho account "${name}" is not mapped to an expense category — map it only if it is an expense. A fixed deposit, loan, GST or asset payment is not an expense and stays out.`;
}

/**
 * Owner decision 17 Nov: a line on an unmapped account leaves the whole document out. `isMapped` says
 * whether a LINE has a category (plan.ts lineCategory — R-2911: a salary account is Salaries, never
 * unmapped). `noVendor` = a Zoho EXPENSE with no vendor name and no Zoho vendor id (R-2676's sentence).
 */
export function unmappedRefusal(lines: readonly Line[], isMapped: (line: Line) => boolean, noVendor: boolean): string | null {
  const l = lines.find((x) => !isMapped(x));
  if (!l) return null;
  const name = nameOf(l);
  if (noVendor) return noVendorUnmappedReason(name);
  return `Zoho account "${name}" is not mapped — left out for now (owner, 17 Nov). Map it only if it is an expense.`;
}

/* ── R-2911: a Zoho salary vs the app's Payroll ─────────────────────────────────────────────────── */

/** This company's Payroll, as far as the salary rule needs it. */
export interface PayrollFacts {
  employees: ReadonlyArray<{ id: string; name: string }>;
  /** salary_payments: period "YYYY-MM", payDate "YYYY-MM-DD". */
  payslips: ReadonlyArray<{ employeeId: string; period: string; payDate: string }>;
}
export const NO_PAYROLL: PayrollFacts = { employees: [], payslips: [] };

/** The preview's line for a Zoho salary that comes in as Salaries. */
export const SALARY_FROM_ZOHO_NOTE = "Salary from Zoho — no payslip in Payroll for that month.";
/** A Salaries leg on a Zoho BILL: it would land unpaid, and no pay path lists an unpaid Salaries row. */
export const SALARY_BILL_REASON = "A Zoho salary bill stays out — an unpaid salary has no pay path in the app. Pay it in Payroll, or add it by hand as a paid expense.";
/** A Salaries leg with TDS: salary TDS (192, 24Q) is Payroll's, not a vendor's TDS (26Q). */
export const SALARY_TDS_REASON = "A Zoho salary with TDS stays out — salary TDS (section 192) is booked by Payroll. Add this salary in Payroll.";

/** Lower case, every run of other characters one space, padded — as SQL _r2911_words. */
const words = (s: string): string => ` ${(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/** Who Zoho paid, as text: the vendor (payee) name, Zoho's reference and every line's description — as the SQL. */
export function salaryPayeeText(f: { vendorName: string; reference?: string; lines: ReadonlyArray<{ description: string }> }): string {
  return [f.vendorName, f.reference ?? "", ...f.lines.map((l) => l.description)].join(" ");
}

/**
 * Employees the payee text names: the employee's whole name, or its first word (3+ letters), as whole
 * words ("Emp Prashant ( Salary )" → Prashant). Sorted by name, then id (the SQL's order, collate "C").
 */
export function employeesNamed(payee: string, employees: PayrollFacts["employees"]): Array<{ id: string; name: string }> {
  const p = words(payee);
  return employees.filter((e) => {
    const n = words(e.name).trim();
    if (!n) return false;
    if (p.includes(` ${n} `)) return true;
    const first = n.split(" ")[0];
    return first.length >= 3 && p.includes(` ${first} `);
  }).sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const prevMonth = (ym: string): string => {
  const y = Number(ym.slice(0, 4)); const m = Number(ym.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
/** "2025-06-03" → "03 Jun 2025" (SQL to_char(date, 'DD Mon YYYY')). */
const dayLabel = (d: string) => `${d.slice(8, 10)} ${periodLabelShort(d)}`;

/**
 * Does this payslip pay the salary a Zoho row dated `date` records? Its period is the row's month, or
 * the month before AND it was paid within 7 days of the row (May's salary paid 3 Jun, Zoho row 4 Jun).
 * A May payslip paid 3 Jun does not cover a Zoho row of 30 Jun (that is June's salary).
 */
export function payslipCovers(p: PayrollFacts["payslips"][number], date: string): boolean {
  const ym = date.slice(0, 7);
  return p.period === ym || (p.period === prevMonth(ym) && dayDiff(p.payDate, date) <= 7);
}
const firstSlip = (a: PayrollFacts["payslips"][number], b: PayrollFacts["payslips"][number]) => cmp(a.period, b.period) || cmp(a.payDate, b.payDate);

/**
 * R-2911: why a Zoho salary dated `date` must NOT come in; null when it comes in.
 *   - the payee names an employee with a payslip that covers it (payslipCovers) → Payroll already books
 *     it: refused, it would count twice;
 *   - the payee names employees, none with such a payslip → comes in (Payroll has no record of it);
 *   - the payee names no employee → comes in only when no payslip of anyone covers it (otherwise it
 *     cannot be shown to be someone else: refused, add it by hand).
 */
export function salaryPayrollRefusal(payee: string, date: string, payroll: PayrollFacts): string | null {
  const named = employeesNamed(payee, payroll.employees);
  if (named.length) {
    for (const e of named) {
      const slip = payroll.payslips.filter((p) => p.employeeId === e.id && payslipCovers(p, date)).sort(firstSlip)[0];
      if (slip) {
        return `Payroll already books this salary — ${e.name}'s payslip for ${periodLabelShort(slip.period)} (paid ${dayLabel(slip.payDate)}) is in Payroll, so this Zoho salary is not imported (it would count twice). If it is a different payment, add it by hand.`;
      }
    }
    return null;
  }
  const any = payroll.payslips.filter((p) => payslipCovers(p, date)).sort(firstSlip)[0];
  return any
    ? `Payroll has salaries for ${periodLabelShort(any.period)} and Zoho's payee is not an employee in Payroll — add it by hand if it is someone else (it could count twice).`
    : null;
}

/**
 * Read Zoho's chart of accounts again? None stored, the newest read is older than TYPES_MAX_AGE_MS, or
 * older than the start of the current Zoho list read (`readStartedAt` — "Read from Zoho again" starts a
 * new one, so an account made in Zoho since the last read gets its type on that press).
 */
export function typesStale(newestReadAt: string | null, nowMs: number, readStartedAt: string | null = null): boolean {
  if (!newestReadAt) return true;
  const t = Date.parse(newestReadAt);
  if (!Number.isFinite(t) || nowMs - t > TYPES_MAX_AGE_MS) return true;
  const s = readStartedAt ? Date.parse(readStartedAt) : NaN;
  return Number.isFinite(s) && t < s;
}

/** Rows for save_zoho_account_types from Zoho's chart of accounts (ids and types trimmed; empty / repeated ones dropped). */
export function accountTypeRows(accounts: readonly ZohoAccount[]) {
  const seen = new Set<string>();
  const out: Array<{ zoho_account_id: string; zoho_account_name: string; account_type: string }> = [];
  for (const a of accounts) {
    const id = a.id.trim();
    const type = a.type.trim().toLowerCase();
    if (!id || id.length > 40 || !type || type.length > 60 || seen.has(id)) continue;
    seen.add(id);
    out.push({ zoho_account_id: id, zoho_account_name: a.name.trim().slice(0, 200), account_type: type });
  }
  return out;
}
