/**
 * POST /api/integrations/zoho-books/fy-counts — R-2498 (G-FY2526).
 *
 * Body: { fy: "2025-26", cursor?: <from the last answer> }. Counts the tenant's own Zoho Books
 * invoices, credit notes, bills, expenses and vendor payments dated in that financial year
 * (Zoho's date_start / date_end). COUNTS ONLY — nothing is imported, nothing written anywhere.
 *
 * At most FY_CALLS_PER_REQUEST Zoho calls per request; the answer carries a `cursor` while there is
 * more, and the card sends it back after the pace wait (zoho-pace.ts — under Zoho's ~100/min).
 * A list the stored sign-in has no scope for (a connection made before R-2498) is listed in
 * `needsReconnect` with the Reconnect line — the card then offers Reconnect.
 * Owner / manager / accountant (same as Preview from Zoho).
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  NOT_CONFIGURED_MESSAGE, ROLE_MESSAGE, ZOHO_BOOKS_MANAGE_ROLES, FY_CALLS_PER_REQUEST, fyReconnectMessage, zohoBooksCreds,
} from "@/lib/integrations/zoho-books/config";
import { dropZohoAccessToken, readConnection, resolveZohoCaller, zohoAccessToken } from "@/lib/integrations/zoho-books/store";
import { ZohoApiError } from "@/lib/integrations/zoho-books/api";
import { countFyDocs, FyCursorError, fyDateRange, type FyCountCursor } from "@/lib/integrations/zoho-books/fy-fetch";
import type { PaceEntry } from "@/lib/integrations/zoho-books/zoho-pace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function fail(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(req: NextRequest) {
  const caller = await resolveZohoCaller();
  if (!caller) return fail(401, "Not signed in.");
  if (!(ZOHO_BOOKS_MANAGE_ROLES as readonly string[]).includes(caller.role)) return fail(403, ROLE_MESSAGE);
  const creds = zohoBooksCreds();
  if (!creds) return fail(503, NOT_CONFIGURED_MESSAGE);

  const body = (await req.json().catch(() => ({}))) as { fy?: unknown; cursor?: unknown };
  const fy = typeof body.fy === "string" ? body.fy : "";
  try { fyDateRange(fy); } catch { return fail(400, "Choose a financial year like 2025-26."); }
  const cursor = body.cursor && typeof body.cursor === "object" ? (body.cursor as FyCountCursor) : null;

  let conn;
  try { conn = await readConnection(caller.admin, caller.tenantId); }
  catch { return fail(500, "Could not read the Zoho Books connection. Refresh the page."); }
  if (!conn.refreshToken) return fail(409, "Zoho Books is not connected. Press Connect Zoho Books first.");
  if (!conn.orgId) return fail(409, "Choose your Zoho Books organization first.");

  /* One history for both tries: a 401 retry still counts the first try's Zoho calls, so `calls`
     (what the card paces on) is the real number and the request stays within FY_CALLS_PER_REQUEST. */
  const history: PaceEntry[] = [];
  const used = () => history.reduce((s, h) => s + h.calls, 0);
  const run = async () => countFyDocs(conn.orgId!, await zohoAccessToken(caller, conn.refreshToken!, creds), fy, cursor,
    { history, maxCalls: Math.max(1, FY_CALLS_PER_REQUEST - used()) });
  try {
    let result;
    try {
      result = await run();
    } catch (e) {
      if (!(e instanceof ZohoApiError && e.status === 401)) throw e;
      await dropZohoAccessToken(caller);
      result = await run();
    }
    return NextResponse.json({
      ok: true, fy, ...result, calls: used(),
      ...(result.needsReconnect.length ? { message: fyReconnectMessage(result.needsReconnect) } : {}),
    });
  } catch (e) {
    if (e instanceof FyCursorError) return fail(400, "The count was interrupted. Press Count FY again.");
    if (e instanceof ZohoApiError) {
      if (e.status === 401 || e.code === "reconnect") return fail(502, "Zoho Books did not let ResellerOS read — press Reconnect, then Allow on the Zoho screen.");
      return fail(502, e.message);
    }
    return fail(502, "Could not read from Zoho Books. Try again.");
  }
}
