/**
 * POST /api/integrations/zoho-books/receipts-import — R-2501 (G-FY2526): a financial year's Zoho Books
 * customer payments become receipts (+ the TDS Zoho recorded, any excess → advance) on the FY sales
 * imported from Zoho (R-2499), each matched to its bank line when the statement is in. OWNER /
 * ACCOUNTANT only (the SQL checks the same roles). The generic FY import framework (fy-import/), kind
 * "customerpayments".
 *
 * Body { action, fy: "2025-26", accounts?: { <Zoho account id>: <app bank account id> | "leave-out" | "" }, … }:
 *   start    → R-2607: asks the SERVER to read the FY from Zoho into its scan (list, then each
 *              payment's detail; READ only). The cron zoho-fy-read reads it to the end with the
 *              browser closed; progress is saved after every Zoho call, so it resumes.
 *   step     → R-2607: the open dialog runs one server pass too (same lease — never two at once).
 *   status   → R-2607: progress { listed, detailed, complete, running, error } — no Zoho call.
 *   restart  → forgets the scan (refused while a server pass runs).
 *   preview  → the plan from the COMPLETE scan: counts, totals, Zoho deposit accounts with the app
 *              account each goes to (owner's choice, else a suggestion; "none" = Leave these out → its
 *              payments are skipped "Left out by owner."), skip reasons, past batches.
 *   import   → { part, dryRun } — one part (RECEIPTS_IMPORT_PART payments, R-2547: under the 8 s
 *              statement limit) through import_zoho_fy_receipts: dryRun true (default)
 *              writes nothing. The request names only Zoho ids + the app account — every amount
 *              comes from the scan in the database. NO suggestion here (R-2501 fix): only the accounts the
 *              dialog sent (what it showed) are used — a Zoho account it did not send is skipped.
 *              Already-booked payments with no bank line yet are sent again: the SQL matches their bank line if it has come in since.
 *   undo     → { batchId, reason } — remove_zoho_fy_receipts_import (OWNER only, while nothing in the
 *              batch was touched since; R-2501 follow-up).
 * Zoho is never written to.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolveZohoCaller } from "@/lib/integrations/zoho-books/store";
import { fyDateRange } from "@/lib/integrations/zoho-books/fy-fetch";
import { supabaseBgStore } from "@/lib/integrations/zoho-books/fy-import/bg-store";
import { companyReadPass } from "@/lib/integrations/zoho-books/fy-import/read-job.server";
import { RECEIPTS_IMPORT_PART, partCount, partOf } from "@/lib/integrations/zoho-books/fy-import/parts";
import { readImportBatches, readScannedFacts, supabaseScanStore, type FyImportDb } from "@/lib/integrations/zoho-books/fy-import/store";
import type { ZohoReceiptFacts } from "@/lib/integrations/zoho-books/receipts-import/normalise";
import { RECEIPTS_IMPORT_ROLES, buildReceiptsPlan, toReceiptPick } from "@/lib/integrations/zoho-books/receipts-import/plan";
import { parseAccountMap, readReceiptsContext } from "@/lib/integrations/zoho-books/receipts-import/store";
import { depositAccountLabel, depositAccounts } from "@/lib/payments/deposit-accounts";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/* R-2607: a "step" is one server pass (STEP_BUDGET_MS of new steps + the last one finishing). */
export const maxDuration = 120;

const KIND = "customerpayments" as const;
const ROLE_MSG = "Only the owner or an accountant can import FY receipts from Zoho.";
/** R-2607: the dialog's own server pass — under maxDuration (60 s) with room for the counts. */
const STEP_BUDGET_MS = 40_000;
const READING_MSG = "The server is reading Zoho right now — wait until it says it has read all payments, then read again.";

function fail(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(req: NextRequest) {
  const caller = await resolveZohoCaller();
  if (!caller) return fail(401, "Not signed in.");
  if (!(RECEIPTS_IMPORT_ROLES as readonly string[]).includes(caller.role)) return fail(403, ROLE_MSG);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";
  const fy = typeof body.fy === "string" ? body.fy : "";
  let range;
  try { range = fyDateRange(fy); } catch { return fail(400, "Choose a financial year like 2025-26."); }
  const db = caller.admin as unknown as FyImportDb;
  const store = supabaseScanStore<ZohoReceiptFacts>(db, caller.tenantId, KIND);

  const bg = supabaseBgStore(db, caller.tenantId, KIND);

  if (action === "restart") {
    /* R-2607: never under a running pass — it would save its old page over the fresh start. The
       restart TAKES the lease itself first (no pass can start in between), then forgets the run. */
    try {
      const s = await bg.readBg(fy);
      if (s && !(await bg.takeLease(fy, Date.now() + 60_000, Date.now()))) return fail(409, READING_MSG);
      await store.reset(fy);
    } catch { return fail(500, "Could not clear the Zoho read. Try again."); }
    return NextResponse.json({ ok: true, fy, listed: 0, detailed: 0, complete: false, running: false, error: null });
  }

  /* R-2607: the read runs on the SERVER. start = ask for it (keeps what is read — resumes);
     step = the open dialog lends a hand: one server pass (≤ STEP_BUDGET_MS) under the same lease
     as the cron zoho-fy-read, which carries on with the window closed; status = progress only. */
  if (action === "start" || action === "step" || action === "status") {
    try {
      if (action === "start") await bg.request(fy, caller.userId);
      if (action === "step") await companyReadPass(caller.admin, caller.tenantId, KIND, fy, { budgetMs: STEP_BUDGET_MS, requireRequest: true });
      const [c, run, s] = await Promise.all([store.counts(fy), store.readRun(fy), bg.readBg(fy)]);
      return NextResponse.json({
        ok: true, fy, ...c,
        complete: !!run?.listDone && c.detailed >= c.listed && !s?.requestedAt,
        running: !!s?.requestedAt, error: s?.error ?? null, finishedAt: s?.finishedAt ?? null, lastStepAt: s?.lastStepAt ?? null,
      });
    } catch {
      return fail(500, "Could not reach the Zoho read. Try again.");
    }
  }

  if (action === "preview" || action === "import") {
    const accountMap = parseAccountMap(body.accounts);
    let plan, counts, run, ctx;
    try {
      [counts, run] = await Promise.all([store.counts(fy), store.readRun(fy)]);
      if (!run?.listDone || counts.detailed < counts.listed || counts.listed === 0) {
        return fail(409, "Read the year from Zoho first (Read from Zoho) — it is not complete yet.");
      }
      let facts;
      [facts, ctx] = await Promise.all([
        readScannedFacts<ZohoReceiptFacts>(db, caller.tenantId, KIND, fy),
        readReceiptsContext(db, caller.tenantId, range, accountMap),
      ]);
      plan = buildReceiptsPlan(facts, ctx, { suggest: action === "preview" });
    } catch {
      return fail(500, "Could not build the preview. Refresh and try again.");
    }
    /* To book + already booked (the SQL counts those as already, and matches a bank line that came in
       since / syncs one matched by hand), in the scan's stable order: part N is the same payments on
       every call even after part 0 was booked (review). */
    const picks = plan.rows.filter((r) => r.verdict !== "skip").map(toReceiptPick);
    const parts = partCount(picks.length, RECEIPTS_IMPORT_PART);

    if (action === "preview") {
      let batches;
      try { batches = await readImportBatches(db, caller.tenantId, KIND, fy); }
      catch { return fail(500, "Could not read what is already imported. Refresh and try again."); }
      const skipped = plan.rows.filter((r) => r.verdict === "skip").slice(0, 500)
        .map((r) => ({ number: r.facts.number, date: r.facts.date, customer: r.facts.customerName, amount: r.facts.amount, reason: r.reason }));
      return NextResponse.json({
        ok: true, fy, scanned: counts.listed, counts: plan.counts, totals: plan.totals, parts,
        deposits: plan.deposits, skipReasons: plan.skipReasons, skipped, batches,
        /* Remove import is the OWNER's (remove_zoho_fy_receipts_import checks the same) — the screen
           offers it only to the owner (button = action). */
        canRemove: caller.role === "owner",
        /* For the "Zoho account → app account" choice: this company's open accounts. */
        accounts: depositAccounts(ctx.bankAccounts).map((a) => ({ id: a.id, name: depositAccountLabel(a) })),
      });
    }

    if (!picks.length) return fail(409, "Nothing to import — choose the app account for each Zoho account (or Leave these out), then check again.");
    const part = Number(body.part ?? 0);
    const slice = partOf(picks, part, RECEIPTS_IMPORT_PART);
    if (!slice) return fail(400, "That part does not exist. Preview again.");
    const dryRun = body.dryRun !== false;
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("import_zoho_fy_receipts", {
      p_fy: fy, p_picks: slice, p_dry_run: dryRun,
    });
    if (error) return fail(400, (error as { message?: string }).message ?? "The import was refused.");
    return NextResponse.json({ ok: true, fy, part, parts, result: data });
  }

  if (action === "undo") {
    const batchId = typeof body.batchId === "string" ? body.batchId : "";
    if (!/^[0-9a-f-]{36}$/i.test(batchId)) return fail(400, "Choose an import to remove.");
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("remove_zoho_fy_receipts_import", { p_batch_id: batchId, p_reason: String(body.reason ?? "") });
    if (error) return fail(400, (error as { message?: string }).message ?? "The import could not be removed.");
    return NextResponse.json({ ok: true, result: data });
  }

  return fail(400, "Unknown action.");
}
