/**
 * R-1871 — employee office-expense advance (imprest): the rules the screens share.
 *
 * An advance is company money in the employee's hand — an asset (prepaid_advances, category
 * 'Employee advance', R-101), never an expense when it is given. Bills booked against it are the
 * expenses. What the screens need, kept pure so it can be tested:
 *   - which open advance a person has (the bank page pre-picks "top-up" vs "new advance");
 *   - how a set of bills splits between the advance and a reimbursement — the same order and
 *     arithmetic as add_employee_advance_bills (migration 20261024202000), so the dialog's
 *     "Reimburse ₹X to <name>" is the number the database books;
 *   - which advance a money-in line most likely returns.
 * Whole rupees in, whole rupees out.
 */
import { compactName } from "@/lib/banking/salary-lines";

export interface AdvanceLite {
  id: string;
  employee_name: string;
  status: "active" | "closed" | "settled";
  remaining_balance: number;
  disbursed_date: string;
}

/** Same person, however the name was typed ("RAMESH  kumar" = "Ramesh Kumar"). */
export function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = compactName(a ?? "");
  return x.length > 0 && x === compactName(b ?? "");
}

/** The person's open advances, newest first. */
export function openAdvancesOf<T extends AdvanceLite>(name: string, advances: readonly T[]): T[] {
  return advances
    .filter((a) => a.status === "active" && samePerson(a.employee_name, name))
    .sort((a, b) => (a.disbursed_date < b.disbursed_date ? 1 : a.disbursed_date > b.disbursed_date ? -1 : 0));
}

export interface BillInput { amount: number; gst: number }

export interface BillSplit {
  total: number;
  /** Booked against the advance. */
  fromAdvance: number;
  /** Paid by the employee from their own money — owed to them (reimbursement). */
  extra: number;
  /** Balance left with the employee after these bills. */
  left: number;
}

/** Bills in order fill the advance; whatever does not fit is the extra (reimbursement). */
export function splitBills(bills: readonly BillInput[], left: number): BillSplit {
  const total = bills.reduce((s, b) => s + Math.max(0, Math.round(b.amount || 0)), 0);
  const fromAdvance = Math.min(total, Math.max(0, left));
  return { total, fromAdvance, extra: total - fromAdvance, left: Math.max(0, left) - fromAdvance };
}

export type BillProblem = "amount" | "gst" | "category" | "date" | null;

/** What is wrong with one bill row, or null. Mirrors the RPC's checks. */
export function billProblem(b: { date: string; category: string; amount: number; gst: number }): BillProblem {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return "date";
  if (!b.category.trim()) return "category";
  if (!Number.isInteger(b.amount) || b.amount <= 0) return "amount";
  if (!Number.isInteger(b.gst) || b.gst < 0 || b.gst >= b.amount) return "gst";
  return null;
}

/**
 * The advance a money-in line most likely returns: the person's open advance whose balance
 * equals the amount, else the one that can take it (balance ≥ amount), newest first.
 */
export function advanceForReturn<T extends AdvanceLite>(amount: number, name: string, advances: readonly T[]): T | null {
  const mine = openAdvancesOf(name, advances).filter((a) => a.remaining_balance > 0);
  return mine.find((a) => a.remaining_balance === amount) ?? mine.find((a) => a.remaining_balance >= amount) ?? null;
}

// ── R-1872: the advance register ─────────────────────────────────────────────────────────

/**
 * Money handed back on one advance, read from the lines the database functions write on it:
 *   settle_employee_advance      "Settled on 09 Oct 2026 · ₹3500 returned"
 *   a part return (R-1871)       "Returned ₹500 on 22 Oct 2026 · ₹500 still with them"
 *   its un-reconcile (R-1871)    "Return ₹500 undone (bank line un-reconciled)"
 * settle shrinks total_amount to what was spent, so this is the only record of the return.
 */
export function returnedFromNotes(notes: string | null | undefined): number {
  let sum = 0;
  for (const raw of (notes ?? "").split("\n")) {
    const line = raw.trim();
    const settled = /^Settled on .* · ₹(\d+) returned$/.exec(line);
    const part = /^Returned ₹(\d+) on /.exec(line);
    const undone = /^Return ₹(\d+) undone/.exec(line);
    if (settled) sum += Number(settled[1]);
    else if (part) sum += Number(part[1]);
    else if (undone) sum -= Number(undone[1]);
  }
  return Math.max(0, sum);
}

export interface RegisterAdvance extends AdvanceLite {
  /** total_amount: what is still counted as given (returns already taken out). */
  disbursed_amount: number;
  total_spent: number;
  notes: string | null;
}

export interface RegisterRow {
  employee: string;
  /** Everything handed over: gives + top-ups (= what is counted now + what came back). */
  given: number;
  /** Bills booked against the advances (expenses). */
  spent: number;
  returned: number;
  /** Still with the employee = given − spent − returned. */
  balance: number;
  /** Days since the oldest advance that still has money with them; null when nothing is out. */
  ageDays: number | null;
  advances: number;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

/** One row per person, biggest balance first. `today` is an IST YYYY-MM-DD. */
export function advanceRegister(advances: readonly RegisterAdvance[], today: string): RegisterRow[] {
  const rows = new Map<string, RegisterRow & { oldest: string | null }>();
  for (const a of advances) {
    const key = compactName(a.employee_name) || a.employee_name;
    const r = rows.get(key) ?? { employee: a.employee_name, given: 0, spent: 0, returned: 0, balance: 0, ageDays: null, advances: 0, oldest: null };
    const returned = returnedFromNotes(a.notes);
    r.given += Math.max(0, a.disbursed_amount) + returned;
    r.spent += Math.max(0, a.total_spent);
    r.returned += returned;
    r.balance += a.status === "active" ? Math.max(0, a.remaining_balance) : 0;
    r.advances += 1;
    if (a.status === "active" && a.remaining_balance > 0 && (!r.oldest || a.disbursed_date < r.oldest)) r.oldest = a.disbursed_date;
    rows.set(key, r);
  }
  return [...rows.values()]
    .map(({ oldest, ...r }) => ({ ...r, ageDays: oldest ? Math.max(0, daysBetween(oldest, today)) : null }))
    .sort((x, y) => y.balance - x.balance || (x.employee < y.employee ? -1 : 1));
}

/** The "Open > 30 days" filter: money still out for more than 30 days. */
export function isOverdueAdvance(r: RegisterRow): boolean {
  return r.balance > 0 && (r.ageDays ?? 0) > 30;
}

export const REGISTER_CSV_HEADERS = ["Employee", "Given", "Spent (bills)", "Returned", "Balance", "Days outstanding", "Advances"];

export function registerCsvRows(rows: readonly RegisterRow[]): (string | number)[][] {
  return rows.map((r) => [r.employee, r.given, r.spent, r.returned, r.balance, r.ageDays ?? "", r.advances]);
}

/** Open employee advances — the Balance Sheet's "Advances to employees" line. */
export function openEmployeeAdvanceTotal(advances: readonly Pick<AdvanceLite, "status" | "remaining_balance">[]): number {
  return advances.reduce((s, a) => s + (a.status === "active" ? Math.max(0, a.remaining_balance) : 0), 0);
}

/** Whole rupees from what a person typed ("4,130", "₹ 630"); NaN when it is not a whole number. */
export function parseRupees(v: string): number {
  const s = v.replace(/[,\s₹]/g, "");
  if (s === "") return 0;
  return /^\d+$/.test(s) ? Number(s) : NaN;
}
