/**
 * SubsInsightsStrip — R-1727 (owner journey audit, 21 Oct 2026).
 *
 * /subscriptions opened with three boxes above the list: the revenue analytics banner,
 * "Margin at risk" and "License leakage". At 1280px they pushed the table below the first
 * screen, on a page that is opened to act on a subscription. They now sit in ONE strip,
 * closed by default, whose closed line still carries the numbers — so closing it hides
 * the detail, never the fact that there is something to look at.
 *
 * Open / closed is remembered per viewer (this browser). Starts closed on the server and
 * on first paint, then reads the saved choice — reading storage during render would make
 * the server and client disagree.
 */
"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { cn, rupee } from "@/lib/utils";

export const INSIGHTS_OPEN_KEY = "ros.subscriptions.insights";

export function SubsInsightsStrip({
  mrr, arr, seats, marginAtRisk, marginUnchecked, leakingMonthly, leakingCount, neverReconciled, children,
}: {
  mrr: number;
  arr: number;
  /** seatsPhrase() of the active subscriptions — "10 seats licensed". */
  seats: string;
  /** Priced subscriptions at or below the margin floor. Null while loading. */
  marginAtRisk: number | null;
  /** Subscriptions whose margin cannot be checked (no vendor cost). Null while loading. */
  marginUnchecked: number | null;
  leakingMonthly: number;
  leakingCount: number;
  neverReconciled: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const bodyId = React.useId();
  React.useEffect(() => {
    try { if (window.localStorage.getItem(INSIGHTS_OPEN_KEY) === "open") setOpen(true); } catch { /* private mode */ }
  }, []);
  const toggle = () => setOpen((o) => {
    const next = !o;
    try { window.localStorage.setItem(INSIGHTS_OPEN_KEY, next ? "open" : "closed"); } catch { /* private mode */ }
    return next;
  });

  const warnings: { key: string; text: string; tone: "bad" | "warn" }[] = [];
  if ((marginAtRisk ?? 0) > 0) warnings.push({ key: "margin", text: `Margin at risk ${marginAtRisk}`, tone: "bad" });
  if ((marginUnchecked ?? 0) > 0) warnings.push({ key: "nocost", text: `No vendor cost ${marginUnchecked}`, tone: "warn" });
  if (leakingCount > 0) warnings.push({ key: "leak", text: `Leaking ${rupee(leakingMonthly)}/mo`, tone: "bad" });
  if (neverReconciled > 0) warnings.push({ key: "recon", text: `Never reconciled ${neverReconciled}`, tone: "warn" });
  const loading = marginAtRisk == null;

  return (
    <div className="mb-4 bg-paper border border-hairline rounded-lg overflow-hidden shadow-xs">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className="w-full flex items-center justify-between gap-2 px-3.5 py-2 bg-paper-2/70 hover:bg-paper-2 transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber"
      >
        <span className="flex items-center gap-x-2 gap-y-1 flex-wrap text-xs min-w-0">
          <Icon name="bar_chart" size={15} className="text-amber-ink" />
          <span className="font-semibold text-ink">Insights</span>
          <span className="text-ink-3" aria-hidden>·</span>
          <span className="text-ink-2">MRR <b className="text-ink tabular-nums">{rupee(mrr, { compact: true })}</b></span>
          <span className="text-ink-3" aria-hidden>·</span>
          <span className="text-ink-2">ARR <b className="text-ink tabular-nums">{rupee(arr, { compact: true })}</b></span>
          {seats && (
            <>
              <span className="text-ink-3" aria-hidden>·</span>
              <span className="text-ink-2 tabular-nums">{seats}</span>
            </>
          )}
          {warnings.map((w) => (
            <span
              key={w.key}
              className={cn(
                "rounded-full px-2 py-0.5 text-2xs font-semibold tabular-nums",
                w.tone === "bad" ? "bg-rose-soft text-rose-ink" : "bg-amber-soft text-amber-ink",
              )}
            >
              {w.text}
            </span>
          ))}
          {!loading && warnings.length === 0 && (
            <span className="text-2xs text-emerald">No margin or leakage warnings</span>
          )}
        </span>
        <span className="flex items-center gap-1 text-xs font-semibold text-amber-ink shrink-0">
          <span>{open ? "Collapse" : "Expand"}</span>
          <Icon name={open ? "chevron_up" : "chevron_down"} size={14} />
        </span>
      </button>
      <div id={bodyId} hidden={!open} className="p-3 border-t border-hairline space-y-3 bg-paper">
        {open && children}
      </div>
    </div>
  );
}
