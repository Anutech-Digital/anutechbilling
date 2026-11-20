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
import { getFyDocDetail, listFyDocsPage, runPaced, fyDateRange, type FyReadKind, type PaceOpts, type ZohoFyDocDetail } from "../fy-fetch";

type Fetch = typeof fetch;
const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim().slice(0, 60));

export interface ScanRun {
  nextPage: number;
  listDone: boolean;
  /** R-2653: when this listing began (a "Read again"); rows not listed since get their detail read
   *  again when the list finishes (gone from Zoho → 404 → dropped). null = a first read; absent = no
   *  run stored yet (saveRun creates it). */
  listStartedAt?: string | null;
  /** R-2653: this read is limited to one Zoho deposit account (receipts); null / absent = all. */
  onlyAccount?: string | null;
}
export interface ListedRow {
  zohoId: string; number: string; date: string; status: string;
  /** R-2653: Zoho's last_modified_time from the list row ("" = Zoho sent none). */
  modified?: string;
  /** R-2653: the Zoho deposit account (customer payments); "" = none. */
  accountId?: string;
}

/** R-2653: the Read-again account filter — null = all accounts; undefined = not a Zoho account id. */
export function parseOnlyAccount(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(v) ? v : undefined;
}

/**
 * R-2653: the version of each kind's facts (its normaliser). Read again keeps a stored detail only when
 * it was made by this version — a card that CHANGES what a normaliser stores (fy-import's toFacts:
 * sales-import / purchase-import / receipts-import normalise.ts) bumps its kind here, so the next Read
 * again reads those details again (once). Rows stored before R-2653 count as version 0.
 * (R-2650 changed the sales normaliser on 10 Nov 2026 but its import reads currency + fxRate already
 * stored, so no re-read was needed.)
 *
 * R-2944 (20 Nov 2026): the scan keeps only the normaliser's RESULT, never Zoho's document — so a rule
 * change reaches a stored row only through a new detail call. R-2702 (12 Nov) made TDS-on-invoice and
 * adjustment invoices importable but left invoices at 0: on staging 79 invoices stayed "left out" with
 * sentences the code no longer had, and Read again read nothing. invoices → 1.
 * fy-import/facts-version-pin.test.ts goes red when a normaliser file changes without this decision.
 */
export const SCAN_FACTS_VERSION: Partial<Record<FyReadKind, number>> = { invoices: 1 };
export const factsVersionOf = (kind: FyReadKind): number => SCAN_FACTS_VERSION[kind] ?? 0;

/**
 * R-2944: the versions whose bump needs ONLY the left-out rows read again. By default a bump re-reads
 * EVERY row made by an older version (one Zoho detail call per document — a 2,780-invoice year is three
 * days of the ~900-call day budget, R-2661; the read stays incomplete, so no preview, until it is done).
 * A version listed here says: "this change only frees or re-words documents the older rules LEFT OUT
 * (storedLeftOut) — a document they took is stored the same today". A row is then kept without a call
 * unless it was left out; a row that crosses ANY bump not listed here is still read again in full.
 * So the safe default stays R-2653's: a new version that is not added here re-reads everything.
 *
 * invoices 1 — R-2702 turned left-out invoices (TDS on the invoice, a Zoho adjustment) into sales and
 * changed nothing for an invoice the rules already took. Not covered by it, as before this card: facts
 * a still OLDER normaliser stored for an invoice it took (read before R-2536's billing address or
 * R-2650's foreign-currency figures) — those changes made their own decision then (R-2540's hint: card
 * R-2945; R-2650: none needed), and such an invoice already in the app is not touched by any read.
 */
export const SCAN_FACTS_LEFT_OUT_ONLY: Partial<Record<FyReadKind, readonly number[]>> = { invoices: [1] };
export const leftOutOnlyVersionsOf = (kind: FyReadKind): readonly number[] => SCAN_FACTS_LEFT_OUT_ONLY[kind] ?? [];

/**
 * R-2944: Zoho statuses whose documents are left out whatever the normaliser's rules are (sales:
 * NOT_A_SALE in sales-import/normalise.ts — a test keeps the two the same). A rule change never frees
 * them, so they are not re-read for one; a status that CHANGES in Zoho is re-read by R-2653's own rule.
 */
export const SCAN_NEVER_RECHECK_STATUS: Partial<Record<FyReadKind, readonly string[]>> = { invoices: ["void", "draft"] };

/** R-2944: do a row's stored facts say it was left out (a non-empty `problems`) — for a reason a newer
 *  normaliser could lift (not a never-a-sale status)? `payload` = the stored facts as they are. */
export function storedLeftOut(kind: FyReadKind, status: string, payload: unknown): boolean {
  if ((SCAN_NEVER_RECHECK_STATUS[kind] ?? []).includes(status)) return false;
  const problems = payload && typeof payload === "object" ? (payload as { problems?: unknown }).problems : null;
  return Array.isArray(problems) && problems.length > 0;
}

/** R-2653: what we already hold for a listed document. */
export interface KnownRow {
  status: string; fy: string; modified: string | null; detailedAt: string | null; hasDetail: boolean;
  /** The deposit account stored with it (receipts); null = not known (stored before R-2653). */
  accountId?: string | null;
  /** The facts version its detail was made with (null = before R-2653 = 0). */
  factsVersion?: number | null;
  /** R-2694: its stored facts lack what today's import needs (receiptFactsIncomplete) — read it again. */
  factsIncomplete?: boolean;
  /** R-2944: its stored facts say it was left out (storedLeftOut) — decides the re-read of an older
   *  facts version when every bump since is in SCAN_FACTS_LEFT_OUT_ONLY. */
  leftOut?: boolean;
}

/**
 * R-2694 — a stored customer payment whose facts the foreign-receipt import cannot use: no `currency`
 * (read before R-2693), or a foreign one with no per-invoice foreign amounts (`foreignLines`, read before
 * R-2694). Only these are read again — not a SCAN_FACTS_VERSION bump for every payment (Zoho calls).
 * Takes the two payload fields as text (the store reads `payload->>currency` / `payload->>foreignLines`).
 */
export function receiptFactsIncomplete(p: { currency: string | null | undefined; foreignLines: string | null | undefined }): boolean {
  const cur = (p.currency ?? "").trim().toUpperCase();
  if (!cur) return true;
  return cur !== "INR" && !p.foreignLines;
}

export type ListedVerdict = "fresh" | "kept" | "seen" | "skip";

/**
 * R-2653 — what a "Read again" does with one listed row (pure; the stores use it):
 *   "fresh" → (re)read its detail: new, no detail yet, status or FY changed, made by an older facts
 *             version (R-2944: when every bump since is in `leftOutOnly`, only a row that was left
 *             out), or Zoho's last_modified_time differs from the one stored (a row stored before
 *             R-2653 has none: then "changed after our detail read" decides — no one-time full re-read);
 *   "kept"  → nothing changed: keep its facts, note it was listed;
 *   "seen"  → outside this read's deposit account (now AND when it was read): keep everything as it
 *             was (a later read of all accounts checks it), only note it was listed;
 *   "skip"  → new and outside this read's deposit account: not stored (no detail call).
 * A payment moved INTO or OUT OF the chosen account counts as inside (its facts name the old account).
 * A row stored before R-2653 has no account: outside it is re-read only when it changed.
 */
export function classifyListed(
  prev: KnownRow | null | undefined, row: ListedRow, fy: string, onlyAccount?: string | null, factsVersion = 0,
  leftOutOnly: readonly number[] = [],
): ListedVerdict {
  const rowOutside = !!onlyAccount && (row.accountId ?? "") !== onlyAccount;
  if (!prev) return rowOutside ? "skip" : "fresh";
  const changed = changedSince(prev, row, fy, factsVersion, leftOutOnly);
  if (!rowOutside) return changed ? "fresh" : "kept";
  if (prev.accountId === onlyAccount) return "fresh";                 /* moved out of the chosen account */
  if (prev.fy !== fy) return "fresh";                                  /* moved into this FY — never left under the old one */
  if ((prev.accountId ?? null) === null && changed) return "fresh";   /* stored before R-2653: account unknown */
  return "seen";
}

/** R-2944: must a row made by version `madeBy` be read again for the bumps up to `factsVersion`? */
export function olderFactsNeedReread(madeBy: number, factsVersion: number, leftOutOnly: readonly number[], leftOut: boolean): boolean {
  if (!(madeBy < factsVersion)) return false;
  if (leftOut) return true;
  /* Kept only when EVERY bump it crosses asks for the left-out rows alone. */
  for (let v = Math.floor(madeBy) + 1; v <= factsVersion; v++) if (!leftOutOnly.includes(v)) return true;
  return false;
}

function changedSince(prev: KnownRow, row: ListedRow, fy: string, factsVersion: number, leftOutOnly: readonly number[]): boolean {
  if (!prev.hasDetail || prev.status !== row.status || prev.fy !== fy) return true;
  if (olderFactsNeedReread(prev.factsVersion ?? 0, factsVersion, leftOutOnly, prev.leftOut === true)) return true;
  if (prev.factsIncomplete) return true;   /* R-2694 */
  const mod = row.modified ?? "";
  if (!mod) return false;
  if (prev.modified) return prev.modified !== mod;
  const at = Date.parse(mod), read = Date.parse(prev.detailedAt ?? "");
  return Number.isFinite(at) && Number.isFinite(read) && at > read;
}
/** What every kind's facts carry (the scan row's own columns are kept in step with them). */
export interface ScanFacts { number: string; date: string; status: string }

/** Where the scan lives (Supabase in store.ts, memory in tests). One company, one kind. */
export interface ScanStore<F extends ScanFacts = ScanFacts> {
  readRun(fy: string): Promise<ScanRun | null>;
  saveRun(fy: string, run: ScanRun): Promise<void>;
  /** Upsert listed rows; a row already detailed keeps its facts unless classifyListed says "fresh"
   *  (R-2653: status, FY, facts version or last_modified_time changed). `run` = this read's deposit
   *  account + when its listing began (a row is never stamped earlier than that — clocks of two
   *  servers can differ). */
  addListed(fy: string, rows: ListedRow[], run?: { onlyAccount?: string | null; listStartedAt?: string | null }): Promise<void>;
  /** R-2653: after a COMPLETE list — the FY's rows not listed since `since` get their detail read again
   *  (a 404 drops a document deleted in Zoho; one missed only because Zoho's pages shifted is kept). */
  requeueUnlisted(fy: string, since: string): Promise<number>;
  /** Zoho ids listed but not yet detailed, oldest first. */
  pendingDetails(fy: string, limit: number): Promise<string[]>;
  saveDetail(fy: string, zohoId: string, facts: F): Promise<void>;
  /** A listed document Zoho no longer has (deleted between the list and its detail). */
  drop(fy: string, zohoId: string): Promise<void>;
  counts(fy: string): Promise<{ listed: number; detailed: number }>;
  /** Forget the scan (read again from the start). */
  reset(fy: string): Promise<void>;
  /** R-2653: "Read again" — list the FY again but keep every stored detail (only new / changed ones
   *  are read). `onlyAccount` limits the read to one Zoho deposit account (receipts). */
  refresh(fy: string, opts: { onlyAccount: string | null; nowIso: string }): Promise<void>;
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
  store: ScanStore<F>, kind: FyReadKind, toFacts: (d: ZohoFyDocDetail) => F,
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
          .map((d) => ({
            zohoId: d.id, number: d.number, date: d.date, status: d.status.toLowerCase(),
            /* R-2653: from the list row itself — no extra call. */
            modified: text(d.raw.last_modified_time), accountId: text(d.raw.account_id),
          }));
        await store.addListed(fy, rows, run);
        if (page.more) run.nextPage += 1;
        else {
          /* R-2653: the whole list is in — a row not listed since this Read again began is probably gone
             from Zoho: its detail is read again (404 → dropped; still there → kept). Done BEFORE the run
             is saved as listed, so a crash in between does it again. */
          if (run.listStartedAt) await store.requeueUnlisted(fy, run.listStartedAt);
          run.listDone = true;
        }
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
      /* R-2653: a requeued document whose date moved out of this FY in Zoho is not this year's any more. */
      if (d.date && (d.date < range.dateStart || d.date > range.dateEnd)) { await store.drop(fy, id); queue.shift(); return false; }
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
