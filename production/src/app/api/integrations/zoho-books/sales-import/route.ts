/**
 * POST /api/integrations/zoho-books/sales-import — R-2499 (G-FY2526): a financial year's Zoho Books
 * invoices become the app's own sales, as Zoho issued them (number, date, GST split). OWNER /
 * ACCOUNTANT only (the SQL checks the same roles).
 *
 * Body { action, fy: "2025-26", … }:
 *   read     → reads the next piece of the FY from Zoho into the server's scan (list, then each
 *              invoice's detail; READ only; at most FY_CALLS_PER_REQUEST Zoho calls a request —
 *              call again after `waitMs` until `complete`). Counts come from the stored rows.
 *   restart  → R-2653: Read again — lists the FY again and reads the detail only of invoices new or
 *              changed in Zoho (status / last_modified_time); one gone from Zoho is dropped. { fresh: true }
 *              forgets the scan instead (read every detail again).
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
 *   leaveOut / takeBack → R-2949: { zohoId } (one invoice of this company's Zoho read) or { prefix }
 *              (every number starting with it; 2–20 characters, any case). Saved per company
 *              (zoho_fy_left_out); preview, the dry run and the import all rebuild the plan with the
 *              saved list, so a left-out invoice is never a pick — whatever the request says.
 *              preview also returns `toImport` (first TO_IMPORT_LIST_MAX rows), `toImportMore`, `leftOut`.
 * Zoho is never written to.
 */
import { NextResponse, type NextRequest } from "next/server";
import { NOT_CONFIGURED_MESSAGE, FY_CALLS_PER_REQUEST, zohoBooksCreds } from "@/lib/integrations/zoho-books/config";
import { dropZohoAccessToken, readConnection, resolveZohoCaller, zohoAccessToken } from "@/lib/integrations/zoho-books/store";
import { isZohoDayLimit, ZohoApiError } from "@/lib/integrations/zoho-books/api";
import { fyDateRange } from "@/lib/integrations/zoho-books/fy-fetch";
import type { PaceEntry } from "@/lib/integrations/zoho-books/zoho-pace";
import { asZohoReader } from "@/lib/integrations/zoho-books/day-calls-store";
import { zohoFyReaderName } from "@/lib/integrations/zoho-books/zoho-day-budget";
import { zohoReaderBusyMessage } from "@/lib/integrations/zoho-books/zoho-limit";
import { scanStep } from "@/lib/integrations/zoho-books/fy-import/scan";
import { partCount, partOf } from "@/lib/integrations/zoho-books/fy-import/parts";
import { readImportBatches, readScannedFacts, supabaseScanStore, type FyImportDb } from "@/lib/integrations/zoho-books/fy-import/store";
import { zohoSaleFacts, type ZohoSaleFacts } from "@/lib/integrations/zoho-books/sales-import/normalise";
import { SALES_IMPORT_ROLES, buildSalesPlan, toPick } from "@/lib/integrations/zoho-books/sales-import/plan";
import { readImportedByMonth, readPlanContext, readSellerState } from "@/lib/integrations/zoho-books/sales-import/store";
import { staleAddressCount } from "@/lib/integrations/zoho-books/sales-import/stale-address";
import { PREFIX_MESSAGE, cleanPrefix, leftOutView, toImportRows } from "@/lib/integrations/zoho-books/sales-import/left-out";
import { LEFT_OUT_MAX, addLeftOut, readLeftOut, removeLeftOut, scannedInvoiceNumber, type SavedLeftOut } from "@/lib/integrations/zoho-books/sales-import/left-out-store";
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
    try {
      if (body.fresh === true) await store.reset(fy);
      else await store.refresh(fy, { onlyAccount: null, nowIso: new Date().toISOString() });
    } catch { return fail(500, "Could not start the Zoho read again. Try again."); }
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
    /* R-2661: one Zoho reader at a time per company — a second read is refused with the running one's
       name (no Zoho call). The lease stays while this read goes on (renewed by every request; a closed
       dialog's runs out in a few minutes) and is let go when it is complete, stopped or failed. */
    const ran = await asZohoReader(caller.admin, caller.tenantId, zohoFyReaderName("sales", fy), async () => {
      let keep = false;
      const value = await (async () => { try {
      const seller = await readSellerState(db, caller.tenantId);
      const run = async () => scanStep(store, KIND, (d) => zohoSaleFacts(d, seller), conn.orgId!, await zohoAccessToken(caller, conn.refreshToken!, creds), fy,
        { history, maxCalls: Math.max(1, FY_CALLS_PER_REQUEST - used()) });
      let result;
      try { result = await run(); } catch (e) {
        if (!(e instanceof ZohoApiError && e.status === 401)) throw e;
        await dropZohoAccessToken(caller);
        result = await run();
      }
      keep = !result.complete;
      return NextResponse.json({ ok: true, fy, ...result, calls: used() });
    } catch (e) {
      if (isZohoDayLimit(e)) {
        /* R-2661: no call was made — the dialog shows the budget notice at once; the scan stays as saved. */
        const c = await store.counts(fy).catch(() => ({ listed: 0, detailed: 0 }));
        return NextResponse.json({ ok: true, fy, ...c, listDone: false, complete: false, busy: true, calls: used(),
          dayLimit: { calls: e.day.calls, budget: e.day.budget, retryAt: e.day.retryAt, day: e.day.day, limitHitAt: e.day.limitHitAt } });
      }
      if (e instanceof ZohoApiError) {
        if (e.status === 401 || e.code === "reconnect") return fail(502, "Zoho Books did not let ResellerOS read — Settings → Integrations → Zoho Books → Reconnect, then Allow.");
        return fail(502, e.message);
      }
      return fail(502, "Could not read from Zoho Books. Try again.");
    } })();
      return { value, keep };
    });
    if ("refused" in ran) return fail(409, zohoReaderBusyMessage(ran.refused));
    return ran.value;
  }

  /* R-2949: the owner's "Left out by you" list — this company's only (caller.tenantId), owner / accountant only (checked above). */
  if (action === "leaveOut" || action === "takeBack") {
    const hasId = typeof body.zohoId === "string" && body.zohoId.length > 0;
    const hasPrefix = body.prefix !== undefined;
    if (hasId === hasPrefix) return fail(400, "Choose one invoice or one number prefix.");
    const zohoId = hasId ? String(body.zohoId).slice(0, 40) : "";
    const prefix = hasPrefix ? cleanPrefix(body.prefix) : null;
    if (hasPrefix && !prefix) return fail(400, PREFIX_MESSAGE);
    try {
      if (action === "takeBack") {
        await removeLeftOut(db, caller.tenantId, hasId ? "doc" : "prefix", hasId ? zohoId : prefix!);
        return NextResponse.json({ ok: true });
      }
      const saved = await readLeftOut(db, caller.tenantId);
      if (hasId) {
        if (!saved.docs.some((d) => d.zohoId === zohoId)) {
          const number = await scannedInvoiceNumber(db, caller.tenantId, zohoId);
          if (number === null) return fail(404, "That invoice is not in the Zoho read. Preview again.");
          if (saved.docs.length >= LEFT_OUT_MAX.doc) return fail(409, `You have already left out ${saved.docs.length} invoices one by one — use "Leave out numbers starting with", or take one back first.`);
          await addLeftOut(db, caller.tenantId, caller.userId, { rule: "doc", value: zohoId, number });
        }
      } else if (!saved.prefixes.includes(prefix!)) {
        if (saved.prefixes.length >= LEFT_OUT_MAX.prefix) return fail(409, `You have already left out ${saved.prefixes.length} number prefixes — take one back first.`);
        await addLeftOut(db, caller.tenantId, caller.userId, { rule: "prefix", value: prefix! });
      }
    } catch { return fail(500, action === "takeBack" ? "Could not take that back. Try again." : "Could not save what you left out. Try again."); }
    return NextResponse.json({ ok: true });
  }

  if (action === "preview" || action === "import") {
    let plan, counts, run;
    let saved: SavedLeftOut;
    try {
      [counts, run] = await Promise.all([store.counts(fy), store.readRun(fy)]);
      if (!run?.listDone || counts.detailed < counts.listed || counts.listed === 0) {
        return fail(409, "Read the year from Zoho first (Read from Zoho) — it is not complete yet.");
      }
      const [facts, ctx, left] = await Promise.all([readScannedFacts<ZohoSaleFacts>(db, caller.tenantId, KIND, fy), readPlanContext(db, caller.tenantId, range),
        readLeftOut(db, caller.tenantId)]);
      saved = left;
      /* R-2949: the saved list, never the request — preview, dry run and import skip the same invoices. */
      plan = buildSalesPlan(facts, { ...ctx, useAnyway: readUseAnyway(body.useAnyway),
        leftOut: { ids: saved.docs.map((d) => d.zohoId), prefixes: saved.prefixes } });
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
      /* R-2949: "Left out by you" has its own block (leftOut) — not a line here. */
      const skipped = plan.rows.filter((r) => r.verdict === "skip" && !r.leftOut).slice(0, 500)
        .map((r) => ({ number: r.facts.number, date: r.facts.date, customer: r.facts.customerName, amount: r.facts.amount, reason: r.reason }));
      const list = toImportRows(plan.rows);
      return NextResponse.json({
        ok: true, fy, scanned: counts.listed, counts: plan.counts, parts,
        zohoByMonth: plan.zohoByMonth, importByMonth: plan.importByMonth, appByMonth,
        skipReasons: plan.skipReasons, skipped, batches, gstinChoices: plan.gstinChoices,
        staleAddress: staleAddressCount(plan.rows),
        toImport: list.rows, toImportMore: list.more, leftOut: leftOutView(plan.rows, saved),
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
