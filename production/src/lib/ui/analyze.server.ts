/**
 * UI agent — the analysis (3 Oct 2026). Runs with the UX analysis (lib/ux/analyze.server.ts).
 *
 * The last 7 days of `ui_probe` measurements → the median per page → a 0–100 score with
 * its rule-backed issues (lib/ui/score.ts) → ui_page_scores (with the previous score, so
 * progress shows) → Gemini, as a world-class product designer, turns each issue into a
 * specific design fix → ux_insights rows with agent 'ui'. A Done design insight is
 * reopened only if its issue is measured again AFTER it was marked done.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { errorMessage, fetchAllRows } from "@/lib/ops/fetch-all";
import { resolveGeminiConfig, geminiJson } from "@/lib/ai/gemini";
import { medianMetrics, scorePage, uiPrompt, sanitizeUiInsights, basicUiInsight, sanitizeMetrics, type UiMetrics, type UiPage, type UiInsight } from "@/lib/ui/score";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any>;
type Row = { surface: "app" | "site"; path: string; metrics: unknown; created_at: string };

function pagesFrom(rows: readonly Row[], production: boolean): UiPage[] {
  const by = new Map<string, { surface: "app" | "site"; path: string; list: UiMetrics[] }>();
  for (const r of rows) {
    const m = sanitizeMetrics(r.metrics);
    if (!m) continue;
    const k = `${r.surface}|${r.path}`;
    if (!by.has(k)) by.set(k, { surface: r.surface, path: r.path, list: [] });
    by.get(k)!.list.push(m);
  }
  return [...by.values()].map((g) => {
    const med = medianMetrics(g.list)!;
    return { surface: g.surface, path: g.path, samples: g.list.length, ...scorePage(med, { production }) };
  });
}

export async function runUiAnalysis(admin: Admin, tenantId: string, withSite: boolean): Promise<{ pages: number; insights: number }> {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  /* R-1588: paged up to the old 5000 — `.limit(5000)` came back as 1000 rows (the gateway
     caps every answer). Oldest-first on `id`, as the unordered read effectively was. */
  const data = await fetchAllRows((from, to) => {
    let q = admin.from("ux_events").select("surface, path, metrics, created_at").eq("kind", "ui_probe").gte("created_at", since);
    q = withSite ? q.or(`tenant_id.eq.${tenantId},tenant_id.is.null`) : q.eq("tenant_id", tenantId);
    return q.order("id", { ascending: true }).range(from, to);
  }, { maxRows: 5000 }).catch((e: unknown) => { throw new Error(errorMessage(e)); });
  const rows = data as Row[];
  const production = process.env.NODE_ENV === "production";
  const pages = pagesFrom(rows, production);
  if (pages.length === 0) return { pages: 0, insights: 0 };

  // scores, keeping the previous one for the trend
  for (const p of pages) {
    const { data: old } = await admin.from("ui_page_scores").select("id, score").eq("tenant_id", tenantId).eq("surface", p.surface).eq("path", p.path).maybeSingle();
    const row = { tenant_id: tenantId, surface: p.surface, path: p.path, score: p.score, samples: p.samples, issues: p.issues, updated_at: new Date().toISOString() };
    if (old) await admin.from("ui_page_scores").update({ ...row, prev_score: (old as { score: number }).score }).eq("id", (old as { id: string }).id);
    else await admin.from("ui_page_scores").insert(row);
  }

  const withIssues = pages.filter((p) => p.issues.length > 0).sort((a, b) => a.score - b.score).slice(0, 15);
  let insights: UiInsight[] = [];
  if (withIssues.length > 0) {
    const gemini = await resolveGeminiConfig(admin as never, tenantId);
    if (gemini.apiKey) {
      const raw = await geminiJson<unknown>({
        apiKey: gemini.apiKey, model: gemini.model, tenantId: gemini.tenantId, system: uiPrompt(),
        user: JSON.stringify({ pages: withIssues.map((p) => ({ surface: p.surface, path: p.path, score: p.score, samples: p.samples, issues: p.issues.map(({ code, rule, evidence }) => ({ code, rule, evidence })) })) }),
        temperature: 0.3, timeoutMs: 45_000, label: "ui-analysis",
      });
      if (raw) insights = sanitizeUiInsights(raw, withIssues);
    }
    const covered = new Set(insights.map((i) => `${i.surface}|${i.path}|${i.signal}`));
    for (const p of withIssues) for (const iss of p.issues) {
      if (!covered.has(`${p.surface}|${p.path}|ui:${iss.code}`)) insights.push(basicUiInsight(p, iss));
    }
  }

  for (const i of insights) {
    const signature = `ui|${i.surface}|${i.path}|${i.signal}`.slice(0, 400);
    const row = { tenant_id: tenantId, agent: "ui", surface: i.surface, path: i.path, severity: i.severity, category: i.category, problem: i.problem, evidence: i.evidence, fix: i.fix, signature, sessions: i.sessions, updated_at: new Date().toISOString() };
    const { data: existing } = await admin.from("ux_insights").select("id, status, done_at").eq("tenant_id", tenantId).eq("signature", signature).maybeSingle();
    const ex = existing as { id: string; status: string; done_at: string | null } | null;
    if (!ex) { await admin.from("ux_insights").insert({ ...row, status: "new" }); continue; }
    if (ex.status === "done" && ex.done_at) {
      const after = pagesFrom(rows.filter((r) => r.created_at > ex.done_at!), production);
      const back = after.find((p) => p.surface === i.surface && p.path === i.path)?.issues.find((x) => `ui:${x.code}` === i.signal);
      if (back) await admin.from("ux_insights").update({ ...row, status: "new", done_at: null, evidence: `Came back after it was marked done: ${back.evidence}`.slice(0, 400) }).eq("id", ex.id);
      continue;
    }
    await admin.from("ux_insights").update(row).eq("id", ex.id);
  }
  return { pages: pages.length, insights: insights.length };
}
