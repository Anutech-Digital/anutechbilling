/**
 * POST /api/integrations/zoho-books/bulk-book — R-2535: "Reconcile from Zoho" booked on the server.
 *
 *   { accountId, runId?, rows: PlanRow[] (≤ BOOK_CHUNK) }
 *     → { ok, runId, done: BookedRow[], error: {txnId, …, reason} | null, refused: RefusedRow[] }
 *
 * The browser plans (R-2402 / R-2419 rules, Zoho payments paired by UTR first — R-2534 — then amount
 * + date) and sends the ticked rows in chunks; this route books them with the person's own session
 * through bookRows (zoho-bulk-book.ts) + serverBookDeps — the Reconcile sheet's RPCs, unchanged, so
 * nothing here writes money itself. Before booking, the database screens every line
 * (bank_recon_run_screen): another company's or account's line, a line already reconciled and a line
 * in a locked month are refused; the row's amount and date must BE the line's. Booked lines are
 * recorded on the run (bank_recon_run_record) for "Undo this run" (undo_bank_recon_run). The page
 * refreshes ONCE when the run ends — no reload per row.
 * Owner / accountant only (as Find in Zoho). Every refusal says what, why and the next step (§24).
 */
import { NextResponse, type NextRequest } from "next/server";
import { ZOHO_FIND_ROLES } from "@/lib/integrations/zoho-books/config";
import { resolveZohoCaller } from "@/lib/integrations/zoho-books/store";
import { createClient } from "@/lib/supabase/server";
import { appUrl } from "@/lib/app-url";
import { bookRows } from "@/components/features/banking/zoho-bulk-book";
import type { PlanRow } from "@/lib/integrations/zoho-books/bulk-reconcile-plan";
import { BOOK_CHUNK, bookKindOf, screenRows, type ScreenRow } from "@/lib/integrations/zoho-books/bulk-book-run";
import { sameOriginPost, serverBookDeps, type RunDb } from "@/lib/integrations/zoho-books/bulk-book-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status: number, code: string, error: string, why: string, next: { label: string; href?: string }) {
  return NextResponse.json({ ok: false, code, error, why, next }, { status });
}

const isRow = (r: unknown): r is PlanRow => {
  const o = r as Partial<PlanRow> | null;
  return !!o && typeof o.txnId === "string" && UUID_RE.test(o.txnId) && typeof o.txnDate === "string" && typeof o.credit === "number";
};

export async function POST(req: NextRequest) {
  const caller = await resolveZohoCaller();
  if (!caller) return fail(401, "signed_out", "You are signed out.", "Your session ended.", { label: "Sign in", href: "/login" });
  if (!(ZOHO_FIND_ROLES as readonly string[]).includes(caller.role)) {
    return fail(403, "role", "Only an owner or accountant can book from Zoho Books.",
      "Booking a run creates receipts and invoices.", { label: "Ask the owner to run it", href: "/accounting/banking" });
  }

  const body = (await req.json().catch(() => ({}))) as { accountId?: unknown; runId?: unknown; rows?: unknown };
  const accountId = typeof body.accountId === "string" && UUID_RE.test(body.accountId) ? body.accountId : null;
  if (!accountId) return fail(400, "bad_request", "No bank account was given.", "The page did not say which account to book.", { label: "Reload the page" });
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0 || rows.length > BOOK_CHUNK || !rows.every(isRow)) {
    return fail(400, "bad_request", `Send 1 to ${BOOK_CHUNK} rows at a time.`, "The page sent rows this server cannot read.", { label: "Reload the page" });
  }
  let runId = typeof body.runId === "string" && UUID_RE.test(body.runId) ? body.runId : null;

  const db = createClient() as unknown as RunDb;
  const { data: screenData, error: screenErr } = await db.rpc("bank_recon_run_screen", { p_account_id: accountId, p_txn_ids: rows.map((r) => r.txnId) });
  if (screenErr) {
    const denied = (screenErr as { code?: string }).code === "42501";
    return fail(denied ? 403 : 500, denied ? "role" : "screen_failed", denied ? "Only an owner or accountant can book from Zoho Books." : "Could not check the bank lines.",
      denied ? screenErr.message : "The database did not answer — nothing was booked.", { label: "Press Book again" });
  }
  const { ok, refused } = screenRows(rows, (screenData ?? []) as ScreenRow[]);
  if (ok.length === 0) return NextResponse.json({ ok: true, runId, done: [], recorded: [], error: null, refused });

  if (!runId) {
    const { data, error } = await db.rpc("bank_recon_run_start", { p_account_id: accountId });
    if (error || typeof data !== "string") {
      return fail(500, "run_failed", "Could not start the run.", error?.message ?? "The database gave no run id — nothing was booked.", { label: "Press Book again" });
    }
    runId = data;
  }

  /* The app's own address from config in production (never a request header, R-723); localhost in dev. */
  const origin = process.env.NODE_ENV === "production" ? appUrl() : req.nextUrl.origin;
  const post = sameOriginPost(origin, req.headers.get("cookie"));
  const run = await bookRows(ok, new Set(ok.map((r) => r.txnId)), new Set(), serverBookDeps(db, accountId, post));

  /* Each booked line on the run (for Undo). A failed record does not undo the booking — it says so. */
  const kindOf = new Map(ok.map((r) => [r.txnId, bookKindOf(r)]));
  const recorded: string[] = [];
  for (const d of run.done) {
    if (d.outcome !== "booked") continue;
    const { data, error } = await db.rpc("bank_recon_run_record", { p_run_id: runId, p_txn_id: d.txnId, p_kind: kindOf.get(d.txnId) ?? "other" });
    if (error || data !== true) {
      d.todo.push(`Booked, but not on this run${error ? ` (${error.message})` : " (another run already holds this line)"} — "Undo this run" leaves it; un-reconcile it by hand if needed.`);
    } else recorded.push(d.txnId);
  }
  return NextResponse.json({ ok: true, runId, done: run.done, recorded, error: run.error, refused });
}
