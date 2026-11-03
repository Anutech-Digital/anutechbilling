/**
 * R-2387 — Private Vault → Income & Expenses. Pure: no DB, no UI.
 *
 * Pardeep (2 Nov): "income aur bhi source ho sakte hai … personal income expense manager bhi
 * hona chahiye". The screen used to know only "Drawing" and "Expense".
 *
 * ─── WHAT COUNTS AS WHAT ────────────────────────────────────────────────────
 *   Income  = drawing, salary, interest, dividend, other_income, refund
 *             (each with an income SOURCE — the column income_source, or the kind's own
 *             source for old rows that have none).
 *   Spent   = expense.
 *   Neither = transfer_in, transfer_out, card_payment, atm_cash — money moving between your
 *             own pockets. Counting them would count the same rupee twice (gp12a header).
 *   Saved   = Income − Spent.
 *
 * A refund is listed as an income source (the owner's list) under the ITR head "Exempt" — it
 * is money back, not taxable income. It is NOT also netted off spend: that would count it twice.
 *
 * ─── ITR HEADS ──────────────────────────────────────────────────────────────
 * The five heads of income in the Income-tax Act (Salary, House property, Business or
 * profession, Capital gains, Other sources) plus "Exempt" (agricultural income, refunds).
 * A gift is "Other sources" — it is exempt only from a relative or under ₹50,000 a year, which
 * this screen cannot know, so the label says so. A drawing from your own company is not a head
 * at all (it is your own money, or salary/dividend booked by the company) — it is shown on its
 * own line so the FY summary never mixes it into a tax head.
 */
import { buildCSV } from "@/lib/csv";
import { PERSONAL_SPEND_CATEGORIES } from "./categories";

export type IncomeSource =
  | "salary" | "rent" | "interest" | "dividend" | "business"
  | "agriculture" | "capital_gains" | "gift" | "refund" | "other";

export type ItrHead = "salary" | "house_property" | "business" | "capital_gains" | "other_sources" | "exempt" | "from_company";

/** The kinds an income entry can be saved as — must match the migration's CHECK. */
export type IncomeKind = "salary" | "interest" | "dividend" | "other_income" | "refund";

export interface IncomeSourceDef {
  id: IncomeSource;
  label: string;
  kind: IncomeKind;
  head: ItrHead;
  /** Offer "repeat monthly" by default (salary, rent). */
  monthly: boolean;
}

/** Order = the owner's list (2 Nov). Must match personal_transactions_income_source_check. */
export const INCOME_SOURCES: readonly IncomeSourceDef[] = [
  { id: "salary",        label: "Salary",                  kind: "salary",       head: "salary",         monthly: true },
  { id: "rent",          label: "Rent (house property)",   kind: "other_income", head: "house_property", monthly: true },
  { id: "interest",      label: "Interest",                kind: "interest",     head: "other_sources",  monthly: false },
  { id: "dividend",      label: "Dividend",                kind: "dividend",     head: "other_sources",  monthly: false },
  { id: "business",      label: "Business / freelance",    kind: "other_income", head: "business",       monthly: false },
  { id: "agriculture",   label: "Agriculture",             kind: "other_income", head: "exempt",         monthly: false },
  { id: "capital_gains", label: "Capital gains",           kind: "other_income", head: "capital_gains",  monthly: false },
  { id: "gift",          label: "Gift",                    kind: "other_income", head: "other_sources",  monthly: false },
  { id: "refund",        label: "Refund",                  kind: "refund",       head: "exempt",         monthly: false },
  { id: "other",         label: "Other",                   kind: "other_income", head: "other_sources",  monthly: false },
];

const SOURCE_BY_ID = new Map(INCOME_SOURCES.map((s) => [s.id, s] as const));

export const ITR_HEAD_LABEL: Record<ItrHead, string> = {
  salary: "Salary",
  house_property: "House property",
  business: "Business or profession",
  capital_gains: "Capital gains",
  other_sources: "Other sources",
  exempt: "Exempt (not taxed)",
  from_company: "From company (drawings — not a tax head)",
};

/** Order the FY summary lists the heads in (the ITR's own order, then the two extras). */
export const ITR_HEAD_ORDER: readonly ItrHead[] = [
  "salary", "house_property", "business", "capital_gains", "other_sources", "exempt", "from_company",
];

/**
 * Expense categories on the form: the shared spending list (net-worth + categories.ts, so the
 * importer and the form never disagree), plus "Loan EMI" the owner asked for. The old
 * "Rent / EMI" stays — past rows carry it.
 */
export const EXPENSE_FORM_CATEGORIES: readonly string[] = [...PERSONAL_SPEND_CATEGORIES, "Loan EMI"];

export const INCOME_KINDS: ReadonlySet<string> = new Set(["drawing", "salary", "interest", "dividend", "other_income", "refund"]);
export const NEUTRAL_KINDS: ReadonlySet<string> = new Set(["transfer_in", "transfer_out", "card_payment", "atm_cash"]);

export function isIncomeKind(kind: string): boolean { return INCOME_KINDS.has(kind); }
export function isSpendKind(kind: string): boolean { return kind === "expense"; }

export function incomeSourceDef(id: string | null | undefined): IncomeSourceDef | null {
  return id ? SOURCE_BY_ID.get(id as IncomeSource) ?? null : null;
}

/** The kind a source is saved as. */
export function kindForSource(id: IncomeSource): IncomeKind {
  return SOURCE_BY_ID.get(id)!.kind;
}

export interface LedgerRow {
  id?: string;
  kind: string;
  amount: number;
  occurred_on: string;
  category?: string | null;
  income_source?: string | null;
  party?: string | null;
  note?: string | null;
  account_id?: string | null;
  repeat_monthly?: boolean | null;
}

/** "drawing" for a drawing, a source for other income, null for spend / transfers. */
export function sourceOf(t: Pick<LedgerRow, "kind" | "income_source">): IncomeSource | "drawing" | null {
  if (t.kind === "drawing") return "drawing";
  if (!isIncomeKind(t.kind)) return null;
  const s = incomeSourceDef(t.income_source);
  if (s) return s.id;
  // Old rows (before R-2387) have no income_source: the kind is the source.
  switch (t.kind) {
    case "salary": return "salary";
    case "interest": return "interest";
    case "dividend": return "dividend";
    case "refund": return "refund";
    default: return "other";
  }
}

export function sourceLabel(s: IncomeSource | "drawing"): string {
  return s === "drawing" ? "Drawing (from company)" : SOURCE_BY_ID.get(s)!.label;
}

export function headOf(s: IncomeSource | "drawing"): ItrHead {
  return s === "drawing" ? "from_company" : SOURCE_BY_ID.get(s)!.head;
}

/** Whole rupees, never negative — the DB CHECK says amount > 0; belt and braces. */
function rupees(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export interface IncomeExpenseSummary {
  income: number;
  spent: number;
  saved: number;
  bySource: { source: IncomeSource | "drawing"; label: string; total: number; count: number }[];
  byCategory: { category: string; total: number; count: number }[];
  byHead: { head: ItrHead; label: string; total: number }[];
}

export function summariseIncomeExpense(rows: readonly LedgerRow[]): IncomeExpenseSummary {
  let income = 0;
  let spent = 0;
  const src = new Map<IncomeSource | "drawing", { total: number; count: number }>();
  const cat = new Map<string, { total: number; count: number }>();
  const head = new Map<ItrHead, number>();

  for (const t of rows) {
    const amount = rupees(t.amount);
    if (amount === 0) continue;
    const s = sourceOf(t);
    if (s) {
      income += amount;
      const cur = src.get(s) ?? { total: 0, count: 0 };
      cur.total += amount; cur.count += 1; src.set(s, cur);
      const h = headOf(s);
      head.set(h, (head.get(h) ?? 0) + amount);
    } else if (isSpendKind(t.kind)) {
      spent += amount;
      const key = (t.category ?? "").trim() || "Uncategorised";
      const cur = cat.get(key) ?? { total: 0, count: 0 };
      cur.total += amount; cur.count += 1; cat.set(key, cur);
    }
  }

  return {
    income,
    spent,
    saved: income - spent,
    bySource: [...src.entries()]
      .map(([source, v]) => ({ source, label: sourceLabel(source), total: v.total, count: v.count }))
      .sort((a, b) => b.total - a.total),
    byCategory: [...cat.entries()]
      .map(([category, v]) => ({ category, total: v.total, count: v.count }))
      .sort((a, b) => b.total - a.total),
    byHead: ITR_HEAD_ORDER.filter((h) => head.has(h)).map((h) => ({ head: h, label: ITR_HEAD_LABEL[h], total: head.get(h)! })),
  };
}

/** The 12 months of the FY starting `fyStart` (YYYY-04-01), as "YYYY-MM". */
export function fyMonths(fyStart: string): string[] {
  const y = Number(fyStart.slice(0, 4));
  return Array.from({ length: 12 }, (_, i) => {
    const m = ((3 + i) % 12) + 1;
    return `${m <= 3 ? y + 1 : y}-${String(m).padStart(2, "0")}`;
  });
}

/** Rows of this FY, and of one month when `month` ("YYYY-MM") is given. */
export function inPeriod<T extends Pick<LedgerRow, "occurred_on">>(rows: readonly T[], fyStart: string, month: string | null): T[] {
  const y = Number(fyStart.slice(0, 4));
  const fyEnd = `${y + 1}-03-31`;
  return rows.filter((t) =>
    t.occurred_on >= fyStart && t.occurred_on <= fyEnd && (!month || t.occurred_on.slice(0, 7) === month));
}

/** Same day of month in `month`, clamped (31 Jan → 28/29 Feb). */
function sameDayIn(month: string, iso: string): string {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = Math.min(Number(iso.slice(8, 10)), last);
  return `${month}-${String(d).padStart(2, "0")}`;
}

export interface MonthlyDue {
  /** The latest entry of this series — the template copied. */
  from: LedgerRow;
  /** Date the new entry gets (same day, this month). */
  date: string;
  label: string;
}

/**
 * Monthly entries (repeat_monthly) whose series has no entry yet in `thisMonth` ("YYYY-MM").
 * A series = same kind + source + category + party + account. Nothing is created here — the
 * screen shows "Add this month's" and the owner presses it (no cron, card point 5).
 */
export function monthlyDue(rows: readonly LedgerRow[], thisMonth: string): MonthlyDue[] {
  const latest = new Map<string, LedgerRow>();
  const key = (t: LedgerRow) => [t.kind, sourceOf(t) ?? "", (t.category ?? "").trim(), (t.party ?? "").trim().toLowerCase(), t.account_id ?? ""].join("|");
  for (const t of rows) {
    const k = key(t);
    const cur = latest.get(k);
    if (!cur || t.occurred_on > cur.occurred_on) latest.set(k, t);
  }
  const out: MonthlyDue[] = [];
  for (const t of latest.values()) {
    if (!t.repeat_monthly) continue;            // the newest entry of the series decides
    if (t.occurred_on.slice(0, 7) >= thisMonth) continue;
    const s = sourceOf(t);
    const what = s ? sourceLabel(s) : (t.category || "Expense");
    out.push({ from: t, date: sameDayIn(thisMonth, t.occurred_on), label: t.party ? `${what} · ${t.party}` : what });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export const KIND_LABEL: Record<string, string> = {
  drawing: "Drawing (from company)",
  salary: "Salary",
  interest: "Interest",
  dividend: "Dividend",
  other_income: "Other income",
  refund: "Refund",
  expense: "Expense",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
  card_payment: "Card payment",
  atm_cash: "ATM cash",
};

/** What a row is called in the list: its income source, else its kind. */
export function rowLabel(t: Pick<LedgerRow, "kind" | "income_source">): string {
  const s = sourceOf(t);
  return s ? sourceLabel(s) : KIND_LABEL[t.kind] ?? t.kind;
}

export const CSV_HEADERS = ["Date", "Type", "Source / Category", "ITR head", "Amount (Rs)", "Account", "Party", "Note"];

/** CSV rows for the export (income +, spend −, transfers as their own type with 0 effect noted). */
export function csvRows(rows: readonly LedgerRow[], accountLabel: (id: string) => string | undefined): (string | number)[][] {
  return rows.map((t) => {
    const s = sourceOf(t);
    const type = s ? "Income" : isSpendKind(t.kind) ? "Expense" : (KIND_LABEL[t.kind] ?? t.kind);
    const what = s ? sourceLabel(s) : (t.category ?? "");
    const amount = rupees(t.amount);
    return [
      t.occurred_on,
      type,
      what,
      s ? ITR_HEAD_LABEL[headOf(s)] : "",
      isSpendKind(t.kind) ? -amount : amount,
      t.account_id ? accountLabel(t.account_id) ?? "" : "Cash",
      t.party ?? "",
      t.note ?? "",
    ];
  });
}

export function buildIncomeExpenseCsv(rows: readonly LedgerRow[], accountLabel: (id: string) => string | undefined): string {
  return buildCSV(CSV_HEADERS, csvRows(rows, accountLabel));
}
