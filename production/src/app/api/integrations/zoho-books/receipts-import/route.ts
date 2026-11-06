/**
 * POST /api/integrations/zoho-books/receipts-import — R-2501 (G-FY2526): a financial year's Zoho Books
 * customer payments become receipts (+ the TDS Zoho recorded, any excess → advance) on the FY sales
 * imported from Zoho (R-2499), each matched to its bank line when the statement is in. OWNER /
 * ACCOUNTANT only (the SQL checks the same roles). The generic FY import framework (fy-import/), kind
 * "customerpayments".
 *
 * Body { action, fy: "2025-26", accounts?: { <Zoho account id>: <app bank account id> }, … }:
 *   read     → the next piece of the FY from Zoho into the server's scan (list, then each payment's
 *              detail; READ only; at most FY_CALLS_PER_REQUEST Zoho calls — call again after a wait
 *              until `complete`).
 *   restart  → forgets the scan.
 *   preview  → the plan from the COMPLETE scan: counts, totals, Zoho deposit accounts with the app
 *              account each goes to (owner's choice, else a suggestion), skip reasons, past batches.
 *   import   → { part, dryRun } — one part through import_zoho_fy_receipts: dryRun true (default)
 *              writes nothing. The request names only Zoho ids + the app account — every amount
 *              comes from the scan in the database. Already-booked payments with no bank line yet are
 *              sent again: the SQL matches their bank line if it has come in since.
 *   undo     → { batchId, reason } — remove_zoho_fy_receipts_import (OWNER only, while nothing in the
 *              batch was touched since; R-2501 follow-up).
 * Zoho is never written to.
 */
import { NextResponse, type NextRequest } from "next/server";
import { NOT_CONFIGURED_MESSAGE, FY_CALLS_PER_REQUEST, zohoBooksCreds } from "@/lib/integrations/zoho-books/config";
import { dropZohoAccessToken, readConnection, resolveZohoCaller, zohoAccessToken } from "@/lib/integrations/zoho-books/store";
import { ZohoApiError } from "@/lib/integrations/zoho-books/api";
import { fyDateRange } from "@/lib/integrations/zoho-books/fy-fetch";
import type { PaceEntry } from "@/lib/integrations/zoho-books/zoho-pace";
import { scanStep } from "@/lib/integrations/zoho-books/fy-import/scan";
import { partCount, partOf } from "@/lib/integrations/zoho-books/fy-import/parts";
import { readImportBatches, readScannedFacts, supabaseScanStore, type FyImportDb } from "@/lib/integrations/zoho-books/fy-import/store";
import { zohoReceiptFacts, type ZohoReceiptFacts } from "@/lib/integrations/zoho-books/receipts-import/normalise";
import { RECEIPTS_IMPORT_ROLES, buildReceiptsPlan, toReceiptPick } from "@/lib/integrations/zoho-books/receipts-import/plan";
import { parseAccountMap, readReceiptsContext } from "@/lib/integrations/zoho-books/receipts-import/store";
import { depositAccountLabel, depositAccounts } from "@/lib/payments/deposit-accounts";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const KIND = "customerpayments" as const;
const ROLE_MSG = "Only the owner or an accountant can import FY receipts from Zoho.";

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

  if (action === "restart") {
    try { await store.reset(fy); } catch { return fail(500, "Could not clear the Zoho read. Try again."); }
    return NextResponse.json({ ok: true, fy, listed: 0, detailed: 0, complete: false });
  }

  if (action === "read") {
    const creds = zohoBooksCreds();
    if (!creds) return fail(503, NOT_CONFIGURED_MESSAGE);
    let conn;
    try { conn = await readConnection(caller.admin, caller.tenantId); }
    catch { return fail(500, "Could not read the Zoho Books connection. Refresh the page."); }
    if (!conn.refreshToken) return fail(409, "Zoho Books is not connected. Settings → Integrations → Zoho Books → Connect.");
    if (!conn.orgId) return fail(409, "Choose your Zoho Books organization first.");
    const history: PaceEntry[] = [];
    const used = () => history.reduce((s, h) => s + h.calls, 0);
    try {
      const run = async () => scanStep(store, KIND, zohoReceiptFacts, conn.orgId!, await zohoAccessToken(caller, conn.refreshToken!, creds), fy,
        { history, maxCalls: Math.max(1, FY_CALLS_PER_REQUEST - used()) });
      let result;
      try { result = await run(); } catch (e) {
        if (!(e instanceof ZohoApiError && e.status === 401)) throw e;
        await dropZohoAccessToken(caller);
        result = await run();
      }
      return NextResponse.json({ ok: true, fy, ...result, calls: used() });
    } catch (e) {
      if (e instanceof ZohoApiError) {
        if (e.status === 401 || e.code === "reconnect") return fail(502, "Zoho Books did not let ResellerOS read customer payments — Settings → Integrations → Zoho Books → Reconnect, then Allow.");
        return fail(502, e.message);
      }
      return fail(502, "Could not read from Zoho Books. Try again.");
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
      plan = buildReceiptsPlan(facts, ctx);
    } catch {
      return fail(500, "Could not build the preview. Refresh and try again.");
    }
    /* To book + already booked (the SQL counts those as already, and matches a bank line that came in
       since / syncs one matched by hand), in the scan's stable order: part N is the same payments on
       every call even after part 0 was booked (review). */
    const picks = plan.rows.filter((r) => r.verdict !== "skip").map(toReceiptPick);
    const parts = partCount(picks.length);

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

    if (!picks.length) return fail(409, "Nothing to import.");
    const part = Number(body.part ?? 0);
    const slice = partOf(picks, part);
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
