/**
 * Does the statement preview hold EVERY line? — checked before import, not after (R-1693).
 *
 * ─── WHY ─────────────────────────────────────────────────────────────────────
 * Staging, 20 Oct 2026 (HDFC PDF, 24 pages): all 12 page-chunks (R-1690) came back 200,
 * yet the AI simply left lines out of its answers. After import the account was ₹7,96,835
 * short of the statement's closing balance, with many "Lines missing between …" gaps on the
 * account page — and nothing had said so before the import. A request that succeeds is not
 * proof the answer is complete; the bank's own running balance is.
 *
 * ─── HOW ─────────────────────────────────────────────────────────────────────
 * 1. The chain: every line with a balance must follow from the one before it —
 *    prev_balance − debit + credit = balance (±₹1, whole-rupee rounding). This is the SAME
 *    check the account page runs after import (statement-check.ts → checkStatement): same
 *    arithmetic, same tolerance, same "Lines missing between X and Y" windows. So a preview
 *    that passes here does not turn into gaps on the account page later. Each row carries
 *    the pages it came from, so a gap names its pages ("Page 7").
 * 2. A gap inside (or at the border of) a chunk → those pages are read again ONE page at a
 *    time and swapped in only when the chain gets better. Limits: at most
 *    REREAD_MAX_PAGES extra calls, REREAD_CONCURRENCY at a time (R-1690's limit, below
 *    Gemini's circuit breaker), no new call after REREAD_BUDGET_MS, and none at all once
 *    Gemini says it is paused (breaker open) or busy (503).
 * 3. The model also reports how many lines it saw per page (`rowCount`). Fewer rows written
 *    than counted is treated like a break: re-read. Where the balance chain covers those
 *    pages it is the stronger proof and decides; where there is no balance it is all we have,
 *    so a mismatch left after the re-read blocks import.
 * 4. Whatever is still missing blocks the Import button until the operator ticks
 *    "Main jaanta hoon, adhoora import karna hai" — the dialog shows each gap.
 * 5. No balance on any line → the check did NOT run, and the preview says so. It never
 *    claims a pass it could not make.
 *
 * CSV / Excel imports run the same check (no re-read: a break there is a bad file).
 */
import { checkStatement } from "./statement-check";
import { fixStatementDates } from "./statement-dates";
import {
  mergeChunkRows,
  mapLimited,
  chunkWarnings,
  STATEMENT_CHUNK_CONCURRENCY,
  type ChunkResult,
  type PageRange,
  type StatementRowLike,
} from "./statement-chunks";

/** Most single-page re-reads after one statement read (24-page statement: half of it). */
export const REREAD_MAX_PAGES = 12;
/** Re-reads at a time — the same limit R-1690 set for the first read. */
export const REREAD_CONCURRENCY = STATEMENT_CHUNK_CONCURRENCY;
/** No new re-read is started after this long (each call is still bounded by its own 60 s timeout). */
export const REREAD_BUDGET_MS = 180_000;

export type ChunkEntry<R> = { range: PageRange; result: ChunkResult<R> };

/** A preview row may carry the pages it was read from (AI); a CSV row does not. */
export type PagedRow = StatementRowLike & { page?: PageRange };

/** The model said its pages hold `counted` lines but wrote only `returned`. */
export type RowCountIssue = { pages: PageRange; counted: number; returned: number };

export type PreviewGap = {
  /** Last date the chain agreed (the missing lines are after its last line). */
  after: string;
  /** Date by which the difference shows. */
  by: string;
  /** Positive = money OUT with no line in the preview; negative = money IN with no line. */
  amount: number;
  /** Pages the window spans (null for CSV / Excel). */
  pages: PageRange | null;
};

export type PreviewCheck = {
  /** false = no line has a running balance, so the chain could not be checked. */
  ran: boolean;
  gaps: PreviewGap[];
  /** Only the mismatches the balance chain cannot vouch for. */
  rowCountIssues: RowCountIssue[];
  /** Import waits for the operator's explicit tick. */
  blocking: boolean;
};

const overlaps = (a: PageRange, b: PageRange) => a.from <= b.to && b.from <= a.to;

/** The balance chain over preview rows. Dates must already be real calendar dates. */
export function checkPreview(rows: PagedRow[], rowCountIssues: RowCountIssue[] = []): PreviewCheck {
  /* Opening 0: only the gaps are used here, and they do not depend on the opening balance. */
  const sc = checkStatement(rows, 0);
  const gaps: PreviewGap[] = (sc?.gaps ?? []).map((g) => {
    let from = Infinity, to = -Infinity;
    for (const r of rows) {
      if (!r.page || r.txn_date < g.after || r.txn_date > g.by) continue;
      from = Math.min(from, r.page.from);
      to = Math.max(to, r.page.to);
    }
    return { after: g.after, by: g.by, amount: g.amount, pages: from <= to ? { from, to } : null };
  });
  const unvouched = rowCountIssues.filter(
    (i) => !rows.some((r) => r.page && overlaps(r.page, i.pages) && r.balance_after !== null),
  );
  return { ran: sc !== null, gaps, rowCountIssues: unvouched, blocking: gaps.length > 0 || unvouched.length > 0 };
}

/** Import is held while lines are missing, until the operator ticks that they know. */
export function importBlocked(check: PreviewCheck | null, acknowledged: boolean): boolean {
  return !!check && check.blocking && !acknowledged;
}

/** Chunks → rows in page order (each tagged with its pages), the failures and the count mismatches. */
export function assembleChunks<R extends StatementRowLike>(chunks: ChunkEntry<R>[]) {
  const merged = mergeChunkRows(
    chunks.map((c) => (c.result.ok ? c.result.rows.map((r) => ({ ...r, page: c.range })) : null)),
  );
  const failed = chunks.flatMap((c) => (c.result.ok ? [] : [{ ...c.range, error: c.result.error }]));
  const rowCountIssues: RowCountIssue[] = chunks.flatMap((c) => {
    if (!c.result.ok || c.result.rowCount == null) return [];
    const returned = c.result.returned ?? c.result.rows.length;
    /* More rows than counted is a repeated border row or a miscount — never a missing line. */
    return returned < c.result.rowCount ? [{ pages: c.range, counted: c.result.rowCount, returned }] : [];
  });
  const skipped = chunks.reduce((s, c) => s + (c.result.ok ? c.result.skipped : 0), 0);
  return {
    rows: merged.rows,
    failed,
    rowCountIssues,
    skipped,
    borderDuplicates: merged.borderDuplicates,
    repeatsAcrossChunks: merged.repeatsAcrossChunks,
  };
}

function evaluate<R extends StatementRowLike>(chunks: ChunkEntry<R>[], today: string) {
  const a = assembleChunks(chunks);
  /* The chain needs real dates; the dialog fixes day/month swaps for the whole statement,
     so the check does the same here. The rows handed back keep their dates as read. */
  const fix = fixStatementDates(a.rows.map((r) => r.txn_date), today);
  const dated = a.rows.flatMap((r, i) => (fix.dates[i] ? [{ ...r, txn_date: fix.dates[i]! }] : []));
  const check = checkPreview(dated, a.rowCountIssues);
  const missing = check.gaps.reduce((s, g) => s + Math.abs(g.amount), 0);
  const score = [check.gaps.length + check.rowCountIssues.length, missing, a.rowCountIssues.length + a.failed.length];
  return { a, check, score };
}

const compareScore = (x: number[], y: number[]) => {
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};
const pagesOf = (r: PageRange) => Array.from({ length: r.to - r.from + 1 }, (_, i) => r.from + i);

export async function rereadBrokenPages<R extends StatementRowLike>(opts: {
  chunks: ChunkEntry<R>[];
  /** Reads one page (the route with pages from = to = page). */
  readPage: (page: number) => Promise<ChunkResult<R>>;
  /** Latest real date a line may carry (see fixStatementDates). */
  today: string;
  maxPages?: number;
  concurrency?: number;
  budgetMs?: number;
  now?: () => number;
  onProgress?: (p: { done: number; total: number; reading: number[] }) => void;
}) {
  const maxPages = opts.maxPages ?? REREAD_MAX_PAGES;
  const budgetMs = opts.budgetMs ?? REREAD_BUDGET_MS;
  const now = opts.now ?? Date.now;
  const pageCount = opts.chunks.reduce((m, c) => Math.max(m, c.range.to), 0);

  let current = opts.chunks;
  let best = evaluate(current, opts.today);

  /* Suspects: a chunk inside a gap's page window, one whose count does not match, or one
     that failed outright — in page order. */
  const gapRanges = best.check.gaps.flatMap((g) => (g.pages ? [g.pages] : []));
  const suspects = current.filter((c) =>
    !c.result.ok ||
    gapRanges.some((g) => overlaps(g, c.range)) ||
    best.a.rowCountIssues.some((i) => i.pages.from === c.range.from && i.pages.to === c.range.to),
  );

  const selected: ChunkEntry<R>[] = [];
  const notRetried: number[] = [];
  let planned = 0;
  for (const c of suspects) {
    const size = c.range.to - c.range.from + 1;
    if (planned + size <= maxPages) { selected.push(c); planned += size; }
    else notRetried.push(...pagesOf(c.range));
  }

  const pages = selected.flatMap((c) => pagesOf(c.range));
  const results = new Map<number, ChunkResult<R>>();
  const reading = new Set<number>();
  const halt: { reason: string | null } = { reason: null };
  let done = 0;
  const start = now();
  const report = () => opts.onProgress?.({ done, total: pages.length, reading: [...reading].sort((a, b) => a - b) });

  await mapLimited(pages, opts.concurrency ?? REREAD_CONCURRENCY, async (p) => {
    if (halt.reason) return;
    if (now() - start >= budgetMs) {
      halt.reason = `samay seema (${Math.round(budgetMs / 1000)} sec) poori ho gayi`;
      return;
    }
    reading.add(p);
    report();
    let res: ChunkResult<R>;
    try {
      res = await opts.readPage(p);
    } catch {
      res = { ok: false, error: "Upload failed — check the connection." };
    }
    reading.delete(p);
    done++;
    results.set(p, res);
    report();
    if (!res.ok && (res.kind === "paused" || res.kind === "busy")) {
      halt.reason ??= res.kind === "paused"
        ? "AI ke calls abhi ruke hue hain — lagatar fail hue"
        : "Google ka AI abhi busy hai";
    }
  });

  /* Swap a chunk for its single pages only when that does not make the check worse — and,
     at equal score, only when no row is lost (a no-balance page cannot vouch for itself). */
  const repaired: number[] = [];
  for (const c of selected) {
    const ps = pagesOf(c.range);
    const got = ps.map((p) => results.get(p));
    if (got.some((r) => !r || !r.ok)) continue;
    const replacement: ChunkEntry<R>[] = ps.map((p, i) => ({ range: { from: p, to: p }, result: got[i]! }));
    const idx = current.indexOf(c);
    if (idx < 0) continue;
    const candidate = [...current.slice(0, idx), ...replacement, ...current.slice(idx + 1)];
    const e = evaluate(candidate, opts.today);
    const cmp = compareScore(e.score, best.score);
    const oldRows = c.result.ok ? c.result.rows.length : 0;
    const newRows = replacement.reduce((s, r) => s + (r.result.ok ? r.result.rows.length : 0), 0);
    if (cmp < 0 || (cmp === 0 && newRows >= oldRows)) {
      if (cmp < 0) repaired.push(...ps);
      current = candidate;
      best = e;
    }
  }

  const retried = [...results.keys()].sort((a, b) => a - b);
  for (const p of pages) if (!results.has(p)) notRetried.push(p);
  notRetried.sort((a, b) => a - b);

  const parts: string[] = [];
  if (retried.length > 0) {
    parts.push(
      `Balance chain jaanch: page ${retried.join(", ")} dobara 1-1 page karke padhe — ` +
      (best.check.blocking
        ? (repaired.length > 0 ? `page ${repaired.join(", ")} theek hue, par phir bhi kuch lines nahi mili (neeche dekho).` : "phir bhi kuch lines nahi mili (neeche dekho).")
        : "ab chain poori hai."),
    );
  }
  if (notRetried.length > 0) {
    parts.push(
      `Page ${notRetried.join(", ")} dobara nahi padhe — ` +
      (halt.reason ?? `ek baar mein ${maxPages} page tak hi dobara padhte hain`) + ".",
    );
  } else if (halt.reason) {
    parts.push(`Dobara padhna roka — ${halt.reason}.`);
  }

  return {
    chunks: current,
    /** Page order, tagged with their pages, dates AS READ (the dialog fixes them once). */
    rows: best.a.rows,
    skipped: best.a.skipped,
    failed: best.a.failed,
    rowCountIssues: best.a.rowCountIssues,
    warnings: chunkWarnings(best.a.failed, pageCount, current.length, best.a.repeatsAcrossChunks),
    /** The check on real dates, after the re-reads. */
    check: best.check,
    retried,
    repaired,
    notRetried,
    stopped: halt.reason,
    /** One line for the preview saying what was re-read, or null when nothing was. */
    note: parts.length > 0 ? parts.join(" ") : null,
  };
}
