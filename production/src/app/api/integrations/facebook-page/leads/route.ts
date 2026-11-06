/**
 * R-2521: POST /api/integrations/facebook-page/leads — "Fetch leads now" on the Facebook Page screen.
 * Reads the lead forms of the connected Page and adds new leads to Sales → Leads (source Facebook).
 * Owner / manager only. The meta-leads-pull cron does the same every 30 minutes.
 */
import { NextResponse, type NextRequest } from "next/server";
import { facebookPageCaller, readFacebookPage } from "@/lib/integrations/facebook-page";
import { pullPageLeads } from "@/lib/meta-leads/page-pull";
import { importPulledLeads } from "@/lib/meta-leads/leadgen.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const GRAPH_VERSION = process.env.META_GRAPH_VERSION?.trim() || "v21.0";

export async function POST(request: NextRequest) {
  const caller = await facebookPageCaller();
  if (!caller) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!caller.canManage) return NextResponse.json({ error: "Only an owner or manager can fetch Facebook leads.", description: "Ask the owner to press Fetch leads now." }, { status: 403 });
  const body = await request.json().catch(() => null) as { days?: unknown } | null;
  const days = typeof body?.days === "number" && Number.isInteger(body.days) && body.days >= 1 && body.days <= 90 ? body.days : 30;
  try {
    const connection = await readFacebookPage(caller.admin, caller.tenantId);
    if (!connection.pageId || !connection.pageToken) {
      return NextResponse.json({ error: "No Facebook Page is connected.", description: "Connect your Page on this screen first." }, { status: 409 });
    }
    const pulled = await pullPageLeads({ pageId: connection.pageId, pageToken: connection.pageToken, since: new Date(Date.now() - days * 86_400_000), graphVersion: GRAPH_VERSION });
    if (pulled.error && pulled.leads.length === 0) {
      return NextResponse.json({ error: pulled.error, needsReconnect: pulled.needsReconnect }, { status: pulled.needsReconnect ? 403 : 502 });
    }
    const saved = await importPulledLeads({ admin: caller.admin, tenantId: caller.tenantId, pageId: connection.pageId, leads: pulled.leads, graphVersion: GRAPH_VERSION });
    return NextResponse.json({ ok: true, days, forms: pulled.forms, found: pulled.leads.length, ...saved, warning: pulled.error });
  } catch (error) {
    console.error("[facebook-page/leads] fetch failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Could not fetch Facebook leads. Try again." }, { status: 502 });
  }
}
