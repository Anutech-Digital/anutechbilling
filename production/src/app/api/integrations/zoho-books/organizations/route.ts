/**
 * /api/integrations/zoho-books/organizations — R-1749.
 *
 *   GET  → { organizations: [{id, name}] } the Zoho Books organizations this tenant's
 *          connected login can see (read live from Zoho, server-side).
 *   POST { organization_id } → save that ONE organization on the caller's tenant. The id must be
 *          in Zoho's own list for this login — an id typed by hand is refused.
 * Owner / manager / accountant.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ROLE_MESSAGE, ZOHO_BOOKS_MANAGE_ROLES, zohoBooksCreds, NOT_CONFIGURED_MESSAGE } from "@/lib/integrations/zoho-books/config";
import { readConnection, resolveZohoCaller, saveOrganization, zohoAccessToken, type ZohoCaller } from "@/lib/integrations/zoho-books/store";
import { listOrganizations, ZohoApiError, type ZohoOrg } from "@/lib/integrations/zoho-books/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Gate = { caller: ZohoCaller; orgs: ZohoOrg[] } | { res: NextResponse };

async function loadOrgs(): Promise<Gate> {
  const caller = await resolveZohoCaller();
  if (!caller) return { res: NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 }) };
  if (!(ZOHO_BOOKS_MANAGE_ROLES as readonly string[]).includes(caller.role)) return { res: NextResponse.json({ ok: false, error: ROLE_MESSAGE }, { status: 403 }) };
  const creds = zohoBooksCreds();
  if (!creds) return { res: NextResponse.json({ ok: false, error: NOT_CONFIGURED_MESSAGE }, { status: 503 }) };
  try {
    const conn = await readConnection(caller.admin, caller.tenantId);
    if (!conn.refreshToken) {
      return { res: NextResponse.json({ ok: false, error: "Zoho Books is not connected. Press Connect Zoho Books first." }, { status: 409 }) };
    }
    const token = await zohoAccessToken(caller, conn.refreshToken, creds);
    return { caller, orgs: await listOrganizations(token) };
  } catch (e) {
    const msg = e instanceof ZohoApiError ? e.message : "Could not read your Zoho Books organizations. Try again.";
    return { res: NextResponse.json({ ok: false, error: msg }, { status: 502 }) };
  }
}

export async function GET() {
  const g = await loadOrgs();
  if ("res" in g) return g.res;
  return NextResponse.json({ ok: true, organizations: g.orgs });
}

const body = z.object({ organization_id: z.string().trim().min(1).max(40) });

export async function POST(req: NextRequest) {
  let raw: unknown;
  try { raw = await req.json(); } catch { raw = {}; }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Choose an organization." }, { status: 400 });

  const g = await loadOrgs();
  if ("res" in g) return g.res;
  const org = g.orgs.find((o) => o.id === parsed.data.organization_id);
  if (!org) {
    return NextResponse.json({ ok: false, error: "That organization is not in your Zoho Books account. Choose one from the list." }, { status: 400 });
  }
  try { await saveOrganization(g.caller.admin, g.caller.tenantId, org); }
  catch { return NextResponse.json({ ok: false, error: "Could not save the organization. Try again." }, { status: 500 }); }
  return NextResponse.json({ ok: true, org_name: org.name });
}
