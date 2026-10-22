/**
 * /api/integrations/zoho-books/import — R-1753, "Import from Zoho" for the caller's OWN tenant.
 *
 *   GET  → { open, last_import } — the unfinished dry run (progress) and the latest import.
 *   POST { action: "start", months? } → a new dry run (replaces an unfinished one).
 *   POST { action: "step" }           → reads the next part from Zoho (≤ ~40 requests, paced
 *                                       under Zoho's 100 a minute); call again until "ready".
 *   POST { action: "dry_run" }        → counts + problems (nothing written).
 *   POST { action: "import" }         → zoho_books_import_apply — one transaction, as the
 *                                       signed-in person (their tenant, their role).
 *   POST { action: "undo", run_id, reason } → zoho_books_import_undo.
 *
 * Read-only at Zoho, chosen organization only. Owner / manager / accountant. The tenant always
 * comes from the signed-in user's own row — never from the request.
 */
import { NextResponse, type NextRequest } from "next/server";
import { NOT_CONFIGURED_MESSAGE, ROLE_MESSAGE, ZOHO_BOOKS_MANAGE_ROLES, zohoBooksCreds } from "@/lib/integrations/zoho-books/config";
import { dropZohoAccessToken, readConnection, resolveZohoCaller, zohoAccessToken } from "@/lib/integrations/zoho-books/store";
import { ZohoApiError } from "@/lib/integrations/zoho-books/api";
import { scanStep } from "@/lib/integrations/zoho-books/import-scan";
import { buildImportPlan, summarisePlan } from "@/lib/integrations/zoho-books/import-plan";
import {
  ALLOWED_MONTHS, DEFAULT_MONTHS, loadPlanInputs, readRuns, sinceFor, startRun, supabaseScanStore, type RunRow,
} from "@/lib/integrations/zoho-books/import-store";
import { createClient } from "@/lib/supabase/server";
import { istToday } from "@/lib/dates/ist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function progressOf(r: RunRow | null) {
  if (!r) return null;
  return {
    id: r.id,
    phase: r.phase,
    since: r.since,
    months: r.months,
    contacts_read: r.contacts_read,
    invoices_read: r.invoices_read,
    details_total: r.details_total,
    details_done: r.details_done,
    last_error: r.last_error,
    started_at: r.started_at,
    updated_at: r.updated_at,
    scanned_at: r.scanned_at,
    imported_at: r.imported_at,
    result: r.result,
    undone_at: r.undone_at,
  };
}

const fail = (error: string, status: number) => NextResponse.json({ ok: false, error }, { status });

type Caller = NonNullable<Awaited<ReturnType<typeof resolveZohoCaller>>>;
type Gate = { res: NextResponse; caller?: undefined } | { res?: undefined; caller: Caller };

async function gate(): Promise<Gate> {
  const caller = await resolveZohoCaller();
  if (!caller) return { res: fail("Not signed in.", 401) };
  if (!(ZOHO_BOOKS_MANAGE_ROLES as readonly string[]).includes(caller.role)) {
    return { res: fail(ROLE_MESSAGE.replace("connect", "import from"), 403) };
  }
  return { caller };
}

export async function GET(): Promise<NextResponse> {
  const g = await gate();
  if (g.res) return g.res;
  const caller = g.caller;
  try {
    const { open, lastImport } = await readRuns(caller.admin, caller.tenantId);
    return NextResponse.json({ ok: true, open: progressOf(open), last_import: progressOf(lastImport), default_months: DEFAULT_MONTHS });
  } catch {
    return fail("Could not read the Zoho import status. Refresh the page.", 500);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const g = await gate();
  if (g.res) return g.res;
  const { caller } = g;
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty body */ }
  const action = String(body.action ?? "");

  if (action === "undo") {
    const runId = String(body.run_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(runId)) return fail("Choose the import to undo.", 400);
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("zoho_books_import_undo", { p_run_id: runId, p_reason: String(body.reason ?? "") });
    if (error) return fail(error.message || "Could not undo the import.", 409);
    return NextResponse.json({ ok: true, result: data });
  }

  const creds = zohoBooksCreds();
  if (!creds) return fail(NOT_CONFIGURED_MESSAGE, 503);
  let conn;
  try { conn = await readConnection(caller.admin, caller.tenantId); }
  catch { return fail("Could not read the Zoho Books connection.", 500); }
  if (!conn.refreshToken) return fail("Zoho Books is not connected. Press Connect Zoho Books first.", 409);
  if (!conn.orgId) return fail("Choose your Zoho Books organization first.", 409);

  try {
    if (action === "start") {
      const months = ALLOWED_MONTHS.includes(Number(body.months)) ? Number(body.months) : DEFAULT_MONTHS;
      const run = await startRun(caller.admin, caller.tenantId, caller.userId, conn.orgId, sinceFor(istToday(), months), months);
      return NextResponse.json({ ok: true, open: progressOf(run) });
    }

    const { open } = await readRuns(caller.admin, caller.tenantId);
    if (!open) return fail("Start a dry run first.", 409);
    if (open.org_id !== conn.orgId) return fail("The Zoho Books organization changed since this dry run. Start a new dry run.", 409);

    if (action === "step") {
      if (open.phase === "ready") return NextResponse.json({ ok: true, open: progressOf(open), rate_limited: false });
      const scanStore = supabaseScanStore(caller.admin, caller.tenantId, open.id);
      let rateLimited = false;
      try {
        const token = await zohoAccessToken(caller, conn.refreshToken, creds);
        rateLimited = (await scanStep(open, { store: scanStore, token, maxMs: 35_000 })).rateLimited;
      } catch (e) {
        /* R-1757: Zoho busy (token or API rate limit) is a pause, never "access has ended":
           the cursor is kept and the dialog continues after a minute. */
        if (e instanceof ZohoApiError && e.code === "busy") {
          rateLimited = true;
          await scanStore.saveRun({ last_error: e.message }).catch(() => undefined);
        } else {
          /* A cached token Zoho refused: drop it so Continue mints a fresh one. */
          if (e instanceof ZohoApiError && e.status === 401) await dropZohoAccessToken(caller);
          throw e;
        }
      }
      const { open: after } = await readRuns(caller.admin, caller.tenantId);
      return NextResponse.json({ ok: true, open: progressOf(after), rate_limited: rateLimited });
    }

    if (action === "dry_run" || action === "import") {
      if (open.phase !== "ready") return fail("Reading from Zoho is not finished yet. Continue the dry run.", 409);
      const inputs = await loadPlanInputs(caller.admin, caller.tenantId, open.id);
      const plan = buildImportPlan({ ...inputs, today: istToday(), since: open.since });
      if (action === "dry_run") {
        return NextResponse.json({ ok: true, open: progressOf(open), summary: summarisePlan(plan) });
      }
      const supabase = createClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc("zoho_books_import_apply", {
        p_run_id: open.id,
        p_customers: plan.contactRows,
        p_subscriptions: plan.subscriptions,
        p_invoices: plan.invoices,
      });
      if (error) return fail(error.message || "The import stopped. Nothing was imported.", 409);
      return NextResponse.json({ ok: true, result: data });
    }
    return fail("Unknown action.", 400);
  } catch (e) {
    const msg = e instanceof ZohoApiError ? e.message : e instanceof Error && e.message.startsWith("Could not") ? e.message : "Could not read from Zoho Books. Press Continue to try again.";
    return fail(msg, 502);
  }
}
