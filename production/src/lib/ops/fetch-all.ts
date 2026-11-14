/**
 * Read EVERY row of a PostgREST query — past the 1000-row cap (WC-scale, 30 Sep 2026).
 *
 * WHY: PostgREST answers at most `max_rows` rows (supabase/config.toml: 1000) and says
 * nothing when it cut the answer short. A cron that reads "all active subscriptions" in one
 * select silently snapshots the first 1000; a report that counts leads in the browser counts
 * the newest 1000. Nothing errors — the number is just wrong, and it gets more wrong as the
 * business grows. The same service-role client is capped too: max_rows is a server setting,
 * not a role grant.
 *
 * Two helpers, no Supabase import (so they are unit-tested with a fake page function):
 *   - fetchAllRows(page)        — pages `.range(from, to)` until a short page comes back;
 *   - fetchAllRowsIn(ids, page) — the same, for an `.in()` id list, IN_CHUNK ids a request
 *                                 (a URL with 5,000 uuids is ~190 KB and gets refused by
 *                                 the proxy long before PostgREST sees it).
 *
 * THE QUERY MUST HAVE A TOTAL ORDER. Offset pages over an order with ties (created_at alone)
 * can repeat or skip a row across a page boundary. End the order on a unique column — `id`.
 */
import { chunk, mapLimit, uniq } from "@/lib/ops/p-limit";

/** PostgREST's max_rows (supabase/config.toml). A page shorter than this is the last page. */
export const PAGE_SIZE = 1000;
/** Ids per `.in()` request. */
export const IN_CHUNK = 200;

/** What a supabase-js query resolves to — the only part these helpers read. */
export type PageResponse<T> = { data: T[] | null; error: unknown };
export type PageQuery<T> = PromiseLike<PageResponse<T>>;

/**
 * Every row, `pageSize` at a time. `page(from, to)` builds the query and ends it with
 * `.range(from, to)`. Throws the query's own error (as the callers' `if (error) throw error`
 * always did), so a failed page is never mistaken for the last one.
 *
 * `pageSize` must not exceed the server's max_rows: a server that caps lower returns a short
 * page, and a short page is read as "done".
 */
export async function fetchAllRows<T>(
  page: (from: number, to: number) => PageQuery<T>,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<T[]> {
  const size = opts.pageSize ?? PAGE_SIZE;
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`fetchAllRows: pageSize must be a positive integer, got ${size}`);
  const max = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const out: T[] = [];
  for (let from = 0; from < max; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const r of rows) out.push(r);
    if (rows.length < size) break;
  }
  return out.length > max ? out.slice(0, max) : out;
}

/**
 * An id list as a query-key part: distinct and sorted, so the same set of rows on screen is
 * the same cache entry whatever order they arrived in.
 */
export function idsKey(ids: readonly (string | null | undefined)[]): string[] {
  return uniq(ids.filter((x): x is string => typeof x === "string" && x !== "")).sort();
}

/** The message of whatever fetchAllRows threw — a PostgrestError is a plain object, not an Error. */
export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/**
 * Every row for an id list: the ids are de-duplicated, split into `chunkSize` runs, and each
 * run is paged with fetchAllRows (one chunk can still match more than a page — 200 invoices
 * with six dunning steps each is 1,200 log rows). Chunks run one after another unless the caller
 * passes `concurrency` (R-2765: the Renewals page reads 4 chunks at a time — a staging book of 300+
 * subscriptions was 2+ chunks per read, each read waiting on the last); rows come back in chunk
 * order either way, and the first failed chunk's error is thrown. An empty id list makes no
 * request at all (PostgREST reads `in.()` as "matches nothing", but there is no reason to ask).
 */
export async function fetchAllRowsIn<T, I extends string | number>(
  ids: readonly (I | null | undefined)[],
  page: (ids: I[], from: number, to: number) => PageQuery<T>,
  opts: { chunkSize?: number; pageSize?: number; concurrency?: number } = {},
): Promise<T[]> {
  const clean = uniq(ids.filter((x): x is I => x !== null && x !== undefined));
  const runs = chunk(clean, opts.chunkSize ?? IN_CHUNK);
  const limit = Math.max(1, Math.floor(opts.concurrency ?? 1));
  const perRun = await mapLimit(runs, limit, (run) => fetchAllRows((from, to) => page(run, from, to), { pageSize: opts.pageSize }));
  const out: T[] = [];
  for (const rows of perRun) for (const r of rows) out.push(r);
  return out;
}

/** R-2765: chunks in flight at once for the Renewals page's reads (browser → PostgREST). */
export const RENEWALS_READ_CONCURRENCY = 4;
