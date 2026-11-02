/**
 * SubsInsightsStrip — R-1727 (owner journey audit, 21 Oct 2026).
 *
 * /subscriptions opened with three boxes above the list: the revenue analytics banner,
 * "Margin at risk" and "License leakage". At 1280px they pushed the table below the first
 * screen, on a page that is opened to act on a subscription. They now sit in ONE strip,
 * closed by default, whose closed line still carries the numbers — so closing it hides
 * the detail, never the fact that there is something to look at.
 *
 * R-2266: built on the shared CollapsibleKpiStrip — the same strip Quotes, Invoices,
 * Renewals and Companies use; open / closed is remembered per signed-in user.
 */
"use client";

import * as React from "react";
import { cn, rupee } from "@/lib/utils";
import { CollapsibleKpiStrip, StripFact } from "@/components/shared/collapsible-kpi-strip";

/** R-2266: this page's strip id (the storage key adds the user id — kpiStripKey). */
export const INSIGHTS_STRIP_ID = "subscriptions";

export function SubsInsightsStrip({
  userId, mrr, arr, seats, marginAtRisk, marginUnchecked, leakingMonthly, leakingCount, neverReconciled, children,
}: {
  /** Signed-in user — open / closed is remembered per user (R-2266). */
  userId: string | null | undefined;
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
  const warnings: { key: string; text: string; tone: "bad" | "warn" }[] = [];
  if ((marginAtRisk ?? 0) > 0) warnings.push({ key: "margin", text: `Margin at risk ${marginAtRisk}`, tone: "bad" });
  if ((marginUnchecked ?? 0) > 0) warnings.push({ key: "nocost", text: `No vendor cost ${marginUnchecked}`, tone: "warn" });
  if (leakingCount > 0) warnings.push({ key: "leak", text: `Leaking ${rupee(leakingMonthly)}/mo`, tone: "bad" });
  if (neverReconciled > 0) warnings.push({ key: "recon", text: `Never reconciled ${neverReconciled}`, tone: "warn" });
  const loading = marginAtRisk == null;

  return (
    <CollapsibleKpiStrip
      stripId={INSIGHTS_STRIP_ID}
      userId={userId}
      title="Insights"
      className="mb-4"
      summary={
        <>
          <StripFact label="MRR" value={rupee(mrr, { compact: true })} />
          <StripFact label="ARR" value={rupee(arr, { compact: true })} />
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
        </>
      }
    >
      {children}
    </CollapsibleKpiStrip>
  );
}
