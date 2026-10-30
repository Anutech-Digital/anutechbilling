/**
 * R-2165 (G-ADS-AI, AI-09) — "Ask Neo": the marketing numbers chat, as a side panel on the
 * Marketing Hub (/marketing).
 *
 * The person types a question; POST /api/marketing/neo/ask turns it into a typed plan, reads
 * public.marketing_metrics_query (allowlisted, read-only) and returns a summary, chart JSON and
 * a table. This panel only draws what came back — it computes no number of its own.
 * Shown to the owner and the marketing team only (the route and the database check again).
 */
"use client";

import * as React from "react";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { formatMetric, type NeoChart, type NeoTable } from "@/lib/marketing/neo/answer";
import type { NeoReply } from "@/lib/marketing/neo/graph";
import { METRIC_LABEL, NEO_ROLES, type NeoMetric } from "@/lib/marketing/neo/plan";

/** Same three as NEO_EXAMPLES in graph.ts (that module is server-side LangGraph). */
const EXAMPLES = ["Last 7 days ROAS", "Top ads this month", "Spend by platform last 30 days"];

type Turn =
  | { id: number; question: string; state: "asking" }
  | { id: number; question: string; state: "done"; reply: NeoReply }
  | { id: number; question: string; state: "failed"; error: string };

export function mayAskNeo(role: string | null | undefined): boolean {
  return !!role && NEO_ROLES.includes(role);
}

async function askNeo(question: string): Promise<NeoReply> {
  const res = await fetch("/api/marketing/neo/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : "Neo could not answer just now. Try again.");
  return body.reply as NeoReply;
}

export function NeoPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [text, setText] = React.useState("");
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const nextId = React.useRef(1);
  const endRef = React.useRef<HTMLDivElement>(null);
  const busy = turns.some((t) => t.state === "asking");

  const ask = React.useCallback(async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    const id = nextId.current++;
    setText("");
    setTurns((ts) => [...ts, { id, question: q, state: "asking" }]);
    try {
      const reply = await askNeo(q);
      setTurns((ts) => ts.map((t) => (t.id === id ? { id, question: q, state: "done", reply } : t)));
    } catch (e) {
      setTurns((ts) => ts.map((t) => (t.id === id ? { id, question: q, state: "failed", error: (e as Error).message } : t)));
    }
  }, [busy]);

  React.useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [turns]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:w-[480px] p-0 flex flex-col">
        <SheetHeader className="p-5">
          <SheetTitle>Ask Neo</SheetTitle>
          <SheetDescription>
            Ask about spend, leads, orders, revenue and ROAS. Neo reads your own company&apos;s numbers only and never changes anything.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5" aria-live="polite">
          {turns.length === 0 && (
            <div className="space-y-2">
              <p className="text-sm text-ink-3">Try one of these:</p>
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((ex) => (
                  <Button key={ex} type="button" variant="outline" size="sm" onClick={() => void ask(ex)}>{ex}</Button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t) => (
            <div key={t.id} className="space-y-2">
              <p className="text-sm font-medium text-ink">{t.question}</p>
              {t.state === "asking" && <p className="text-sm text-ink-3">Reading the numbers…</p>}
              {t.state === "failed" && <p className="text-sm text-rose-ink" role="alert">{t.error}</p>}
              {t.state === "done" && <NeoAnswerView reply={t.reply} />}
            </div>
          ))}
          <div ref={endRef} />
        </div>

        <form
          className="border-t border-hairline p-4 flex gap-2"
          onSubmit={(e) => { e.preventDefault(); void ask(text); }}
        >
          <label htmlFor="neo-question" className="sr-only">Your question</label>
          <Input
            id="neo-question"
            value={text}
            maxLength={500}
            placeholder="e.g. Last 7 days ROAS"
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
            autoComplete="off"
          />
          <Button type="submit" disabled={busy || !text.trim()}>Ask</Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function NeoAnswerView({ reply }: { reply: NeoReply }) {
  const a = reply.answer;
  return (
    <div className="rounded-lg border border-hairline bg-paper-2/40 p-3 space-y-3">
      <p className="text-sm text-ink">{a.summary}</p>
      {a.notes.map((n) => <p key={n} className="text-xs text-ink-3">{n}</p>)}
      {a.chart && <NeoChartView chart={a.chart} />}
      {a.table.rows.length > 0 && <NeoTableView table={a.table} />}
      <p className="text-[11px] text-ink-3">
        Read: {reply.plan.metrics.map((m) => METRIC_LABEL[m]).join(", ")} · {a.rangeLabel}
        {reply.planSource === "ai" ? " · plan read by AI" : ""}
      </p>
    </div>
  );
}

function NeoChartView({ chart }: { chart: NeoChart }) {
  const data = chart.points.map((p) => ({ x: p.x, y: p.y }));
  const fmt = (v: number) => formatMetric(chart.metric, v);
  const axis = { tick: { fontSize: 11, fill: "hsl(var(--ink-3))" }, stroke: "hsl(var(--hairline))" };
  return (
    <figure className="h-48" aria-label={`${chart.metricLabel} by ${chart.xLabel.toLowerCase()}`}>
      <ResponsiveContainer width="100%" height="100%">
        {chart.type === "line" ? (
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="hsl(var(--hairline))" vertical={false} />
            <XAxis dataKey="x" {...axis} interval="preserveStartEnd" minTickGap={24} />
            <YAxis {...axis} width={64} tickFormatter={fmt} />
            <Tooltip formatter={(v: number) => [fmt(v), chart.metricLabel]} />
            <Line type="monotone" dataKey="y" stroke="hsl(var(--amber))" strokeWidth={2} dot={data.length <= 31} connectNulls />
          </LineChart>
        ) : (
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="hsl(var(--hairline))" vertical={false} />
            <XAxis dataKey="x" {...axis} interval={0} tickFormatter={(v: string) => (v.length > 14 ? `${v.slice(0, 13)}…` : v)} />
            <YAxis {...axis} width={64} tickFormatter={fmt} />
            <Tooltip formatter={(v: number) => [fmt(v), chart.metricLabel]} />
            <Bar dataKey="y" fill="hsl(var(--indigo))" maxBarSize={40} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </figure>
  );
}

function NeoTableView({ table }: { table: NeoTable }) {
  return (
    <div className="max-h-56 overflow-auto rounded border border-hairline">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-paper">
          <tr>
            {table.columns.map((c) => (
              <th key={c.key} scope="col" className={cn("px-2 py-1.5 font-medium text-ink-3", c.kind === "text" ? "text-left" : "text-right")}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i} className="border-t border-hairline">
              {table.columns.map((c) => (
                <td key={c.key} className={cn("px-2 py-1.5", c.kind === "text" ? "text-left" : "text-right tabular-nums")}>
                  {c.kind === "text" ? String(r[c.key] ?? "—") : formatMetric(c.kind as NeoMetric, r[c.key] as number | null)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
