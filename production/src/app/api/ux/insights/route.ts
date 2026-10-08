/**
 * /api/ux/insights — the UX observer's findings for the signed-in owner / manager (3 Oct 2026).
 *   GET                → insights (+ last run, events in the last 7 days)
 *   POST {analyze:true} → run the analysis now
 *   PATCH {id, status} → mark done / dismissed / new
 * The ux_* tables are service-role only; this route is the access check.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { runUxAnalysis, ownsWebsite } from "@/lib/ux/analyze.server";
import { rateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function me() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  const { data: u } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!u?.tenant_id || (u.role !== "owner" && u.role !== "manager")) {
    return { error: NextResponse.json({ error: "Only an owner or manager can see UX insights." }, { status: 403 }) };
  }
  // R-051: service-role writes carry the verified caller, so the audit log names them.
  return { userId: user.id, tenantId: u.tenant_id as string, admin: createAdminClientFor(user.id) };
}

export async function GET(req: NextRequest) {
  const m = await me(); if ("error" in m) return m.error;
  const agent = new URL(req.url).searchParams.get("agent") === "ui" ? "ui" : "ux";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = m.admin as any;
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const site = ownsWebsite(m.tenantId);
  let ev = admin.from("ux_events").select("id", { count: "exact", head: true }).gte("created_at", since);
  ev = site ? ev.or(`tenant_id.eq.${m.tenantId},tenant_id.is.null`) : ev.eq("tenant_id", m.tenantId);
  const [{ data: insights }, { data: last }, { count }] = await Promise.all([
    admin.from("ux_insights").select("*").eq("tenant_id", m.tenantId).eq("agent", agent).order("updated_at", { ascending: false }).limit(200),
    admin.from("ux_analysis_runs").select("ran_at, events_seen, insights, mode").eq("tenant_id", m.tenantId).order("ran_at", { ascending: false }).limit(1).maybeSingle(),
    ev,
  ]);
  const { data: scores } = agent === "ui"
    ? await admin.from("ui_page_scores").select("surface, path, score, prev_score, samples, issues, updated_at").eq("tenant_id", m.tenantId).order("score", { ascending: true }).limit(200)
    : { data: null };
  return NextResponse.json({ insights: insights ?? [], lastRun: last ?? null, events7d: count ?? 0, includesWebsite: site, scores: scores ?? [] });
}

export async function POST() {
  const m = await me(); if ("error" in m) return m.error;
  const rl = rateLimit(`ux-analyze:${m.tenantId}`, { limit: 6, windowMs: 10 * 60_000 });
  if (!rl.ok) return NextResponse.json({ error: `Just ran — try again in ${rl.retryAfterSec}s.` }, { status: 429 });
  try {
    const r = await runUxAnalysis(m.admin as never, m.tenantId, "manual");
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const m = await me(); if ("error" in m) return m.error;
  const b = await req.json().catch(() => ({})) as { id?: string; status?: string };
  /* queued = "Make card" (the board sync turns it into a card and sets carded + card_ref). */
  if (!b.id || !["new", "queued", "done", "dismissed"].includes(b.status ?? "")) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = m.admin as any;
  const { error } = await admin.from("ux_insights").update({ status: b.status, updated_at: new Date().toISOString(), done_at: b.status === "done" ? new Date().toISOString() : null }).eq("id", b.id).eq("tenant_id", m.tenantId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
