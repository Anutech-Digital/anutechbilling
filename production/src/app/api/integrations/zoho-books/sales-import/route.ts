/**
 * POST /api/integrations/zoho-books/sales-import — R-2499 (G-FY2526): a financial year's Zoho Books
 * invoices become the app's own sales, as Zoho issued them (number, date, GST split). OWNER /
 * ACCOUNTANT only (the SQL checks the same roles).
 *
 * Body { action, fy: "2025-26", … }:
 *   read     → reads the next piece of the FY from Zoho into the server's scan (list, then each
 *              invoice's detail; READ only; at most FY_CALLS_PER_REQUEST Zoho calls a request —
 *              call again after `waitMs` until `complete`). Counts come from the stored rows.
 *   restart  → forgets the scan (read again from the start).
 *   preview  → the plan from the COMPLETE scan: counts, skip reasons, Zoho vs to-import totals per
 *              month, what is already in the app per month, past batches. Nothing written.
 *              R-2530: also `gstinChoices` — Zoho customers whose name matches one app customer with
 *              another PAN; preview + import take `useAnyway` {gstinChoiceKey(Zoho name, invoice PAN)
 *              (plan.ts, R-2536): customer id} (the owner's "Use this customer anyway" ticks; plan.ts
 *              honours only the matched one).
 *              R-2540: also `staleAddress` — to-import invoices whose scan was read before Zoho's billing
 *              address was kept (R-2536); the dialog asks to Read from Zoho again.
 *   import   → { part, dryRun } — one part (fy-import/parts.ts IMPORT_PART invoices) through import_zoho_fy_sales:
 *              dryRun true (default) writes nothing; false writes one batch (+ activity_log row).
 *              The request names only Zoho ids + the matched customer / items — every amount comes
 *              from the scan in the database.
 *   undo     → { batchId, reason } — remove_zoho_fy_sales_import (while untouched).
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
import { zohoSaleFacts, type ZohoSaleFacts } from "@/lib/integrations/zoho-books/sales-import/normalise";
import { SALES_IMPORT_ROLES, buildSalesPlan, toPick } from "@/lib/integrations/zoho-books/sales-import/plan";
import { readImportedByMonth, readPlanContext, readSellerState } from "@/lib/integrations/zoho-books/sales-import/store";
import { staleAddressCount } from "@/lib/integrations/zoho-books/sales-import/stale-address";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const KIND = "invoices" as const;
const ROLE_MSG = "Only the owner or an accountant can import FY sales from Zoho.";

function fail(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

/** R-2530: the owner's ticks — only string → string pairs, at most 500 (anything else is dropped). */
function readUseAnyway(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, id] of Object.entries(v as Record<string, unknown>).slice(0, 500)) {
    if (typeof id === "string" && k.length <= 300 && id.length <= 64) out[k] = id;
  }
  return out;
}

export async function POST(req: NextRequest) {
  const caller = await resolveZohoCaller();
  if (!caller) return fail(401, "Not signed in.");
  if (!(SALES_IMPORT_ROLES as readonly string[]).includes(caller.role)) return fail(403, ROLE_MSG);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";
  const fy = typeof body.fy === "string" ? body.fy : "";
  let range;
  try { range = fyDateRange(fy); } catch { return fail(400, "Choose a financial year like 2025-26."); }
  const db = caller.admin as unknown as FyImportDb;
  const store = supabaseScanStore<ZohoSaleFacts>(db, caller.tenantId, KIND);

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
      const seller = await readSellerState(db, caller.tenantId);
      const run = async () => scanStep(store, KIND, (d) => zohoSaleFacts(d, seller), conn.orgId!, await zohoAccessToken(caller, conn.refreshToken!, creds), fy,
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
        if (e.status === 401 || e.code === "reconnect") return fail(502, "Zoho Books did not let ResellerOS read — Settings → Integrations → Zoho Books → Reconnect, then Allow.");
        return fail(502, e.message);
      }
      return fail(502, "Could not read from Zoho Books. Try again.");
    }
  }

  if (action === "preview" || action === "import") {
    let plan, counts, run;
    try {
      [counts, run] = await Promise.all([store.counts(fy), store.readRun(fy)]);
      if (!run?.listDone || counts.detailed < counts.listed || counts.listed === 0) {
        return fail(409, "Read the year from Zoho first (Read from Zoho) — it is not complete yet.");
      }
      const [facts, ctx] = await Promise.all([readScannedFacts<ZohoSaleFacts>(db, caller.tenantId, KIND, fy), readPlanContext(db, caller.tenantId, range)]);
      plan = buildSalesPlan(facts, { ...ctx, useAnyway: readUseAnyway(body.useAnyway) });
    } catch {
      return fail(500, "Could not build the preview. Refresh and try again.");
    }
    /* Import + already, in the scan's stable order: part N is the same invoices on every call. */
    const picks = plan.rows.filter((r) => r.verdict !== "skip").map(toPick);
    const parts = partCount(picks.length);

    if (action === "preview") {
      let appByMonth, batches;
      try {
        [appByMonth, batches] = await Promise.all([readImportedByMonth(db, caller.tenantId, range), readImportBatches(db, caller.tenantId, KIND, fy)]);
      } catch { return fail(500, "Could not read what is already imported. Refresh and try again."); }
      const skipped = plan.rows.filter((r) => r.verdict === "skip").slice(0, 500)
        .map((r) => ({ number: r.facts.number, date: r.facts.date, customer: r.facts.customerName, amount: r.facts.amount, reason: r.reason }));
      return NextResponse.json({
        ok: true, fy, scanned: counts.listed, counts: plan.counts, parts,
        zohoByMonth: plan.zohoByMonth, importByMonth: plan.importByMonth, appByMonth,
        skipReasons: plan.skipReasons, skipped, batches, gstinChoices: plan.gstinChoices,
        staleAddress: staleAddressCount(plan.rows),
      });
    }

    if (!picks.length) return fail(409, "Nothing to import.");
    const part = Number(body.part ?? 0);
    const slice = partOf(picks, part);
    if (!slice) return fail(400, "That part does not exist. Preview again.");
    const dryRun = body.dryRun !== false;
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("import_zoho_fy_sales", {
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
    const { data, error } = await (supabase as any).rpc("remove_zoho_fy_sales_import", { p_batch_id: batchId, p_reason: String(body.reason ?? "") });
    if (error) return fail(400, (error as { message?: string }).message ?? "The import could not be removed.");
    return NextResponse.json({ ok: true, result: data });
  }

  return fail(400, "Unknown action.");
}
