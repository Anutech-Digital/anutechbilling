/**
 * R-2499 (G-FY2526) — the server reads the FY's Zoho invoices into its own scan (READ only, paced,
 * resumable). Two phases, both kept server-side (zoho_sale_import_runs / zoho_sale_import_scan):
 *
 *   1. list   — Zoho's invoice list for the FY (R-2498 listFyDocsPage, date_start / date_end — the
 *               5 Nov check showed Zoho honours it for invoices), page by page; the next page is the
 *               server's own, never the browser's.
 *   2. detail — each listed invoice's detail (lines, taxes, place of supply) → normalise.ts facts in
 *               whole rupees → stored.
 *
 * One call = one Zoho request, under runPaced's per-minute budget and the request's call limit; a
 * stop (limit / Zoho busy) is picked up by the next request from the stored state. The counts the
 * card shows are counted from the stored rows — never sent by a browser (R-2498 review).
 */
import { getFyDocDetail, listFyDocsPage, runPaced, fyDateRange, type PaceOpts } from "../fy-fetch";
import { zohoSaleFacts, type ZohoSaleFacts } from "./normalise";

type Fetch = typeof fetch;

export interface ScanRun { nextPage: number; listDone: boolean }
export interface ListedRow { zohoId: string; number: string; date: string; status: string }

/** Where the scan lives (Supabase in store.ts, memory in tests). Every call is for one company. */
export interface ScanStore {
  readRun(fy: string): Promise<ScanRun | null>;
  saveRun(fy: string, run: ScanRun): Promise<void>;
  /** Upsert listed invoices; a row already detailed keeps its facts unless Zoho's status changed. */
  addListed(fy: string, rows: ListedRow[]): Promise<void>;
  /** Zoho ids listed but not yet detailed, oldest first. */
  pendingDetails(fy: string, limit: number): Promise<string[]>;
  saveDetail(fy: string, zohoId: string, facts: ZohoSaleFacts): Promise<void>;
  counts(fy: string): Promise<{ listed: number; detailed: number }>;
  /** Forget the scan (Read again from the start). */
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

export async function scanStep(
  store: ScanStore, orgId: string, token: string, fy: string, sellerStateCode: string | null,
  pace: PaceOpts, f: Fetch = fetch,
): Promise<ScanResult> {
  const range = fyDateRange(fy);
  const run: ScanRun = (await store.readRun(fy)) ?? { nextPage: 1, listDone: false };
  let queue: string[] | null = null;
  let complete = false;

  const r = await runPaced({
    ...pace,
    step: async () => {
      if (!run.listDone) {
        const page = await listFyDocsPage("invoices", orgId, token, range, run.nextPage, f);
        /* Belt and braces on Zoho's own filter: only rows dated inside the FY are kept. */
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
      const d = await getFyDocDetail("invoices", orgId, token, id, f);
      await store.saveDetail(fy, id, zohoSaleFacts(d, sellerStateCode));
      queue.shift();
      return false;
    },
  });
  /* A run that stopped on its call limit right after the last detail still finishes next time;
     check now so the card can say "complete" without one more request. */
  if (!complete && run.listDone && r.stopped !== "busy") {
    complete = (await store.pendingDetails(fy, 1)).length === 0;
  }
  const c = await store.counts(fy);
  return { ...c, listDone: run.listDone, complete, calls: r.calls, busy: r.stopped === "busy" };
}
