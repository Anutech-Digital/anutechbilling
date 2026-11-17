/**
 * R-2677 (17 Nov 2026, G-RECON) — "Match all exact (N)" on Banking → an account. Words and pure
 * helpers for the sheet (components/features/banking/exact-match-sheet.tsx). The server decides what
 * is exact (bank_exact_match_candidates, migration 20261117145227) and re-checks every row when
 * Match is pressed (book_bank_exact_matches) — nothing here is trusted by the server.
 */
import type { BankFilters } from "@/lib/banking/bank-filters";

export type ExactStatus = "exact" | "ambiguous" | "locked" | "drawer" | "likely" | "none";
export type ExactKind = "payment" | "project" | "expense" | "recorded_payment";

export interface ExactRow {
  txn_id: string;
  txn_date: string;
  description: string | null;
  amount: number;
  direction: "in" | "out";
  status: ExactStatus;
  kind: ExactKind | null;
  match_id: string | null;
  match_label: string | null;
  match_amount: number | null;
  match_date: string | null;
  why: string;
}

/** The server checks at most this many open lines per call (oldest first). */
export const EXACT_LINE_CAP = 2000;

export const EXACT_KIND_LABEL: Record<ExactKind, string> = {
  payment: "Customer receipt",
  project: "Project receipt",
  expense: "Paid expense",
  recorded_payment: "Payment already recorded",
};

/** What the sheet asks the server for: the page's own filter (account page — dates, money in/out). */
export interface ExactScope { from: string | null; to: string | null; dir: "all" | "in" | "out" }

export function exactScope(f: Pick<BankFilters, "from" | "to" | "dir">): ExactScope {
  return { from: f.from || null, to: f.to || null, dir: f.dir };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "1 Apr 2025 – 30 Apr 2025 · money out" — said on the sheet so the owner knows which lines were checked. */
export function scopeText(s: ExactScope, fmt: (iso: string) => string): string {
  const dates = s.from && s.to ? `${fmt(s.from)} – ${fmt(s.to)}`
    : s.from ? `from ${fmt(s.from)}` : s.to ? `up to ${fmt(s.to)}` : "all dates";
  const dir = s.dir === "in" ? " · money in" : s.dir === "out" ? " · money out" : "";
  return dates + dir;
}

export interface ExactSummary {
  checked: number;
  exact: number;
  exactAmount: number;
  ambiguous: number;
  locked: number;
  drawer: number;
  likely: number;
  none: number;
  /** The server stopped at EXACT_LINE_CAP lines — narrow the dates for the rest. */
  cut: boolean;
}

export function exactSummary(rows: readonly ExactRow[]): ExactSummary {
  const s: ExactSummary = { checked: rows.length, exact: 0, exactAmount: 0, ambiguous: 0, locked: 0, drawer: 0, likely: 0, none: 0, cut: rows.length >= EXACT_LINE_CAP };
  for (const r of rows) {
    if (r.status === "exact") { s.exact += 1; s.exactAmount += r.amount; }
    else s[r.status] += 1;
  }
  return s;
}

/** Rows the sheet shows under "Not matched — look at these" (no-record lines are only counted). */
export function reviewRows(rows: readonly ExactRow[]): ExactRow[] {
  return rows.filter((r) => r.status === "ambiguous" || r.status === "locked" || r.status === "drawer");
}

export interface ExactToBook { txn_id: string; match_type: ExactKind; match_id: string }

/** The exact rows still ticked, as the server wants them. Anything else is never sent. */
export function rowsToBook(rows: readonly ExactRow[], unticked: ReadonlySet<string>): ExactToBook[] {
  return rows
    .filter((r) => r.status === "exact" && r.kind !== null && r.match_id !== null && !unticked.has(r.txn_id))
    .map((r) => ({ txn_id: r.txn_id, match_type: r.kind as ExactKind, match_id: r.match_id as string }));
}

export interface BookExactResult {
  run_id: string | null;
  booked: number;
  skipped: { txn_id: string; reason: string }[];
  /** A later chunk failed: the earlier chunks stay matched (and can be undone). */
  stoppedEarly?: string;
}
export interface UndoExactResult { run_id: string; undone: number; left: { txn_id: string; reason: string }[]; remaining: number }

/** Lines per preview call, rows per Match call, lines per Undo call — each call stays well inside
 *  the signed-in role's statement timeout (the server caps them too: 200 / 100 / 100). */
export const EXACT_PAGE = 100;
export const EXACT_BOOK_CHUNK = 50;
export const EXACT_UNDO_PAGE = 50;

/** The server pages by line id; the sheet shows the lines by date (then id). */
export function sortExactRows(rows: ExactRow[]): ExactRow[] {
  return [...rows].sort((a, b) => (a.txn_date === b.txn_date ? (a.txn_id < b.txn_id ? -1 : 1) : a.txn_date < b.txn_date ? -1 : 1));
}

/** One press = one run, sent in chunks: add the chunks' answers up. */
export function mergeBookResults(parts: readonly BookExactResult[]): BookExactResult {
  return {
    run_id: parts.find((p) => p.run_id)?.run_id ?? null,
    booked: parts.reduce((n, p) => n + p.booked, 0),
    skipped: parts.flatMap((p) => p.skipped),
  };
}

type ResultText = { title: string; detail: string | null; tone: "success" | "warning" };

export function bookExactText(r: BookExactResult): ResultText {
  const skipped = r.skipped.length;
  const parts = [
    skipped ? `${plural(skipped, "line")} not matched — ${r.skipped[0].reason}` : null,
    r.stoppedEarly ? `Stopped before the end (${r.stoppedEarly}) — open the list again for the rest.` : null,
  ].filter(Boolean);
  const detail = parts.length ? parts.join(" ") : null;
  if (r.booked === 0) return { title: "Nothing was matched", detail, tone: "warning" };
  return { title: `${plural(r.booked, "line")} matched to the records already in the books`, detail, tone: skipped || r.stoppedEarly ? "warning" : "success" };
}

export function undoExactText(r: UndoExactResult): ResultText {
  const left = r.left.length;
  return {
    title: r.undone === 0 ? (left === 0 ? "Nothing left to undo" : "Nothing was undone") : `${plural(r.undone, "line")} un-reconciled — open again`,
    detail: left ? `${plural(left, "line")} left as ${left === 1 ? "it is" : "they are"} — ${r.left[0].reason}` : null,
    tone: left ? "warning" : "success",
  };
}
