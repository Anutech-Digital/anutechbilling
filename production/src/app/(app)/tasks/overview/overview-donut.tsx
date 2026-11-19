/**
 * R-2936 — one donut of Tasks → Overview (open tasks by status, or by priority).
 *
 * The ring is a picture only: one `role="img"` with every number in its label. The list next
 * to it carries the same numbers as text and is what a person clicks or tabs to — each line is
 * a link into the Tasks list. The ring itself is hidden from screen readers and takes no
 * keyboard focus. Colour is never the only sign: every line has its word and count.
 */
"use client";

import Link from "next/link";
import type { Route } from "next";
import { Cell, Pie, PieChart } from "recharts";
import { Card } from "@/components/ui/card";
import { sliceShare } from "./overview-counts";

export interface DonutSlice {
  id: string;
  label: string;
  count: number;
  /** A CSS colour (a design token: `hsl(var(--rose))`). */
  color: string;
  /** Where the line goes — the Tasks list holding these tasks. */
  href: string;
}

/** The ring is 148 px square — the same number as the h-[148px] w-[148px] box below. */
const SIZE = 148;

export function OverviewDonut({
  title, hint, slices, testId,
}: {
  title: string;
  hint: string;
  slices: readonly DonutSlice[];
  testId?: string;
}) {
  const total = slices.reduce((s, x) => s + x.count, 0);
  const summary = total === 0
    ? `${title}: no open tasks`
    : `${title}: ${slices.map((s) => `${s.label} ${s.count} (${sliceShare(s.count, total)}%)`).join(", ")}`;
  const drawn = slices.filter((s) => s.count > 0);

  return (
    <Card className="p-5" data-testid={testId}>
      <h2 className="text-sm font-semibold text-ink leading-tight">{title}</h2>
      <p className="text-xs text-ink-3 mt-0.5 mb-4">{hint}</p>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
        <div className="relative h-[148px] w-[148px] shrink-0" role="img" aria-label={summary}>
          {total > 0 ? (
            <div aria-hidden="true">
              <PieChart width={SIZE} height={SIZE} accessibilityLayer={false}>
                <Pie
                  data={drawn}
                  dataKey="count"
                  nameKey="label"
                  innerRadius={46}
                  outerRadius={70}
                  paddingAngle={drawn.length > 1 ? 2 : 0}
                  stroke="none"
                  startAngle={90}
                  endAngle={-270}
                  isAnimationActive={false}
                  rootTabIndex={-1}
                >
                  {drawn.map((s) => <Cell key={s.id} fill={s.color} />)}
                </Pie>
              </PieChart>
            </div>
          ) : (
            /* Nothing open: an empty ring, so the card keeps its shape. */
            <div className="absolute inset-[4px] rounded-full border-[24px] border-paper-2" aria-hidden="true" />
          )}
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center" aria-hidden="true">
            <span className="font-serif text-2xl tabular-nums leading-none text-ink">{total}</span>
            <span className="mt-1 text-2xs uppercase tracking-wide text-ink-3">open</span>
          </div>
        </div>

        <ul className="min-w-[180px] flex-1 space-y-1">
          {slices.map((s) => (
            <li key={s.id}>
              <Link
                href={s.href as Route}
                aria-label={`${s.label}: ${s.count} open ${s.count === 1 ? "task" : "tasks"}, ${sliceShare(s.count, total)}% — open the Tasks list`}
                className="flex min-h-11 items-center gap-2 rounded px-2 py-1.5 -mx-2 text-sm md:min-h-0 transition-colors hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
                <span className="flex-1 text-ink-2">{s.label}</span>
                <span className="font-semibold tabular-nums text-ink">{s.count}</span>
                <span className="w-10 text-right text-xs tabular-nums text-ink-3">{sliceShare(s.count, total)}%</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
