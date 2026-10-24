/**
 * Dashboard "Deals" strip — four money tiles, each a link to /deals (30 Sep 2026).
 *
 * Numbers: lib/deals/pipeline-summary.ts (summarizeDealStrip), rows: lib/queries/deals.ts.
 * Renders nothing for a role that cannot open /deals (lib/deals/access.ts), and says so
 * when the read fails instead of showing ₹0 — a zero here would read as "no pipeline".
 */
"use client";

import Link from "next/link";
import type { Route } from "next";
import { KPI } from "@/components/shared/kpi";
import { loadErrorBody } from "@/components/shared/load-error";
import { useDealRows } from "@/lib/queries/deals";
import { summarizeDealStrip } from "@/lib/deals/pipeline-summary";
import { canSeeDeals } from "@/lib/deals/access";
import { rupee } from "@/lib/utils";
import { drillHref } from "@/lib/navigation/drilldown";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function DealsStrip({ role }: { role: string | null | undefined }) {
  const allowed = canSeeDeals(role);
  const { data, isLoading, error } = useDealRows(allowed);
  // role undefined = the signed-in user is still loading: hold the strip's place (R-134).
  if (!allowed && role !== undefined) return null;

  const s = data ? summarizeDealStrip(data) : null;
  const loading = role === undefined || isLoading || !s;
  const tiles = s ? [
    { label: "Pipeline", value: rupee(s.pipeline.value, { compact: true }), icon: "target",
      trend: plural(s.pipeline.count, "open deal", "open deals"), href: drillHref("dealsOpen") },
    { label: "Weighted", value: rupee(s.weighted, { compact: true }), icon: "trending_up",
      trend: "By stage probability", href: drillHref("dealsOpen") },
    { label: "Closing this month", value: rupee(s.closingThisMonth.value, { compact: true }), icon: "calendar",
      trend: plural(s.closingThisMonth.count, "deal", "deals"), href: drillHref("dealsClosing") },
    { label: "Won this month", value: rupee(s.wonThisMonth.value, { compact: true }), icon: "check_circle",
      trend: plural(s.wonThisMonth.count, "deal", "deals"), accent: "emerald" as const,
      href: drillHref("dealsWonMonth") },
  ] : [];

  return (
    <section aria-labelledby="dash-deals" className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <h2 id="dash-deals" className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Deals</h2>
        <Link href={"/deals" as Route} className="text-xs font-medium text-amber-ink hover:underline">
          All deals →
        </Link>
      </div>
      {error ? (
        <p className="text-sm text-rose-ink rounded-lg border border-hairline bg-paper p-3">
          Couldn't load deals. {loadErrorBody(error)} This is not ₹0; open <Link href={"/deals" as Route} className="underline">/deals</Link>.
        </p>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {loading
            ? ["Pipeline", "Weighted", "Closing this month", "Won this month"].map((l) => (
                <KPI key={l} label={l} value="" loading />
              ))
            : tiles.map((t) => (
                /* R-118: each tile opens exactly the deals it counts. */
                <KPI key={t.label} label={t.label} value={t.value} icon={t.icon} trend={t.trend}
                     accent={t.accent ?? "ink"} href={t.href} />
              ))}
        </div>
      )}
    </section>
  );
}
