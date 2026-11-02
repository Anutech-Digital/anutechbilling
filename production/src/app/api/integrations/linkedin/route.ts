/** LinkedIn Company Page connection status. Tokens never leave this route's server helpers. */
import { NextResponse } from "next/server";
import { linkedInCreds } from "@/lib/integrations/linkedin/config";
import { clearLinkedInConnection, readLinkedInConnection, resolveLinkedInCaller } from "@/lib/integrations/linkedin/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const caller = await resolveLinkedInCaller();
  if (!caller) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  try {
    const c = await readLinkedInConnection(caller.admin, caller.tenantId);
    const expired = Boolean(c.expiresAt && Date.parse(c.expiresAt) <= Date.now());
    return NextResponse.json({
      configured: Boolean(linkedInCreds()), connected: Boolean(c.token) && !expired, expired,
      organizationUrn: c.organizationUrn, organizationName: c.organizationName, canManage: caller.canManage,
      message: !linkedInCreds() ? "LinkedIn app keys are not set on this server." : undefined,
    });
  } catch { return NextResponse.json({ error: "Could not read the LinkedIn connection." }, { status: 500 }); }
}

export async function DELETE() {
  const caller = await resolveLinkedInCaller();
  if (!caller) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!caller.canManage) return NextResponse.json({ error: "Only an owner or manager can disconnect LinkedIn." }, { status: 403 });
  try { await clearLinkedInConnection(caller.admin, caller.tenantId); }
  catch { return NextResponse.json({ error: "Could not disconnect LinkedIn." }, { status: 500 }); }
  return NextResponse.json({ ok: true });
}
