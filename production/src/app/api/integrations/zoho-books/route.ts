/**
 * /api/integrations/zoho-books — R-1749.
 *
 *   GET    → { configured, connected, needs_org, org_name, can_manage, message? } for the
 *            caller's OWN tenant. Never the token, never the client id/secret.
 *   DELETE → disconnect: revoke the refresh token at Zoho, then delete the stored copy.
 *            Owner / manager / accountant.
 */
import { NextResponse } from "next/server";
import { NOT_CONFIGURED_MESSAGE, ROLE_MESSAGE, ZOHO_BOOKS_MANAGE_ROLES, zohoBooksCreds } from "@/lib/integrations/zoho-books/config";
import { clearConnection, readConnection, resolveZohoCaller } from "@/lib/integrations/zoho-books/store";
import { revokeToken } from "@/lib/integrations/zoho-books/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const caller = await resolveZohoCaller();
  if (!caller) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
  const configured = Boolean(zohoBooksCreds());
  let conn;
  try { conn = await readConnection(caller.admin, caller.tenantId); }
  catch { return NextResponse.json({ ok: false, error: "Could not read the Zoho Books connection. Refresh the page." }, { status: 500 }); }
  const connected = Boolean(conn.refreshToken);
  return NextResponse.json({
    ok: true,
    configured,
    connected,
    needs_org: connected && !conn.orgId,
    org_name: connected ? conn.orgName : null,
    can_manage: caller.canManage,
    ...(configured ? {} : { message: NOT_CONFIGURED_MESSAGE }),
  });
}

export async function DELETE() {
  const caller = await resolveZohoCaller();
  if (!caller) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
  if (!(ZOHO_BOOKS_MANAGE_ROLES as readonly string[]).includes(caller.role)) return NextResponse.json({ ok: false, error: ROLE_MESSAGE }, { status: 403 });
  let revoked = false;
  try {
    const conn = await readConnection(caller.admin, caller.tenantId);
    if (conn.refreshToken) revoked = await revokeToken(conn.refreshToken);
    await clearConnection(caller.admin, caller.tenantId);
  } catch {
    return NextResponse.json({ ok: false, error: "Could not disconnect Zoho Books. Refresh the page and try again." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, revoked });
}
