/**
 * R-2535 — "Reconcile from Zoho" booked on the server, in runs. Pure rules shared by the browser
 * (preview, chunks) and the server route (POST /api/integrations/zoho-books/bulk-book):
 *
 *   • a CLEAN pair = a plan row with a booking, a customer, no problem, ticked by the plan, and
 *     paired to its Zoho payment by the bank UTR / RRN (R-2534 ref first). A row paired only by
 *     amount + date is never "clean" — a person ticks it (research item 2 safety rule);
 *   • the server books a row only when the database says the line is this company's, in this
 *     account, unmatched and after the books lock (bank_recon_run_screen), and when the row's
 *     amount and date ARE the line's (money exact — never the browser's figure);
 *   • rows are sent BOOK_CHUNK at a time (each request well inside the route's 60 s).
 */
import type { PlanRow } from "./bulk-reconcile-plan";
import type { BookedRow } from "@/components/features/banking/zoho-bulk-book";

export const BOOK_CHUNK = 10;
export const BULK_BOOK_URL = "/api/integrations/zoho-books/bulk-book";

export type ScreenReason = "not_found" | "matched" | "locked";
export interface ScreenRow { txn_id: string; ok: boolean; reason: ScreenReason | null; credit: number | null; txn_date: string | null }
export interface RefusedRow { txnId: string; txnDate: string; credit: number; reason: string }

export function screenText(reason: ScreenReason | null): string {
  if (reason === "matched") return "Already reconciled — not booked again.";
  if (reason === "locked") return "In a locked month (books lock) — not booked. Unlock the month in Accounting → Overview, or book it by hand.";
  return "Not a bank line of this account — not booked. Reload the page.";
}

/** Plan rows a person need not look at: book them all in one go. */
export function isCleanPair(r: PlanRow): boolean {
  return Boolean(r.book && r.customer && r.ticked && r.problems.length === 0 && r.zoho.by === "utr");
}

export interface RunPreview { clean: number; cleanTotal: number; needLook: number }

/** "N clean pairs, M need a look" — over the rows not booked yet. */
export function previewCounts(plan: readonly PlanRow[], booked: ReadonlySet<string>): RunPreview {
  let clean = 0, cleanTotal = 0, needLook = 0;
  for (const r of plan) {
    if (booked.has(r.txnId)) continue;
    if (isCleanPair(r)) { clean += 1; cleanTotal += r.credit; } else needLook += 1;
  }
  return { clean, cleanTotal, needLook };
}

export function chunks<T>(list: readonly T[], size: number = BOOK_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** The run line's kind (bank_recon_run_lines.kind): only a single new sale is undone by the run. */
export function bookKindOf(r: PlanRow): "new_sale" | "pay_item" | "opening" | "split" {
  const b = r.book;
  if (!b) return "pay_item";
  const sales = (b as { sales?: unknown[] }).sales;
  if (b.kind === "new_sale") return Array.isArray(sales) && sales.length > 0 ? "split" : "new_sale";
  if (b.kind === "opening") return (b.opening?.parts?.length ?? 0) > 1 ? "split" : "opening";
  return "pay_item";
}

/**
 * The server's screen: which rows it may book. A row is refused when the database refused its
 * line, when the row's amount or date is not the line's, when its customer does not exist yet
 * (the browser creates Zoho's new customers first), or when the same line comes twice.
 */
export function screenRows(rows: readonly PlanRow[], screen: readonly ScreenRow[]): { ok: PlanRow[]; refused: RefusedRow[] } {
  const byId = new Map(screen.map((s) => [s.txn_id, s]));
  const ok: PlanRow[] = [];
  const refused: RefusedRow[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const no = (reason: string) => refused.push({ txnId: r.txnId, txnDate: r.txnDate, credit: r.credit, reason });
    const s = byId.get(r.txnId);
    if (seen.has(r.txnId)) { no("The same line was sent twice — booked once."); continue; }
    seen.add(r.txnId);
    if (!s || !s.ok) { no(screenText(s?.reason ?? "not_found")); continue; }
    if (Number(s.credit) !== r.credit || String(s.txn_date ?? "").slice(0, 10) !== r.txnDate.slice(0, 10)) {
      no("The bank line's amount or date is not what the plan shows — not booked. Press Start again to plan it afresh.");
      continue;
    }
    if (!r.book || !r.customer) { no("This row has nothing to book."); continue; }
    if (r.customer.kind !== "existing") { no(`${r.customer.name} is not in the app yet — not booked. Press Book again.`); continue; }
    ok.push(r);
  }
  return { ok, refused };
}

/* ─── The browser's side of a run ─────────────────────────────────────────────────────────── */


export interface RunResult {
  runId: string | null;
  done: BookedRow[];
  refused: RefusedRow[];
  error: { txnId: string; txnDate: string; credit: number; reason: string } | null;
}
type ChunkAnswer = { ok: true; runId: string | null; done: BookedRow[]; refused: RefusedRow[]; error: RunResult["error"] }
  | { ok: false; error: string; why?: string };

/**
 * Sends the rows BOOK_CHUNK at a time under one run id; stops at the first row the server could not
 * book (the rest stay for the next press, as before). `onChunk` reports progress.
 */
export async function bookOnServer(
  accountId: string, rows: readonly PlanRow[], runId: string | null,
  post: typeof fetch = fetch, onChunk?: (doneSoFar: number, total: number) => void,
): Promise<RunResult> {
  const out: RunResult = { runId, done: [], refused: [], error: null };
  let sent = 0;
  for (const part of chunks(rows)) {
    let ans: ChunkAnswer | null = null;
    try {
      const res = await post(BULK_BOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId, runId: out.runId, rows: part }) });
      ans = (await res.json().catch(() => null)) as ChunkAnswer | null;
    } catch {
      ans = { ok: false, error: "Could not reach the server.", why: "The internet connection dropped." };
    }
    if (!ans || !ans.ok) {
      const first = part[0];
      out.error = { txnId: first.txnId, txnDate: first.txnDate, credit: first.credit,
        reason: ans ? `${ans.error}${ans.why ? ` ${ans.why}` : ""}` : "The server did not answer — nothing in this group was booked." };
      return out;
    }
    out.runId = ans.runId ?? out.runId;
    out.done.push(...ans.done);
    out.refused.push(...ans.refused);
    sent += part.length;
    onChunk?.(sent, rows.length);
    if (ans.error) { out.error = ans.error; return out; }
  }
  return out;
}
