/**
 * R-2657 — Pardeep's D1 (10 Nov 2026): the "No-vendor lines" bulk tool must not book a money-out
 * line that a Zoho-imported purchase already covers. The FY purchase import (R-2502) brings Zoho's
 * expenses in as PAID expenses with no bank line, and COGS bills as unpaid bills; their bank debit
 * is matched to them later (Reconcile's recorded-payment / bill match, one-press in R-2655). Booking
 * such a debit as a NEW expense here would count the cost twice.
 *
 * So, before a line is offered (sheet) or booked (server), it is checked against every imported
 * document that has no bank line yet:
 *   - an imported expense (expenses.zoho_doc_id; all legs of one Zoho document together, still
 *     reconciled_txn_id null): covered when the debit is one of the document's bank amounts —
 *     Σamount, Σ(amount + GST), each less Σ TDS — within ₹1, and the line is within 7 days of its
 *     expense date or paid date;
 *   - an imported COGS bill (vendor_bills.zoho_doc_id, not paid / void): the bill total or what is
 *     still due, with or without its TDS, within ₹1, the line dated from 7 days before the bill
 *     date up to 120 days after it (COGS bills are paid on the real debit later, R-2502b).
 * A false "covered" only leaves the line for R-2655 / the Reconcile sheet (safe); a missed one
 * would double the cost, so the windows are wide on purpose.
 */
import { addDaysISO } from "@/lib/dates/ist";

export interface ImportedExpenseRow {
  zoho_doc_id: string;
  amount: number;
  gst_paid: number | null;
  tds_amount: number | null;
  expense_date: string;
  paid_date: string | null;
}

export interface ImportedBillRow {
  zoho_doc_id: string;
  total: number;
  paid_amount: number | null;
  tds_amount?: number | null;
  bill_date: string;
  bill_no?: string | null;
}

export interface ImportedDoc {
  /** "expenses:<zoho id>" / "bills:<zoho id>". */
  key: string;
  kind: "expense" | "bill";
  amounts: number[];
  /** Earliest / latest bank date this document's payment can carry (ISO yyyy-mm-dd). */
  from: string;
  to: string;
}

const EXPENSE_DAYS = 7;
const BILL_DAYS_BEFORE = 7;
const BILL_DAYS_AFTER = 120;
const TOLERANCE = 1;

const addDays = addDaysISO;

const uniq = (xs: number[]) => [...new Set(xs.filter((x) => x > 0))];

/** The imported documents still waiting for their bank line, with the amounts a debit could carry. */
export function importedDocs(expenses: readonly ImportedExpenseRow[], bills: readonly ImportedBillRow[]): ImportedDoc[] {
  const byDoc = new Map<string, ImportedExpenseRow[]>();
  for (const e of expenses) {
    const list = byDoc.get(e.zoho_doc_id);
    if (list) list.push(e);
    else byDoc.set(e.zoho_doc_id, [e]);
  }
  const out: ImportedDoc[] = [];
  for (const [key, legs] of byDoc) {
    const amt = legs.reduce((s, e) => s + Number(e.amount ?? 0), 0);
    const gst = legs.reduce((s, e) => s + Number(e.gst_paid ?? 0), 0);
    const tds = legs.reduce((s, e) => s + Number(e.tds_amount ?? 0), 0);
    const dates = legs.flatMap((e) => [e.expense_date, e.paid_date]).filter((d): d is string => !!d).map((d) => d.slice(0, 10)).sort();
    out.push({
      key, kind: "expense",
      amounts: uniq([amt, amt + gst, amt - tds, amt + gst - tds]),
      from: addDays(dates[0], -EXPENSE_DAYS),
      to: addDays(dates[dates.length - 1], EXPENSE_DAYS),
    });
  }
  for (const b of bills) {
    const total = Number(b.total ?? 0);
    const due = total - Number(b.paid_amount ?? 0);
    const tds = Number(b.tds_amount ?? 0);
    out.push({
      key: b.zoho_doc_id, kind: "bill",
      amounts: uniq([total, due, total - tds, due - tds]),
      from: addDays(b.bill_date, -BILL_DAYS_BEFORE),
      to: addDays(b.bill_date, BILL_DAYS_AFTER),
    });
  }
  return out;
}

/** The imported document that already covers this money-out line, or null. */
export function coveringDoc(line: { debit: number; txn_date: string }, docs: readonly ImportedDoc[]): ImportedDoc | null {
  if (!(line.debit > 0)) return null;
  const d = line.txn_date.slice(0, 10);
  return docs.find((doc) => d >= doc.from && d <= doc.to && doc.amounts.some((a) => Math.abs(a - line.debit) <= TOLERANCE)) ?? null;
}

export const COVERED_MESSAGE =
  "A Zoho-imported expense or bill already covers this payment — match the line to it on the bank page (Reconcile), don't book a new expense.";

/* ── Reading the documents (route and sheet share it) ───────────────────────────────────────── */

type Res<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
interface Q<T> extends Res<T> {
  not: (c: string, op: string, v: unknown) => Q<T>;
  is: (c: string, v: null) => Q<T>;
  gte: (c: string, v: string) => Q<T>;
  lte: (c: string, v: string) => Q<T>;
  order: (c: string, o: { ascending: boolean }) => Q<T>;
  range: (a: number, b: number) => Res<T>;
}
export interface DocsDb {
  from: (t: string) => { select: (c: string) => Q<never> };
}

const PAGE = 1000;
async function allRows<T>(make: () => Q<T>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

/**
 * The company's imported documents (RLS = own company) that could cover a line dated between
 * `fromDate` and `toDate`. Throws on a read error — the caller then books nothing (never "not
 * covered" by default).
 */
export async function loadImportedDocs(db: DocsDb, fromDate: string, toDate: string): Promise<ImportedDoc[]> {
  const expenses = await allRows<ImportedExpenseRow>(() => (db.from("expenses")
    .select("zoho_doc_id, amount, gst_paid, tds_amount, expense_date, paid_date") as unknown as Q<ImportedExpenseRow>)
    .not("zoho_doc_id", "is", null).is("reconciled_txn_id", null)
    .gte("expense_date", addDays(fromDate, -BILL_DAYS_AFTER)).lte("expense_date", addDays(toDate, EXPENSE_DAYS))
    .order("id", { ascending: true }));
  const bills = (await allRows<ImportedBillRow & { status: string }>(() => (db.from("vendor_bills")
    .select("zoho_doc_id, total, paid_amount, bill_date, status") as unknown as Q<ImportedBillRow & { status: string }>)
    .not("zoho_doc_id", "is", null)
    .gte("bill_date", addDays(fromDate, -BILL_DAYS_AFTER)).lte("bill_date", addDays(toDate, BILL_DAYS_BEFORE))
    .order("id", { ascending: true })))
    .filter((b) => !["paid", "void", "cancelled"].includes(String(b.status).toLowerCase()));
  return importedDocs(expenses, bills);
}
