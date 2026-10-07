"use client";
/**
 * /quality — Quality Score (R-263, 6 Oct 2026). Owner / manager.
 *
 * Pardeep: "app world number one" — and perfect has to be measured. Each row is one target:
 * the real number, the target, a colour against it, and where to look next. Targets the
 * data cannot answer yet are listed as "Not measured yet" so the gap stays visible.
 * The numbers come from lib/quality/score.ts (tested); this page only lays them out.
 *
 * "This workspace" reads through RLS. The platform owner also gets "All workspaces"
 * (/api/quality/platform, founder allowlist) — signup → first invoice means most there.
 */
import * as React from "react";
import Link from "next/link";
import type { Route } from "next";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useQualityInput, usePlatformQualityInput } from "@/lib/quality/queries";
import { buildQualityReport, type QualityMetric, type QualityStatus } from "@/lib/quality/score";

const STATUS: Record<QualityStatus, { label: string; chip: string; bar: string }> = {
  green: { label: "On target", chip: "bg-emerald-soft text-emerald-ink", bar: "bg-emerald" },
  amber: { label: "Close", chip: "bg-amber-soft text-amber-ink", bar: "bg-amber" },
  red: { label: "Off target", chip: "bg-rose-soft text-rose-ink", bar: "bg-rose" },
  info: { label: "For info", chip: "bg-indigo-soft text-indigo-ink", bar: "bg-indigo" },
  none: { label: "No data", chip: "bg-paper-2 text-ink-3", bar: "bg-hairline-strong" },
};

function MetricRow({ m }: { m: QualityMetric }) {
  const s = STATUS[m.status];
  return (
    <li className="relative flex flex-col gap-2 border-b border-hairline px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4">
      <span aria-hidden className={cn("absolute left-0 top-3 bottom-3 w-1 rounded-r", s.bar)} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink">{m.label}</div>
        <div className="text-xs text-ink-3 mt-0.5">{m.detail}</div>
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:justify-end">
        <div className="text-right">
          <div className={cn("font-mono tabular-nums", m.measured ? "text-lg text-ink" : "text-sm text-ink-3")}>{m.value}</div>
          <div className="text-2xs text-ink-3">Target {m.target}</div>
        </div>
        <span className={cn("rounded-full px-2 py-0.5 text-2xs font-medium whitespace-nowrap", s.chip)}>{s.label}</span>
        {m.href && (
          <Link href={m.href as Route} className="text-xs font-medium text-amber-ink underline-offset-2 hover:underline whitespace-nowrap">
            {m.hrefLabel ?? "Open"}
          </Link>
        )}
      </div>
    </li>
  );
}

export default function QualityPage() {
  const { data: me } = useCurrentUser();
  const [scope, setScope] = React.useState<"mine" | "all">("mine");
  const isPlatform = Boolean(me?.isPlatformAdmin);

  const mine = useQualityInput(me?.tenantId ?? null);
  const platform = usePlatformQualityInput(isPlatform && scope === "all");
  const q = scope === "all" && isPlatform ? platform : mine;

  /* The clock is read once per data load, so the "last 7 days" row does not drift between renders. */
  const metrics = React.useMemo(
    () => (q.data ? buildQualityReport(q.data, new Date()) : null),
    [q.data],
  );
  const measured = metrics?.filter((m) => m.measured) ?? [];
  const notYet = metrics?.filter((m) => !m.measured) ?? [];
  const onTarget = measured.filter((m) => m.status === "green").length;
  const scored = measured.filter((m) => m.status === "green" || m.status === "amber" || m.status === "red").length;

  return (
    <div className="mx-auto max-w-[960px] p-4 md:p-6 lg:p-8 space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-serif text-3xl md:text-4xl leading-tight text-ink">Quality Score</h1>
          <p className="text-sm text-ink-3 mt-1">Real numbers against our targets. Red rows first.</p>
        </div>
        {metrics && scored > 0 && (
          <div className="text-right">
            <div className="font-mono tabular-nums text-2xl text-ink">{onTarget}/{scored}</div>
            <div className="text-2xs text-ink-3">on target</div>
          </div>
        )}
      </header>

      {isPlatform && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Which workspaces">
          {(["mine", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={scope === s}
              onClick={() => setScope(s)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                scope === s ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline text-ink-2 hover:bg-paper-2",
              )}
            >
              {s === "mine" ? "This workspace" : "All workspaces"}
            </button>
          ))}
        </div>
      )}

      {q.error ? (
        <Card className="p-4">
          <p className="text-sm text-rose-ink" role="alert">{(q.error as Error).message || "Could not load the numbers."}</p>
          <button type="button" onClick={() => void q.refetch()} className="mt-2 text-xs font-medium text-amber-ink underline">
            Try again
          </button>
        </Card>
      ) : !metrics ? (
        <Card className="p-0">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 border-b border-hairline px-4 py-3 last:border-b-0">
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-6 w-20" />
            </div>
          ))}
        </Card>
      ) : (
        <>
          <Card className="p-0 overflow-hidden">
            <ul>
              {[...measured]
                .sort((a, b) => order(a.status) - order(b.status))
                .map((m) => <MetricRow key={m.id} m={m} />)}
            </ul>
          </Card>

          <section aria-labelledby="not-yet">
            <h2 id="not-yet" className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">Not measured yet</h2>
            <Card className="p-0 overflow-hidden">
              <ul>{notYet.map((m) => <MetricRow key={m.id} m={m} />)}</ul>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}

/** Red first, then amber, then the rest — what needs work is at the top. */
function order(s: QualityStatus): number {
  return { red: 0, amber: 1, none: 2, info: 3, green: 4 }[s];
}
