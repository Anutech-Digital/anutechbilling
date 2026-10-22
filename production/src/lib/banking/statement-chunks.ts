/**
 * Reading a long bank-statement PDF a few pages at a time (R-1690).
 *
 * ─── WHY ─────────────────────────────────────────────────────────────────────
 * Staging, 19 Oct 2026 (12:06 and 17:14 UTC): every one-month statement PDF failed. The logs
 * showed `timed out after 60000ms` on gemini-flash-latest, again on its retry, and again on
 * gemini-flash-lite-latest. The model has to WRITE every row out as JSON, and a month of
 * entries does not fit in 60 s — so that file could never succeed, however often it was tried.
 * And the operator was told "Google's AI is busy", which sent them to wait, not to fix.
 *
 * ─── HOW ─────────────────────────────────────────────────────────────────────
 * The browser counts the pages (pdfjs, already used by the app) and asks the route for
 * `CHUNK_PAGES` pages per call, `CONCURRENCY` calls at a time. Each call is short, so each
 * stays well inside the 60 s per-call timeout and Cloud Run's 600 s request limit, and the
 * dialog can show real progress ("Page 5–8 of 12 padh rahe hain").
 *
 * The whole PDF travels with every call and the prompt names the pages to read. Physically
 * cutting the PDF would need a PDF-writing library (pdf-lib), which this repo does not have,
 * and adding a dependency is a decision of its own (production/CLAUDE.md §14). The cost is
 * the upload repeated per chunk — small for a bank e-statement (usually under 1 MB) — and
 * input tokens, which are cheap; the slow part, the rows written out, is what got split.
 *
 * ─── MONEY RULES ─────────────────────────────────────────────────────────────
 * - Rows are merged in PAGE order, whatever order the calls finish in.
 * - A row the model repeats at a chunk border (the last line of pages 3–4 read again as the
 *   first line of 5–6) is dropped ONLY when every field matches — date, narration, debit,
 *   credit, balance — and only within the last/first few rows of two ADJACENT chunks. Two
 *   identical lines inside one chunk are both kept: two same-day ₹500 UPI payments are real.
 * - Identical rows in non-adjacent chunks are kept and FLAGGED (the model may have ignored
 *   its page range); the operator decides in the preview.
 * - A chunk that fails never silently disappears: its pages are named in a warning shown
 *   before import, and the rows that did come back are still offered.
 * - Dates are NOT fixed per chunk: a day/month swap is a decision for the whole statement
 *   (statement-dates.ts), so the dialog runs it once over the merged rows.
 */

/** Pages per call. ~25–40 entries a page; two pages write out comfortably inside 60 s. */
export const STATEMENT_CHUNK_PAGES = 2;
/** Calls at a time. More would race the circuit breaker in lib/ai/gemini.ts and the per-minute quota. */
export const STATEMENT_CHUNK_CONCURRENCY = 3;
/** Rows at each side of a border compared for the repeated-row check. */
const BORDER_WINDOW = 3;

export type PageRange = { from: number; to: number };

export type StatementRowLike = {
  txn_date: string;
  description: string;
  debit: number;
  credit: number;
  balance_after: number | null;
};

export type ChunkResult<R> =
  | {
      ok: true;
      rows: R[];
      skipped: number;
      /** R-1693: transaction lines the model says its pages hold (absent = it did not say). */
      rowCount?: number;
      /** R-1693: rows the model actually wrote out, before junk was dropped. */
      returned?: number;
    }
  | { ok: false; error: string; /** classifyStatementFailure's kind, when the route said. */ kind?: string };

export type ChunkProgress = {
  /** Pages whose call has finished (worked or failed). */
  pagesDone: number;
  pageCount: number;
  /** Ranges being read right now, in page order. */
  reading: PageRange[];
};

export function planPageChunks(pageCount: number, size = STATEMENT_CHUNK_PAGES): PageRange[] {
  const out: PageRange[] = [];
  const n = Math.max(0, Math.floor(pageCount));
  const step = Math.max(1, Math.floor(size));
  for (let from = 1; from <= n; from += step) out.push({ from, to: Math.min(n, from + step - 1) });
  return out;
}

/** "5–6" or "7". */
export function pagesLabel(r: PageRange): string {
  return r.from === r.to ? String(r.from) : `${r.from}–${r.to}`;
}

const rowKey = (r: StatementRowLike) =>
  [r.txn_date, r.description.trim().toLowerCase(), r.debit, r.credit, r.balance_after ?? ""].join("|");

/**
 * Merge per-chunk rows in page order. `null` = a chunk that failed (a gap — no border there).
 * See the money rules in the header for what is dropped and what is only flagged.
 */
export function mergeChunkRows<R extends StatementRowLike>(chunks: (R[] | null)[]): {
  rows: R[];
  borderDuplicates: number;
  repeatsAcrossChunks: number;
} {
  const rows: R[] = [];
  let borderDuplicates = 0;
  let prev: R[] | null = null;
  const seenIn = new Map<string, number>();   // key → chunk index it first appeared in
  let repeatsAcrossChunks = 0;

  chunks.forEach((chunk, ci) => {
    if (!chunk) { prev = null; return; }
    let start = 0;
    if (prev && prev.length > 0) {
      const tail = prev.slice(-BORDER_WINDOW).map(rowKey);
      const used = new Set<number>();
      /* Leading rows of this chunk that repeat the previous chunk's tail, in a run from the top.
         Stops at the first row that is not a repeat — a border overlap is a prefix, never a
         line in the middle of the page. */
      while (start < Math.min(BORDER_WINDOW, chunk.length)) {
        const k = rowKey(chunk[start]);
        const at = tail.findIndex((t, i) => t === k && !used.has(i));
        if (at < 0) break;
        used.add(at);
        start++;
      }
      borderDuplicates += start;
    }
    for (const r of chunk.slice(start)) {
      const k = rowKey(r);
      const first = seenIn.get(k);
      if (first === undefined) seenIn.set(k, ci);
      else if (first !== ci) repeatsAcrossChunks++;
      rows.push(r);
    }
    prev = chunk;
  });
  return { rows, borderDuplicates, repeatsAcrossChunks };
}

/** The route's JSON → a chunk result. Anything but an ok response with a rows array is a failure. */
export function chunkResultFrom<R>(ok: boolean, json: unknown): ChunkResult<R> {
  const j = (json ?? {}) as { rows?: unknown; skipped?: unknown; error?: unknown; kind?: unknown; rowCount?: unknown; rowsReturned?: unknown };
  if (ok && Array.isArray(j.rows)) {
    const out: ChunkResult<R> = { ok: true, rows: j.rows as R[], skipped: Number(j.skipped) || 0 };
    /* R-1693: the model's own count of the lines on its pages, and how many it wrote. */
    if (typeof j.rowCount === "number" && Number.isFinite(j.rowCount)) out.rowCount = j.rowCount;
    if (typeof j.rowsReturned === "number" && Number.isFinite(j.rowsReturned)) out.returned = j.rowsReturned;
    return out;
  }
  const fail: ChunkResult<R> = { ok: false, error: typeof j.error === "string" && j.error ? j.error : "The AI reader failed." };
  if (typeof j.kind === "string") fail.kind = j.kind;
  return fail;
}

/** Run `fn` over `items` with at most `limit` running at once; results keep the input order. */
export async function mapLimited<T, U>(items: T[], limit: number, fn: (item: T, i: number) => Promise<U>): Promise<U[]> {
  const out = new Array<U>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

export async function readStatementInChunks<R extends StatementRowLike>(opts: {
  pageCount: number;
  readChunk: (pages: PageRange) => Promise<ChunkResult<R>>;
  chunkPages?: number;
  concurrency?: number;
  onProgress?: (p: ChunkProgress) => void;
}): Promise<{
  rows: R[];
  skipped: number;
  failed: Array<PageRange & { error: string }>;
  allFailed: boolean;
  borderDuplicates: number;
  warnings: string[];
  /** R-1693: every chunk's own answer, in page order — the balance-chain check re-reads from these. */
  chunks: Array<{ range: PageRange; result: ChunkResult<R> }>;
}> {
  const plan = planPageChunks(opts.pageCount, opts.chunkPages ?? STATEMENT_CHUNK_PAGES);
  const reading = new Set<number>();
  let pagesDone = 0;
  const report = () =>
    opts.onProgress?.({
      pagesDone,
      pageCount: opts.pageCount,
      reading: [...reading].sort((a, b) => a - b).map((i) => plan[i]),
    });

  const results = await mapLimited(plan, opts.concurrency ?? STATEMENT_CHUNK_CONCURRENCY, async (range, i) => {
    reading.add(i);
    report();
    let res: ChunkResult<R>;
    try {
      res = await opts.readChunk(range);
    } catch {
      res = { ok: false, error: "Upload failed — check the connection." };
    }
    reading.delete(i);
    pagesDone += range.to - range.from + 1;
    report();
    return res;
  });

  const merged = mergeChunkRows(results.map((r) => (r.ok ? r.rows : null)));
  const failed = results.flatMap((r, i) => (r.ok ? [] : [{ ...plan[i], error: r.error }]));
  const skipped = results.reduce((s, r) => s + (r.ok ? r.skipped : 0), 0);

  return {
    rows: merged.rows,
    skipped,
    failed,
    allFailed: plan.length > 0 && failed.length === plan.length,
    borderDuplicates: merged.borderDuplicates,
    warnings: chunkWarnings(failed, opts.pageCount, plan.length, merged.repeatsAcrossChunks),
    chunks: plan.map((range, i) => ({ range, result: results[i] })),
  };
}

/** The preview warnings for pages that could not be read, and rows seen in two non-adjacent chunks. */
export function chunkWarnings(
  failed: Array<PageRange & { error: string }>,
  pageCount: number,
  chunkCount: number,
  repeatsAcrossChunks: number,
): string[] {
  const warnings: string[] = [];
  if (failed.length > 0 && failed.length < chunkCount) {
    const which = failed.map(pagesLabel).join(", ");
    warnings.push(
      `Page ${which} (of ${pageCount}) could not be read — ${failed[0].error.replace(/\.$/, "")}. ` +
      `Entries from these pages are NOT in this preview: import the rest, then import a short PDF or CSV/Excel for those dates separately.`,
    );
  }
  if (repeatsAcrossChunks > 0) {
    warnings.push(
      `${repeatsAcrossChunks} entr${repeatsAcrossChunks === 1 ? "y" : "ies"} appeared exactly the same in more than one part (pages) — ` +
      `the AI may have read a page twice. Check the repeated lines in the preview before importing.`,
    );
  }
  return warnings;
}

/**
 * What kind of failure a Gemini reason string describes — they need different next steps.
 * A timeout is NOT "busy": until 19 Oct 2026 both read "Google's AI is busy or slow", and a
 * statement too big for one call was retried by people who were told to wait a minute.
 */
export type StatementFailureKind = "timeout" | "busy" | "unreadable" | "paused" | "other";

export function classifyStatementFailure(reason: string): StatementFailureKind {
  if (/timed out|jawab nahi diya/i.test(reason)) return "timeout";
  if (/calls are paused/i.test(reason)) return "paused";
  if (/\b503\b|high demand|unavailable|overload/i.test(reason)) return "busy";
  if (/\b400\b|invalid argument/i.test(reason)) return "unreadable";
  return "other";
}
