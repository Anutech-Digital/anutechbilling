/**
 * R-2499 (G-FY2526) — GENERIC FY import framework, part 1: the server reads one Zoho list for a
 * financial year into its own scan (READ only, paced, resumable). Used by the FY sales import
 * (R-2499, kind "invoices") and meant for bills / expenses / vendor payments (R-2502): each caller
 * passes its kind and its own normaliser (Zoho detail in paise → facts in WHOLE RUPEES).
 *
 * Two phases, both stored server-side (zoho_fy_scan_runs / zoho_fy_scan, keyed by kind):
 *   1. list   — Zoho's list for the FY (R-2498 listFyDocsPage, date_start / date_end), page by page;
 *               the next page is the server's own, never the browser's. Rows dated outside the FY
 *               are dropped (belt and braces on Zoho's filter).
 *   2. detail — each listed document's detail → the caller's normaliser → stored.
 *
 * One call = one Zoho request, under runPaced's per-minute budget and the request's call limit; a
 * stop (limit / Zoho busy) is picked up by the next request from the stored state. The counts come
 * from the stored rows — never from a browser (R-2498 review).
 *
 * The rest of the framework: fy-import/store.ts (Supabase scan store, scanned facts, batches),
 * fy-import/parts.ts (import in parts). Idempotency is the target table's unique Zoho id
 * (invoices.zoho_invoice_id here); dry run + batch + audit row live in each kind's SQL import
 * (import_zoho_fy_sales is the pattern: one block, R2499 raised at the end of a dry run).
 */
import { ZohoApiError } from "../api";
import { getFyDocDetail, listFyDocsPage, runPaced, fyDateRange, type FyDocKind, type PaceOpts, type ZohoFyDocDetail } from "../fy-fetch";

type Fetch = typeof fetch;

export interface ScanRun { nextPage: number; listDone: boolean }
export interface ListedRow { zohoId: string; number: string; date: string; status: string }
/** What every kind's facts carry (the scan row's own columns are kept in step with them). */
export interface ScanFacts { number: string; date: string; status: string }

/** Where the scan lives (Supabase in store.ts, memory in tests). One company, one kind. */
export interface ScanStore<F extends ScanFacts = ScanFacts> {
  readRun(fy: string): Promise<ScanRun | null>;
  saveRun(fy: string, run: ScanRun): Promise<void>;
  /** Upsert listed rows; a row already detailed keeps its facts unless Zoho's status changed. */
  addListed(fy: string, rows: ListedRow[]): Promise<void>;
  /** Zoho ids listed but not yet detailed, oldest first. */
  pendingDetails(fy: string, limit: number): Promise<string[]>;
  saveDetail(fy: string, zohoId: string, facts: F): Promise<void>;
  /** A listed document Zoho no longer has (deleted between the list and its detail). */
  drop(fy: string, zohoId: string): Promise<void>;
  counts(fy: string): Promise<{ listed: number; detailed: number }>;
  /** Forget the scan (read again from the start). */
  reset(fy: string): Promise<void>;
}

export interface ScanResult {
  listed: number;
  detailed: number;
  listDone: boolean;
  /** Everything listed and detailed. */
  complete: boolean;
  calls: number;
  busy: boolean;
}

export async function scanStep<F extends ScanFacts>(
  store: ScanStore<F>, kind: FyDocKind, toFacts: (d: ZohoFyDocDetail) => F,
  orgId: string, token: string, fy: string, pace: PaceOpts, f: Fetch = fetch,
): Promise<ScanResult> {
  const range = fyDateRange(fy);
  const run: ScanRun = (await store.readRun(fy)) ?? { nextPage: 1, listDone: false };
  let queue: string[] | null = null;
  let complete = false;

  const r = await runPaced({
    ...pace,
    step: async () => {
      if (!run.listDone) {
        const page = await listFyDocsPage(kind, orgId, token, range, run.nextPage, f);
        const rows = page.rows
          .filter((d) => d.id && d.date >= range.dateStart && d.date <= range.dateEnd)
          .map((d) => ({ zohoId: d.id, number: d.number, date: d.date, status: d.status.toLowerCase() }));
        await store.addListed(fy, rows);
        if (page.more) run.nextPage += 1; else run.listDone = true;
        await store.saveRun(fy, run);
        return false;
      }
      if (queue === null || queue.length === 0) {
        queue = await store.pendingDetails(fy, 50);
        if (queue.length === 0) { complete = true; return true; }
      }
      const id = queue[0];
      let d;
      try { d = await getFyDocDetail(kind, orgId, token, id, f); } catch (e) {
        /* Deleted in Zoho after it was listed: not a document any more — never a stuck scan. */
        if (e instanceof ZohoApiError && e.status === 404) { await store.drop(fy, id); queue.shift(); return false; }
        throw e;
      }
      await store.saveDetail(fy, id, toFacts(d));
      queue.shift();
      return false;
    },
  });
  /* A run that stopped on its call limit right after the last detail is already complete. */
  if (!complete && run.listDone && r.stopped !== "busy") {
    complete = (await store.pendingDetails(fy, 1)).length === 0;
  }
  const c = await store.counts(fy);
  return { ...c, listDone: run.listDone, complete, calls: r.calls, busy: r.stopped === "busy" };
}
