"use client";
/**
 * The inside of the Renewals strip (closed by default, R-2266): the 6-month renewal forecast
 * (audit B7) and the Renewal AI top pick. Moved out of page.tsx by R-2405, when the strip's old
 * money line and tiles gave way to the action tiles above the queue (tiles-card.tsx).
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { GeminiCard } from "@/components/shared/gemini-card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rupee } from "@/lib/utils";
import type { RenewalForecast } from "@/lib/renewals/forecast";

export function ForecastPanel({
  forecast, atRiskCount, atRiskArr, topName, topCustomerId, topReasons,
}: {
  forecast: RenewalForecast;
  atRiskCount: number;
  atRiskArr: number;
  topName: string;
  topCustomerId: string | null;
  topReasons: string[];
}) {
  const router = useRouter();
  const maxForecast = Math.max(1, ...forecast.months.map((m) => m.amount));
  return (
    <>
      {/* ── Renewal revenue forecast — next 6 months (audit B7) ── */}
      <div className="bg-paper-2/40 border border-hairline rounded-lg p-3">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Renewal forecast · next 6 months</p>
          {/* R-2431: one total, in term amounts before GST (the tiles' amount without a quote); monthly (flex) parts are in it. */}
          <p className="text-xs text-ink-3">Renewals {rupee(forecast.totalAmount, { compact: true })} + GST ({forecast.totalCount} due {forecast.totalCount === 1 ? "date" : "dates"}){forecast.flexCount > 0 ? <> · incl. {forecast.flexCount} monthly (flex) {forecast.flexCount === 1 ? "subscription" : "subscriptions"}, one part each month</> : null}</p>
        </div>
        <div className="mt-2 grid grid-cols-3 sm:grid-cols-6 gap-2">
          {forecast.months.map((m) => (
            <div key={m.key} className="text-center">
              <div className="h-16 flex items-end justify-center">
                <div
                  className="w-7 rounded-t bg-amber/80"
                  style={{ height: `${Math.round((m.amount / maxForecast) * 100)}%`, minHeight: m.amount > 0 ? 4 : 0 }}
                  title={`${m.label}: ${rupee(m.amount)} (${m.count})`}
                />
              </div>
              <p className="mt-1 text-3xs text-ink-3">{m.label.slice(0, 3)}</p>
              <p className="text-2xs tabular-nums text-ink-2">{m.amount > 0 ? rupee(m.amount, { compact: true }) : "—"}</p>
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-3xs text-ink-3">Estimate: MRR × 12 in the renewal month (ex-GST); excludes churn and expansion.</p>
      </div>

      {/* Renewal AI — next best action */}
      {atRiskCount > 0 && (
        <GeminiCard
          title="Renewal AI · Next best actions"
          actions={
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => router.push((topCustomerId ? `/customers/${topCustomerId}` : "/customers") as never)}
              >
                <Icon name="user" size={12} />
                Open {topName}
              </Button>
            </div>
          }
          compact
        >
          <strong className="text-ink">
            {atRiskCount} renewal{atRiskCount !== 1 ? "s" : ""} at risk, worth{" "}
            {rupee(atRiskArr, { compact: true })} a year.
          </strong>{" "}
          Top priority: <strong>{topName}</strong>
          {topReasons.length > 0 ? <> — {topReasons.join(" · ").toLowerCase()}</> : null}.
          Call or WhatsApp this week to secure the renewal.
        </GeminiCard>
      )}
    </>
  );
}
