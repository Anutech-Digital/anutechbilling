/**
 * R-1852 (epic R-1841, Phase 3 — Pvt Ltd) — a director's pay, as pure, tested rules.
 *
 * WHY: a company's accounts show directors' remuneration apart from staff salaries (Schedule III
 * notes; ITR-6 asks for it), and a director who is also an employee (whole-time / managing
 * director) must be paid a SALARY through Payroll, where TDS on salary is deducted (Income-tax
 * Act, section 192). Remuneration, fees or commission to a director OTHER than salary — e.g.
 * sitting fees — is TDS under section 194J(1)(ba) and is booked as an expense.
 * Source: section 194J as published by the Income Tax Department
 * https://www.incometaxindia.gov.in/w/section-194j-30 (clause (ba), "other than those on which
 * tax is deductible under section 192"). New Act 2025 section numbers: CA confirm (card step).
 *
 * THE LINK: company_directors.employee_id (migration 20261025003000) says which employee a
 * director is. Payroll books every salary as a "Salaries" expense (pay_salary) — that stays,
 * because the bank match, vendor list and ITR pack all treat "Salaries" as payroll. The P&L moves
 * a director-employee's payroll rows (found by salary_payments.expense_id — never by name) into
 * the Director's Remuneration line, next to sitting fees booked as expenses: one line.
 * Pure — no I/O.
 */
import type { BusinessType } from "@/lib/compliance/obligations";
import { entityProfile } from "@/lib/compliance/entity";
import { OWNER_PAY_CATEGORY } from "./owner-salary-guard";

/** The expense category the P&L line is (already offered in Add expense — R-1846). */
export const DIRECTOR_REMUNERATION_CATEGORY = OWNER_PAY_CATEGORY;
export const SALARIES_CATEGORY = "Salaries";

/** One payroll expense row of a director-employee (expenses row behind salary_payments.expense_id). */
export interface DirectorPayrollExpense {
  expense_date: string; // YYYY-MM-DD
  vendor_name: string | null;
  amount: number;
}

interface ExpenseGroup {
  category: string | null;
  vendor_name: string | null;
  month: string; // YYYY-MM
  amount: number;
  n: number;
}

/**
 * The report's expense groups (category × vendor × month) with each director payroll row inside
 * the range moved from Salaries to Director's Remuneration. The total never changes; a payroll
 * row the report does not hold (another role's view, a deleted entry) is skipped — never a
 * negative Salaries line.
 */
export function moveDirectorPayroll<T extends ExpenseGroup>(
  groups: readonly T[],
  payroll: readonly DirectorPayrollExpense[],
  range: { from: string; to: string },
): T[] {
  const inRange = payroll.filter((p) => p.expense_date >= range.from && p.expense_date <= range.to && p.amount > 0);
  if (inRange.length === 0) return [...groups];
  const out = groups.map((x) => ({ ...x }));
  const find = (category: string, vendor: string | null, month: string) =>
    out.find((x) => x.category === category && (x.vendor_name ?? null) === vendor && x.month === month);
  for (const p of inRange) {
    const month = p.expense_date.slice(0, 7);
    const vendor = p.vendor_name ?? null;
    const from = find(SALARIES_CATEGORY, vendor, month);
    if (!from || from.amount < p.amount || from.n < 1) continue;
    from.amount -= p.amount;
    from.n -= 1;
    const to = find(DIRECTOR_REMUNERATION_CATEGORY, vendor, month);
    if (to) { to.amount += p.amount; to.n += 1; }
    else out.push({ ...from, category: DIRECTOR_REMUNERATION_CATEGORY, amount: p.amount, n: 1 });
  }
  return out.filter((x) => x.amount !== 0 || x.n !== 0);
}

/**
 * The P&L line an expense row is shown under — the drill-down uses it so a line's rows add up
 * to the line: a director-employee's payroll row (its id in `directorPayrollIds`) is Director's
 * Remuneration, everything else its own category.
 */
export function pnlCategoryOf(row: { id: string; category: string | null }, directorPayrollIds: ReadonlySet<string>): string | null {
  return row.category === SALARIES_CATEGORY && directorPayrollIds.has(row.id) ? DIRECTOR_REMUNERATION_CATEGORY : row.category;
}

// ── Add expense: a director's salary booked as an expense ───────────────────────────────────

export interface DirectorPayCaution {
  title: string;
  body: string;
}

type DirectorLike = { name: string; ceased_on: string | null; employee_id?: string | null };

/* "director salary", "director's salary", "MD salary", "director ki tankha" … */
const DIRECTOR_SALARY_RE =
  /\b(?:director'?s?|md|managing director|whole-?time director|wtd)\s+(?:ki\s+|ka\s+)?(?:salary|salaries|tankha|tankhwah|tanakhwah)\b/i;
const norm = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

const BODY_TAIL =
  "Payroll deducts TDS on salary (section 192) and puts it in Form 24Q / Form 16; booked here as an expense, no salary TDS is deducted. " +
  "Sitting fees or commission to a director who is not on the payroll are fine here (TDS under section 194J).";

/**
 * Null = nothing to say. A Pvt Ltd (or an empty type) only — a proprietor / partner gets R-1846's
 * caution instead. Fires when the payee is a current director who is on the payroll (linked to an
 * employee) and the category is Director's Remuneration or Salaries, or when the note says
 * "director salary".
 */
export function directorPaidByExpenseCaution(args: {
  businessType: BusinessType | null | undefined;
  category?: string | null;
  payee?: string | null;
  text?: string | null;
  directors: readonly DirectorLike[];
  onDate: string;
}): DirectorPayCaution | null {
  if (entityProfile(args.businessType).type !== "pvt_ltd") return null;
  const payCategory = args.category === DIRECTOR_REMUNERATION_CATEGORY || args.category === SALARIES_CATEGORY;
  const payee = norm(args.payee);
  const onPayroll = payCategory && payee
    ? args.directors.find((d) => d.employee_id && norm(d.name) === payee && (!d.ceased_on || args.onDate <= d.ceased_on))
    : undefined;
  if (onPayroll) {
    return {
      title: `${onPayroll.name} is on the payroll — pay the salary through Payroll`,
      body: `${onPayroll.name} is a director linked to an employee. ${BODY_TAIL}`,
    };
  }
  if (DIRECTOR_SALARY_RE.test(`${args.payee ?? ""} ${args.text ?? ""}`)) {
    return { title: "A director's salary goes through Payroll", body: `A director paid a salary is an employee of the company. ${BODY_TAIL}` };
  }
  return null;
}
