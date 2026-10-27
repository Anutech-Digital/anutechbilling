/**
 * UX observer — the analysis (3 Oct 2026). Server only; uses the admin client.
 *
 * Reads the last 7 days of a tenant's events (plus the public website's when this tenant
 * owns the website — the buy page tenant), turns them into numbers (lib/ux/signals.ts),
 * keeps only the findings over threshold, asks Gemini to explain each and propose the fix,
 * and upserts one insight per finding. A finding the owner already marked done/dismissed
 * keeps its status — only its evidence is refreshed.
 *
 * Runs only after activity: maybeAutoAnalyze() is called from the events route, and runs
 * when there are enough new events since the last run and the last run is over an hour old.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { errorMessage, fetchAllRows } from "@/lib/ops/fetch-all";
import { resolveGeminiConfig, geminiJson } from "@/lib/ai/gemini";
import { buyPageTenantIdOrEmpty } from "@/lib/checkout/live-guards";
import { runUiAnalysis } from "@/lib/ui/analyze.server";
import { aggregate, findings, uxPrompt, sanitizeInsights, basicInsight, signatureOf, type RowIn } from "@/lib/ux/signals";

/* The ux_* tables are not in the generated types yet; reads/writes go through this. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any>;

export const AUTO_MIN_EVENTS = 30;
export const AUTO_MIN_GAP_MS = 60 * 60_000;

export function ownsWebsite(tenantId: string | null): boolean {
  const site = buyPageTenantIdOrEmpty();
  return !!tenantId && !!site && site === tenantId;
}

export async function runUxAnalysis(admin: Admin, tenantId: string, mode: "auto" | "manual"): Promise<{ events: number; insights: number; mode: string; uiPages: number }> {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const withSite = ownsWebsite(tenantId);
  /* R-1588: paged up to the old 20000 — `.limit(20000)` came back as 1000 rows (the gateway
     caps every answer), so a busy week was judged on its first 1000 events. */
  const rows = await fetchAllRows((from, to) => {
    let q = admin.from("ux_events").select("kind, path, target, detail, ms, session_id, surface, created_at").gte("created_at", since).neq("kind", "ui_probe");
    q = withSite ? q.or(`tenant_id.eq.${tenantId},tenant_id.is.null`) : q.eq("tenant_id", tenantId);
    return q.order("id", { ascending: true }).range(from, to);
  }, { maxRows: 20000 }).catch((e: unknown) => { throw new Error(errorMessage(e)); });

  const f = findings(aggregate((rows ?? []) as RowIn[]));
  let insights = f.length === 0 ? [] : null as ReturnType<typeof sanitizeInsights> | null;
  let used = "basic";

  if (f.length > 0) {
    const gemini = await resolveGeminiConfig(admin as never, tenantId);
    if (gemini.apiKey) {
      const raw = await geminiJson<unknown>({
        apiKey: gemini.apiKey, model: gemini.model, tenantId: gemini.tenantId, system: uxPrompt(),
        user: JSON.stringify({ findings: f.map(({ surface, path, signal, severity, evidence, sessions }) => ({ surface, path, signal, severity, evidence, sessions })) }),
        temperature: 0.2, timeoutMs: 40_000, label: "ux-analysis",
      });
      if (raw) { insights = sanitizeInsights(raw, f); used = "gemini"; }
    }
    /* Every finding gets an insight: the AI's where it wrote one, the plain one otherwise. */
    const covered = new Set((insights ?? []).map((i) => signatureOf(i)));
    insights = [...(insights ?? []), ...f.filter((x) => !covered.has(signatureOf(x))).map(basicInsight)];
  }

  const all = (rows ?? []) as Array<RowIn & { created_at: string }>;
  for (const i of insights ?? []) {
    const signature = signatureOf(i);
    const row = { tenant_id: tenantId, surface: i.surface, path: i.path, severity: i.severity, category: i.category, problem: i.problem, evidence: i.evidence, fix: i.fix, signature, sessions: i.sessions, updated_at: new Date().toISOString() };
    const { data: existing } = await admin.from("ux_insights").select("id, status, done_at").eq("tenant_id", tenantId).eq("signature", signature).maybeSingle();
    const ex = existing as { id: string; status: string; done_at: string | null } | null;
    if (!ex) { await admin.from("ux_insights").insert({ ...row, status: "new" }); continue; }
    /* Marked done, but did it STAY fixed? Only signals after done_at count — the 7-day window
       still holds the ones from before the fix. Came back → reopened, and it says so. */
    if (ex.status === "done" && ex.done_at) {
      const after = findings(aggregate(all.filter((r) => r.created_at > ex.done_at!)));
      const back = after.find((x) => signatureOf(x) === signature);
      if (back) {
        await admin.from("ux_insights").update({ ...row, status: "new", done_at: null, evidence: `Came back after it was marked done: ${back.evidence}`.slice(0, 400) }).eq("id", ex.id);
        continue;
      }
      await admin.from("ux_insights").update({ updated_at: row.updated_at }).eq("id", ex.id); // still fixed — keep the record as it was
      continue;
    }
    await admin.from("ux_insights").update(row).eq("id", ex.id);
  }

  /* The UI agent runs alongside: same activity trigger, same Analyze now. A UI failure
     must not lose the UX run, so it is caught and logged. */
  let ui = { pages: 0, insights: 0 };
  try { ui = await runUiAnalysis(admin, tenantId, withSite); } catch (e) { console.error("[ui-analysis]", (e as Error).message); }

  await admin.from("ux_analysis_runs").insert({ tenant_id: tenantId, events_seen: rows?.length ?? 0, insights: (insights?.length ?? 0) + ui.insights, mode: `${mode}:${used}` });
  return { events: rows?.length ?? 0, insights: (insights?.length ?? 0) + ui.insights, mode: used, uiPages: ui.pages };
}

/** After a batch arrives: analyse only if there has been real activity since the last run. */
export async function maybeAutoAnalyze(admin: Admin, tenantId: string | null): Promise<void> {
  const scope = tenantId ?? (buyPageTenantIdOrEmpty() || null);
  if (!scope) return;
  const { data: last } = await admin.from("ux_analysis_runs").select("ran_at").eq("tenant_id", scope).order("ran_at", { ascending: false }).limit(1).maybeSingle();
  const lastAt = last ? new Date((last as { ran_at: string }).ran_at).getTime() : 0;
  if (Date.now() - lastAt < AUTO_MIN_GAP_MS) return;
  let q = admin.from("ux_events").select("id", { count: "exact", head: true }).gt("created_at", new Date(lastAt || Date.now() - 7 * 86400_000).toISOString()).neq("kind", "view");
  q = ownsWebsite(scope) ? q.or(`tenant_id.eq.${scope},tenant_id.is.null`) : q.eq("tenant_id", scope);
  const { count } = await q;
  if ((count ?? 0) < AUTO_MIN_EVENTS) return;
  await runUxAnalysis(admin, scope, "auto");
}
