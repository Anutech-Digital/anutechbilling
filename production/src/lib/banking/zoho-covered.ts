/**
 * R-2657 — Pardeep's D1 (10 Nov 2026): the "No-vendor lines" bulk tool must not book a money-out
 * line that a Zoho-imported purchase already covers. The FY purchase import (R-2502) brings Zoho's
 * expenses in as PAID expenses with no bank line, Zoho bills on expense accounts as UNPAID expenses
 * ('bills:…'), and COGS bills as unpaid vendor bills; their bank debit is matched to them later
 * (Reconcile's recorded-payment / bill match, one-press in R-2655). Booking such a debit as a NEW
 * expense here would count the cost twice.
 *
 * So, before a line is offered (sheet) or booked (server), it is checked against every imported
 * document that has no bank line yet:
 *   - an imported expense document (expenses.zoho_doc_id; all legs of one Zoho document together,
 *     still reconciled_txn_id null): its bank amounts are Σamount and Σ(amount + GST), each also less
 *     Σ TDS. A Zoho EXPENSE ('expenses:…', paid in Zoho) covers a line within 7 days of its expense
 *     or paid date; a Zoho BILL on expense accounts ('bills:…', paid later) from 7 days before the
 *     bill date up to 120 days after it (or 7 days around its paid date);
 *   - an imported COGS bill (vendor_bills.zoho_doc_id, unpaid / part paid): the total, what is still
 *     due, or the part already paid, each with or without its Zoho TDS (zoho_tds_amount), in the same
 *     −7 / +120 day window (COGS bills are paid on the real debit later, R-2502b). A bill the app
 *     already shows as paid has its bank line, so it covers nothing here.
 * Amounts match within ₹1. One document covers at most ONE line (the nearest in date), so a single
 * ₹10,000 bill never hides every ₹10,000 rent debit of the quarter.
 * A false "covered" only leaves the line for R-2655 / the Reconcile sheet (safe); a missed one
 * would double the cost, so the windows are wide on purpose.
 */
import { addDaysISO, daysBetweenISO } from "@/lib/dates/ist";

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
  zoho_tds_amount?: number | null;
  bill_date: string;
}

export interface ImportedDoc {
  /** "expenses:<zoho id>" / "bills:<zoho id>" (expenses) or "bills:<zoho id>" (COGS vendor bill). */
  key: string;
  kind: "expense" | "bill";
  amounts: number[];
  /** Earliest / latest bank date this document's payment can carry (ISO yyyy-mm-dd). */
  from: string;
  to: string;
  /** The date a line is measured against when two lines compete for this document. */
  anchor: string;
}

const EXPENSE_DAYS = 7;
const BILL_DAYS_BEFORE = 7;
const BILL_DAYS_AFTER = 120;
const TOLERANCE = 1;

const addDays = addDaysISO;
const uniq = (xs: number[]) => [...new Set(xs.filter((x) => x > 0))];
const day = (d: string) => d.slice(0, 10);
const min = (xs: string[]) => [...xs].sort()[0];
const max = (xs: string[]) => [...xs].sort()[xs.length - 1];

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
    const docDates = legs.map((e) => day(e.expense_date));
    const paid = legs.map((e) => e.paid_date).filter((d): d is string => !!d).map(day);
    const isBill = key.startsWith("bills:");
    const from = min([...docDates.map((d) => addDays(d, isBill ? -BILL_DAYS_BEFORE : -EXPENSE_DAYS)), ...paid.map((d) => addDays(d, -EXPENSE_DAYS))]);
    const to = max([...docDates.map((d) => addDays(d, isBill ? BILL_DAYS_AFTER : EXPENSE_DAYS)), ...paid.map((d) => addDays(d, EXPENSE_DAYS))]);
    out.push({
      key, kind: "expense",
      amounts: uniq([amt, amt + gst, amt - tds, amt + gst - tds]),
      from, to, anchor: paid.length ? max(paid) : min(docDates),
    });
  }
  for (const b of bills) {
    const total = Number(b.total ?? 0);
    const paidAmt = Number(b.paid_amount ?? 0);
    const due = total - paidAmt;
    const tds = Number(b.zoho_tds_amount ?? 0);
    out.push({
      key: b.zoho_doc_id, kind: "bill",
      amounts: uniq([total, due, paidAmt, total - tds, due - tds, paidAmt - tds]),
      from: addDays(day(b.bill_date), -BILL_DAYS_BEFORE),
      to: addDays(day(b.bill_date), BILL_DAYS_AFTER),
      anchor: day(b.bill_date),
    });
  }
  return out;
}

const fits = (line: { debit: number; txn_date: string }, doc: ImportedDoc) => {
  const d = day(line.txn_date);
  return line.debit > 0 && d >= doc.from && d <= doc.to && doc.amounts.some((a) => Math.abs(a - line.debit) <= TOLERANCE);
};

/**
 * Which lines are covered, and by which document: each document is given to at most one line —
 * the pairs closest in date first (ties: lower line id), so the answer never depends on input order.
 */
export function coveredLines<L extends { id: string; debit: number; txn_date: string }>(
  lines: readonly L[], docs: readonly ImportedDoc[],
): Map<string, ImportedDoc> {
  const pairs: { line: L; doc: ImportedDoc; gap: number }[] = [];
  for (const line of lines) {
    for (const doc of docs) {
      if (fits(line, doc)) pairs.push({ line, doc, gap: Math.abs(daysBetweenISO(doc.anchor, day(line.txn_date))) });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap || a.line.id.localeCompare(b.line.id) || a.doc.key.localeCompare(b.doc.key));
  const out = new Map<string, ImportedDoc>();
  const used = new Set<string>();
  for (const p of pairs) {
    if (out.has(p.line.id) || used.has(p.doc.key)) continue;
    out.set(p.line.id, p.doc);
    used.add(p.doc.key);
  }
  return out;
}

/** One line on its own: the imported document that would cover it, or null. */
export function coveringDoc(line: { debit: number; txn_date: string }, docs: readonly ImportedDoc[]): ImportedDoc | null {
  return coveredLines([{ id: "x", ...line }], docs).get("x") ?? null;
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
  or: (f: string) => Q<T>;
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
  /* expense_date up to 120 days before the first line (bill window), or a paid date near the lines. */
  const expenses = await allRows<ImportedExpenseRow>(() => (db.from("expenses")
    .select("zoho_doc_id, amount, gst_paid, tds_amount, expense_date, paid_date") as unknown as Q<ImportedExpenseRow>)
    .not("zoho_doc_id", "is", null).is("reconciled_txn_id", null)
    .lte("expense_date", addDays(toDate, BILL_DAYS_BEFORE))
    .or(`expense_date.gte.${addDays(fromDate, -BILL_DAYS_AFTER)},paid_date.gte.${addDays(fromDate, -EXPENSE_DAYS)}`)
    .order("id", { ascending: true }));
  /* COGS bills the app does not show as paid (a paid one already has its bank line). */
  const bills = await allRows<ImportedBillRow>(() => (db.from("vendor_bills")
    .select("zoho_doc_id, total, paid_amount, zoho_tds_amount, bill_date") as unknown as Q<ImportedBillRow>)
    .not("zoho_doc_id", "is", null).not("status", "in", "(paid,void,cancelled)")
    .gte("bill_date", addDays(fromDate, -BILL_DAYS_AFTER)).lte("bill_date", addDays(toDate, BILL_DAYS_BEFORE))
    .order("id", { ascending: true }));
  return importedDocs(expenses, bills);
}
