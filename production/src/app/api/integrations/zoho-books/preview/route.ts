/**
 * POST /api/integrations/zoho-books/preview — R-1749.
 *
 * Reads COUNTS ONLY from the tenant's chosen Zoho Books organization (nothing is imported,
 * nothing is written to Zoho): contacts, invoices (total / open with balance > 0), and
 * invoices carrying the Subs Period / Service Expiry custom fields.
 * POST, not GET: it makes dozens of calls to Zoho and must not run from a link prefetch.
 * Owner / manager / accountant.
 */
import { NextResponse } from "next/server";
import { NOT_CONFIGURED_MESSAGE, ROLE_MESSAGE, ZOHO_BOOKS_MANAGE_ROLES, zohoBooksCreds } from "@/lib/integrations/zoho-books/config";
import { readConnection, resolveZohoCaller, zohoAccessToken } from "@/lib/integrations/zoho-books/store";
import { previewCounts, ZohoApiError } from "@/lib/integrations/zoho-books/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST() {
  const caller = await resolveZohoCaller();
  if (!caller) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
  if (!(ZOHO_BOOKS_MANAGE_ROLES as readonly string[]).includes(caller.role)) return NextResponse.json({ ok: false, error: ROLE_MESSAGE }, { status: 403 });
  const creds = zohoBooksCreds();
  if (!creds) return NextResponse.json({ ok: false, error: NOT_CONFIGURED_MESSAGE }, { status: 503 });

  try {
    const conn = await readConnection(caller.admin, caller.tenantId);
    if (!conn.refreshToken) {
      return NextResponse.json({ ok: false, error: "Zoho Books is not connected. Press Connect Zoho Books first." }, { status: 409 });
    }
    if (!conn.orgId) {
      return NextResponse.json({ ok: false, error: "Choose your Zoho Books organization first." }, { status: 409 });
    }
    const token = await zohoAccessToken(caller, conn.refreshToken, creds);
    const preview = await previewCounts(conn.orgId, token);
    return NextResponse.json({ ok: true, org_name: conn.orgName, preview });
  } catch (e) {
    const msg = e instanceof ZohoApiError ? e.message : "Could not read from Zoho Books. Try again.";
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
