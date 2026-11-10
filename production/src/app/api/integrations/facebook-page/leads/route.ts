/**
 * R-2521 / R-2522: POST /api/integrations/facebook-page/leads — "Fetch leads now" on the Facebook
 * Page screen. Brings the leads of the CHOSEN lead forms (any Page the Meta Ads login manages) into
 * Sales → Leads (source Facebook). Owner / manager only. The meta-leads-pull cron does the same
 * every 30 minutes. Forms are chosen through /api/integrations/meta-lead-forms.
 */
import { NextResponse, type NextRequest } from "next/server";
import { facebookPageCaller } from "@/lib/integrations/facebook-page";
import { pullChosenForms, readChosenForms } from "@/lib/meta-leads/lead-forms.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const caller = await facebookPageCaller();
  if (!caller) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!caller.canManage) return NextResponse.json({ error: "Only an owner or manager can fetch Facebook leads.", description: "Ask the owner to press Fetch leads now." }, { status: 403 });
  const body = await request.json().catch(() => null) as { days?: unknown } | null;
  const days = typeof body?.days === "number" && Number.isInteger(body.days) && body.days >= 1 && body.days <= 90 ? body.days : 30;
  try {
    if ((await readChosenForms(caller.admin, caller.tenantId)).filter((f) => f.enabled).length === 0) {
      return NextResponse.json({ error: "No lead form is chosen yet.", description: "Press Choose forms and tick the forms whose leads you want." }, { status: 409 });
    }
    const sum = await pullChosenForms(caller.admin, caller.tenantId, new Date(Date.now() - days * 86_400_000));
    return NextResponse.json({ ok: true, days, ...sum });
  } catch (error) {
    console.error("[facebook-page/leads] fetch failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not fetch Facebook leads.", description: "Try again in a few minutes." }, { status: 502 });
  }
}
