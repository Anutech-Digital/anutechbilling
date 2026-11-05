/**
 * R-2496 (G-FY2526, 5 Nov 2026) — the company's BOOKS START: the first day whose money lives in
 * the app. One helper, read everywhere (Balance Sheet, Trial Balance, Reconcile from Zoho), so no
 * screen guesses "1 Apr 2026" from an invoice number, a bank line's year or a hard-coded date.
 *
 *   1. tenants.books_start_date — the owner sets it (Accounting → Overview → Books start), through
 *      set_books_start_date() (migration 20261105050326; SQL twin: public.books_start_for()).
 *   2. Not set → the day after the CA's opening balances date (opening_balances.as_of + 1) — what
 *      the app used before this card.
 *   3. Neither → null: the books have no known start. Reports then read the whole book
 *      (BOOKS_START_FALLBACK); Reconcile from Zoho refuses to make an opening balance.
 *
 * Owner decision (Pardeep, 5 Nov): Excel's books start 1 Apr 2025, so its opening balances are
 * "as at 31 Mar 2025" — opening_balances.as_of must be the day before the books start; the Balance
 * Sheet warns when it is not (openingDateMismatch).
 */
import { addDaysISO } from "@/lib/dates/ist";

/** Wide enough to hold every entry the books have — the whole-book P&L when no start is known. */
export const BOOKS_START_FALLBACK = "2000-04-01";

export type BooksStartSource = "setting" | "opening" | null;

export interface BooksStart {
  /** First day of the books (YYYY-MM-DD), or null when nothing says. */
  start: string | null;
  /** Where `start` came from: the owner's setting, the opening balances date, or nowhere. */
  source: BooksStartSource;
  /** The owner's setting as stored (null = not set). */
  setting: string | null;
  /** The CA's opening balances date (opening_balances.as_of), or null. */
  openingAsOf: string | null;
}

const day = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/** The books start from the two stored facts — the setting wins, else opening date + 1. */
export function booksStartOf(facts: { booksStartDate?: string | null; openingAsOf?: string | null }): BooksStart {
  const setting = day(facts.booksStartDate);
  const openingAsOf = day(facts.openingAsOf);
  if (setting) return { start: setting, source: "setting", setting, openingAsOf };
  if (openingAsOf) return { start: addDaysISO(openingAsOf, 1), source: "opening", setting: null, openingAsOf };
  return { start: null, source: null, setting: null, openingAsOf: null };
}

/** The first day a whole-book report reads from: the books start, else the wide fallback. */
export function reportStart(bs: Pick<BooksStart, "start"> | null | undefined): string {
  return bs?.start ?? BOOKS_START_FALLBACK;
}

/**
 * The opening balances date the books start needs (books start − 1), when the stored one differs or
 * there are no opening balances yet (`actual` null) — null when they agree or no books start is set.
 */
export function openingDateMismatch(bs: BooksStart): { expected: string; actual: string | null } | null {
  if (bs.source !== "setting" || !bs.setting) return null;
  const expected = addDaysISO(bs.setting, -1);
  return bs.openingAsOf === expected ? null : { expected, actual: bs.openingAsOf };
}

/** A Postgres "column does not exist" — the migration is not on this database yet. */
const missingColumn = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "42703" || /column .*books_start_date.* does not exist/i.test(e.message ?? ""));

type Thenable = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
interface Query extends Thenable {
  select(cols: string): Query;
  eq(col: string, v: unknown): Query;
  order(col: string, opts: { ascending: boolean }): Query;
  limit(n: number): Query;
}
export interface BooksStartDb { from(table: string): Query }

export class BooksStartReadError extends Error {}

/**
 * Server read for one company (the admin client bypasses RLS — every read is filtered by
 * `tenantId`, CLAUDE.md §17c). A failed read throws BooksStartReadError: a money plan is refused
 * rather than made with a guessed start. Before the migration (no column) the setting reads as unset.
 */
export async function readBooksStart(db: BooksStartDb, tenantId: string): Promise<BooksStart> {
  const [t, ob] = await Promise.all([
    db.from("tenants").select("books_start_date").eq("id", tenantId).limit(1),
    db.from("opening_balances").select("as_of").eq("tenant_id", tenantId).order("as_of", { ascending: false }).limit(1),
  ]);
  if (t.error && !missingColumn(t.error)) throw new BooksStartReadError("the books start date");
  if (ob.error) throw new BooksStartReadError("the opening balances date");
  const first = (rows: unknown) => (Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined);
  return booksStartOf({
    booksStartDate: t.error ? null : (first(t.data)?.books_start_date as string | null | undefined) ?? null,
    openingAsOf: (first(ob.data)?.as_of as string | null | undefined) ?? null,
  });
}
