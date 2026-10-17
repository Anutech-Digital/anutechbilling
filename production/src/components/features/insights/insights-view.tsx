/**
 * The insights screen for both AI agents (3 Oct 2026):
 *  - UX agent (/ux-insights): where people get stuck — lib/ux/signals.ts
 *  - UI agent (/ui-insights): how each page is designed, with a 0–100 score — lib/ui/score.ts
 * Same card flow for both: Make card → board → AI fix → owner checks → reopened if it returns.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { TabBar } from "@/components/ui/tabs";
import { cn, formatDate } from "@/lib/utils";

interface Insight {
  id: string; surface: "app" | "site"; path: string; severity: "high" | "medium" | "low";
  category: string; problem: string; evidence: string; fix: string; status: "new" | "queued" | "carded" | "done" | "dismissed";
  card_ref: string | null;
  sessions: number; updated_at: string;
}
interface PageScore { surface: "app" | "site"; path: string; score: number; prev_score: number | null; samples: number; issues: Array<{ code: string; rule: string; evidence: string; deduct: number }>; updated_at: string }
interface Payload { insights: Insight[]; lastRun: { ran_at: string; events_seen: number; insights: number; mode: string } | null; events7d: number; includesWebsite: boolean; scores: PageScore[] }

export type Agent = "ux" | "ui";
const COPY: Record<Agent, { title: string; blurb: (site: boolean) => string; empty: string }> = {
  ux: {
    title: "UX Insights",
    blurb: (site) => `While people use the app${site ? " and the website" : ""}, the observer notes where they get stuck — repeated clicks, clicks that do nothing, errors, forms left half-way, slow pages. AI turns that into what to fix. Nothing anyone types is recorded.`,
    empty: "Insights appear once people have used the app for a while. Press Analyze now after some activity.",
  },
  ui: {
    title: "UI Insights",
    blurb: (site) => `Every page of the app${site ? " and the website" : ""} is measured as people use it — contrast, text size, tap targets on phones, layout, how many buttons compete, fonts, speed — and scored out of 100 against WCAG 2.2, usability heuristics and Core Web Vitals. AI writes the design fix the way the best products do it.`,
    empty: "Scores appear once pages have been visited. Press Analyze now after some activity.",
  },
};

const SEV_KIND = { high: "danger", medium: "warning", low: "muted" } as const;
const CAT_LABEL: Record<string, string> = { confusing: "Confusing", broken: "Broken", slow: "Slow", copy: "Wording", logic: "Logic", flow: "Flow", visual: "Visual", accessibility: "Accessibility", layout: "Layout", consistency: "Consistency", mobile: "Mobile", performance: "Speed" };
const scoreTone = (n: number) => (n >= 85 ? "text-emerald" : n >= 65 ? "text-amber-ink" : "text-rose");

export function InsightsView({ agent }: { agent: Agent }) {
  const copy = COPY[agent];
  const [data, setData] = React.useState<Payload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const [tab, setTab] = React.useState("new");

  const load = React.useCallback(async () => {
    const r = await fetch(`/api/ux/insights?agent=${agent}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setError(j.error ?? "Could not load insights."); return; }
    setData(j); setError(null);
  }, [agent]);
  React.useEffect(() => { void load(); }, [load]);

  const analyze = async () => {
    setRunning(true);
    try {
      const r = await fetch("/api/ux/insights", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Analysis did not run", { description: j.error ?? "Try again in a minute." }); return; }
      toast.success(j.insights ? `${j.insights} insight${j.insights === 1 ? "" : "s"} from ${j.events} signals` : `Nothing over the threshold in ${j.events} signals`);
      await load();
    } finally { setRunning(false); }
  };

  const setStatus = async (id: string, status: Insight["status"]) => {
    setData((d) => d && { ...d, insights: d.insights.map((i) => (i.id === id ? { ...i, status } : i)) });
    const r = await fetch("/api/ux/insights", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status }) });
    if (!r.ok) { toast.error("Not updated", { description: "Refresh and try again." }); void load(); }
  };

  const inTab = (i: Insight) => (tab === "card" ? i.status === "queued" || i.status === "carded" : i.status === tab);
  const list = (data?.insights ?? []).filter(inTab)
    .sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - ({ high: 0, medium: 1, low: 2 })[b.severity] || b.sessions - a.sessions);
  const count = (s: string) => (data?.insights ?? []).filter((i) => (s === "card" ? i.status === "queued" || i.status === "carded" : i.status === s)).length;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto space-y-5">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">AI</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">{copy.title}</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-2xl">{copy.blurb(!!data?.includesWebsite)}</p>
        </div>
        <Button variant="primary" icon="sparkles" onClick={analyze} loading={running}>Analyze now</Button>
      </div>

      {data && (
        <p className="text-xs text-ink-3">
          {data.events7d.toLocaleString("en-IN")} signals in the last 7 days
          {data.lastRun ? ` · last analysed ${formatDate(data.lastRun.ran_at, "short")} (${data.lastRun.mode.replace(":", " · ")})` : " · not analysed yet"}
          {" · runs by itself when there is new activity"}
        </p>
      )}

      {agent === "ui" && data && data.scores.length > 0 && (
        <div className="rounded-lg border border-hairline bg-paper overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-paper-2 text-xs text-ink-3 uppercase tracking-wider">
              <tr><th className="text-left p-3">Page</th><th className="text-right p-3">Score</th><th className="text-left p-3">Biggest issue</th><th className="text-right p-3">Visits</th></tr>
            </thead>
            <tbody>
              {data.scores.map((p) => (
                <tr key={p.surface + p.path} className="border-t border-hairline">
                  <td className="p-3 font-mono text-xs">{p.surface === "site" ? "Website" : "App"} · {p.path}</td>
                  <td className={cn("p-3 text-right font-serif text-lg tabular-nums", scoreTone(p.score))}>
                    {p.score}
                    {p.prev_score != null && p.prev_score !== p.score && (
                      <span className={cn("ml-1 text-2xs font-sans", p.score > p.prev_score ? "text-emerald" : "text-rose")}>{p.score > p.prev_score ? "▲" : "▼"}{Math.abs(p.score - p.prev_score)}</span>
                    )}
                  </td>
                  <td className="p-3 text-xs text-ink-2">{p.issues[0] ? `${p.issues[0].evidence}` : "No issues measured"}</td>
                  <td className="p-3 text-right text-xs text-ink-3 tabular-nums">{p.samples}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <TabBar value={tab} onChange={setTab} items={[
        { id: "new", label: "To fix", count: count("new") },
        { id: "card", label: "On the board", count: count("card") },
        { id: "done", label: "Done", count: count("done") },
        { id: "dismissed", label: "Dismissed", count: count("dismissed") },
      ]} />

      {error ? (
        <EmptyState icon="lock" title="Can't show insights" body={error} />
      ) : !data ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : list.length === 0 ? (
        <EmptyState
          icon="sparkles"
          title={tab === "new" ? "Nothing to fix yet" : "Nothing here"}
          body={tab === "new" ? copy.empty : tab === "card" ? "Press Make card on an insight to send it to the team board." : undefined}
        />
      ) : (
        <ul className="space-y-3">
          {list.map((i) => (
            <li key={i.id} className={cn("rounded-lg border bg-paper p-4", i.severity === "high" ? "border-rose/40" : "border-hairline")}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge kind={SEV_KIND[i.severity]}>{i.severity}</Badge>
                  <Badge kind="outline">{CAT_LABEL[i.category] ?? i.category}</Badge>
                  <span className="font-mono text-xs text-ink-2">{i.surface === "site" ? "Website" : "App"} · {i.path}</span>
                </div>
                <span className="text-2xs text-ink-3">{i.sessions} session{i.sessions === 1 ? "" : "s"} · {formatDate(i.updated_at, "short")}</span>
              </div>
              <p className="mt-2 text-sm text-ink"><b>Problem:</b> {i.problem}</p>
              <p className="mt-1 text-xs text-ink-3"><b>Seen:</b> {i.evidence}</p>
              <p className="mt-2 text-sm text-emerald"><b>Fix:</b> {i.fix}</p>
              {/* Path to a fix (Pardeep, 3 Oct): Make card → board → AI fixes → he checks → the
                  observer reopens it if the signal comes back after Done. */}
              {i.status === "queued" && <p className="mt-2 text-2xs text-amber-ink">Waiting for the board — the card is made on the next board sync.</p>}
              {i.status === "carded" && <p className="mt-2 text-2xs text-indigo-ink">On the board as <b>{i.card_ref}</b> — mark Done once the fix is checked and live.</p>}
              <div className="mt-3 flex gap-2 flex-wrap">
                {i.status === "new" && <Button size="sm" variant="primary" icon="plus" onClick={() => setStatus(i.id, "queued")}>Make card</Button>}
                {i.status !== "done" && <Button size="sm" variant="default" icon="check" onClick={() => setStatus(i.id, "done")}>Done</Button>}
                {i.status !== "dismissed" && <Button size="sm" variant="ghost" onClick={() => setStatus(i.id, "dismissed")}>Dismiss</Button>}
                {i.status !== "new" && i.status !== "carded" && <Button size="sm" variant="ghost" onClick={() => setStatus(i.id, "new")}>Move back</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
