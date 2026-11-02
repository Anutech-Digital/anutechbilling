import { NextResponse, type NextRequest } from "next/server";
import { LinkedInApiError, publishLinkedInPost } from "@/lib/integrations/linkedin/api";
import { readLinkedInConnection, resolveLinkedInCaller, saveLinkedInOrganization } from "@/lib/integrations/linkedin/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const caller = await resolveLinkedInCaller();
  if (!caller) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!caller.canManage) return NextResponse.json({ error: "Only an owner or manager can publish on LinkedIn." }, { status: 403 });
  const body = await request.json().catch(() => null) as { text?: unknown; organizationUrn?: unknown; organizationName?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const urn = typeof body?.organizationUrn === "string" ? body.organizationUrn.trim() : "";
  const name = typeof body?.organizationName === "string" ? body.organizationName.trim().slice(0, 160) : "";
  if (!text || text.length > 3000) return NextResponse.json({ error: "Write a post up to 3,000 characters." }, { status: 400 });
  if (!/^urn:li:organization:\d+$/.test(urn)) return NextResponse.json({ error: "Enter a valid Company Page URN, for example urn:li:organization:12345." }, { status: 400 });
  try {
    const connection = await readLinkedInConnection(caller.admin, caller.tenantId);
    if (!connection.token || (connection.expiresAt && Date.parse(connection.expiresAt) <= Date.now())) return NextResponse.json({ error: "LinkedIn access has expired. Connect LinkedIn again." }, { status: 409 });
    await saveLinkedInOrganization(caller.admin, caller.tenantId, urn, name || null);
    const id = await publishLinkedInPost(connection.token, urn, text);
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    const message = error instanceof LinkedInApiError ? error.message : "Could not publish to LinkedIn. Try again.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
