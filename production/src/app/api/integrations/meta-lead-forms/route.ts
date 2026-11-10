/**
 * R-2522: GET  → the lead forms on every Page the Meta Ads login manages + which ones are chosen.
 *         PUT  → save the chosen forms (owner / manager). Only forms that the login really sees are
 *                accepted, so a form id from somewhere else cannot be saved.
 * Pulling them: POST /api/integrations/facebook-page/leads and the meta-leads-pull cron.
 */
import { NextResponse, type NextRequest } from "next/server";
import { facebookPageCaller } from "@/lib/integrations/facebook-page";
import { listLeadForms, metaAdsUserToken, readChosenForms, untyped } from "@/lib/meta-leads/lead-forms.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const caller = await facebookPageCaller();
  if (!caller) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  try {
    const chosen = await readChosenForms(caller.admin, caller.tenantId);
    const token = await metaAdsUserToken(caller.admin, caller.tenantId);
    if (!token) return NextResponse.json({ canManage: caller.canManage, adsConnected: false, pages: [], chosen });
    const pages = await listLeadForms(token);
    return NextResponse.json({ canManage: caller.canManage, adsConnected: true, pages, chosen });
  } catch (error) {
    console.error("[meta-lead-forms] list failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load your lead forms.", description: "Try again. If it repeats, reconnect Meta Ads in Paid ads." }, { status: 502 });
  }
}

export async function PUT(request: NextRequest) {
  const caller = await facebookPageCaller();
  if (!caller) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!caller.canManage) return NextResponse.json({ error: "Only an owner or manager can choose lead forms." }, { status: 403 });
  const body = await request.json().catch(() => null) as { formIds?: unknown } | null;
  const ids = Array.isArray(body?.formIds) ? [...new Set(body.formIds.filter((x): x is string => typeof x === "string" && /^\d{1,30}$/.test(x)))] : null;
  if (!ids || ids.length > 50) return NextResponse.json({ error: "Choose up to 50 lead forms." }, { status: 400 });
  try {
    const token = await metaAdsUserToken(caller.admin, caller.tenantId);
    if (!token) return NextResponse.json({ error: "Meta Ads is not connected.", description: "Connect Meta Ads in Paid ads first." }, { status: 409 });
    const live = new Map((await listLeadForms(token)).flatMap((p) => p.forms.map((f) => [f.id, { page: p, form: f }] as const)));
    const unknown = ids.filter((id) => !live.has(id));
    if (unknown.length) return NextResponse.json({ error: "Some forms are not on your Pages any more.", description: "Refresh the list and choose again." }, { status: 400 });
    const db = untyped(caller.admin);
    const { error: delError } = await db.from("meta_lead_forms").delete().eq("tenant_id", caller.tenantId).not("form_id", "in", `(${ids.length ? ids.join(",") : "0"})`);
    if (delError) throw new Error(delError.message);
    if (ids.length) {
      const rows = ids.map((id) => { const { page, form } = live.get(id)!; return { tenant_id: caller.tenantId, form_id: id, page_id: page.id, page_name: page.name.slice(0, 300), form_name: form.name.slice(0, 300), enabled: true, created_by: caller.userId }; });
      const { error } = await db.from("meta_lead_forms").upsert(rows, { onConflict: "tenant_id,form_id", ignoreDuplicates: false });
      if (error) throw new Error(error.message);
    }
    return NextResponse.json({ ok: true, chosen: await readChosenForms(caller.admin, caller.tenantId) });
  } catch (error) {
    console.error("[meta-lead-forms] save failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Could not save the lead forms.", description: "Nothing changed. Try again." }, { status: 502 });
  }
}
