/**
 * R-2524 — read every row of a ranged query with the pages after the first fetched side by side.
 * Used for the bank account page (all of an account's lines, again after every reconcile save).
 */
import { PAGE_SIZE as FETCH_PAGE_SIZE } from "@/lib/ops/fetch-all";
import { mapLimit } from "@/lib/ops/p-limit";

/** R-2524: pages asked for at once after the first (6 Nov: 5,170 lines = 6 pages one after another). */
export const BANK_PAGE_PARALLEL = 4;

/**
 * R-2524 — every row, like fetchAllRows, but the pages after the first are fetched side by side.
 * The first page also asks for the row count; with it the other page offsets are known up front,
 * so a 6,000-line account costs 2 round trips instead of 6 (and every reconcile save refetches the
 * list). No count in the answer → the old one-page-at-a-time loop. A page that comes back full at
 * the end (lines added meanwhile) → keep going one page at a time, as before.
 */
export async function fetchPagesInParallel<T>(
  page: (from: number, to: number, withCount?: boolean) => PromiseLike<{ data: T[] | null; error: unknown; count?: number | null }>,
  size = FETCH_PAGE_SIZE,
): Promise<T[]> {
  const first = await page(0, size - 1, true);
  if (first.error) throw first.error;
  const out: T[] = [...(first.data ?? [])];
  if (out.length < size) return out;
  const total = typeof first.count === "number" ? first.count : null;
  if (total !== null && total > size) {
    const starts: number[] = [];
    for (let from = size; from < total; from += size) starts.push(from);
    const pages = await mapLimit(starts, BANK_PAGE_PARALLEL, async (from) => {
      const r = await page(from, from + size - 1);
      if (r.error) throw r.error;
      return r.data ?? [];
    });
    for (const rows of pages) for (const r of rows) out.push(r);
    const last = pages[pages.length - 1];
    if (last && last.length < size) return out;
  }
  /* No count, or the last page was full: the rest one page at a time (fetchAllRows' rule). */
  for (let from = out.length; ; from += size) {
    const r = await page(from, from + size - 1);
    if (r.error) throw r.error;
    const rows = r.data ?? [];
    for (const x of rows) out.push(x);
    if (rows.length < size) return out;
  }
}
