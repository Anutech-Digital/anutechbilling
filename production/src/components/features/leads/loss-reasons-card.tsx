/**
 * LossReasonsCard — "why are we losing deals?", answered in money.
 *
 * Sorted by VALUE lost rather than count, because one ₹5L competitor loss
 * deserves more attention than five ₹10k price losses, and a count-sorted list
 * buries exactly that.
 *
 * Deals lost before capture existed show as "Not recorded" instead of being
 * dropped — hiding them would make the percentages read as if every loss had
 * been explained. When that row is large, the honest read is "we don't know
 * yet", and the card says so rather than implying a finding.
 */
"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { lossBreakdown } from "@/lib/leads/loss-reasons";
import { rupee, cn } from "@/lib/utils";
import type { Lead } from "@/lib/supabase/database.types";

type LossLead = Pick<Lead, "stage" | "value"> & { lost_reason?: string | null; lost_at?: string | null };

const WINDOWS = [
  { id: "90", label: "90 days", days: 90 },
  { id: "365", label: "1 year", days: 365 },
  { id: "all", label: "All time", days: null },
] as const;

export function LossReasonsCard({ leads }: { leads: readonly LossLead[] }) {
  const [win, setWin] = React.useState<(typeof WINDOWS)[number]["id"]>("90");
  const [open, setOpen] = React.useState(true);

  const active = WINDOWS.find((w) => w.id === win)!;
  const since = React.useMemo(
    () => (active.days == null ? undefined : new Date(Date.now() - active.days * 86_400_000)),
    [active.days],
  );

  const rows = React.useMemo(() => lossBreakdown(leads, since), [leads, since]);
  const totalCount = rows.reduce((s, r) => s + r.count, 0);
  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  const maxValue = Math.max(1, ...rows.map((r) => r.value));
  const unrecorded = rows.find((r) => r.code === "unrecorded");
  const mostlyUnrecorded = unrecorded ? unrecorded.count / Math.max(1, totalCount) >= 0.5 : false;

  // Nothing lost in the window is genuinely good news — say that, don't render
  // an empty chart.
  if (totalCount === 0) {
    return (
      <Card className="p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
            <Icon name="chart" size={15} className="text-ink-3" />
            Why deals are lost
          </h3>
          <WindowPicker value={win} onChange={setWin} />
        </div>
        <p className="mt-2 text-xs text-ink-3">
          {emptyLossText(active)}
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 text-sm font-semibold text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-amber rounded"
          aria-expanded={open}
        >
          <Icon name="chart" size={15} className="text-ink-3" />
          Why deals are lost
          <span className="text-xs font-normal text-ink-3">
            · {totalCount} deal{totalCount === 1 ? "" : "s"} · {rupee(totalValue, { compact: true })}
          </span>
          <Icon name={open ? "chevron_up" : "chevron_down"} size={14} className="text-ink-3" />
        </button>
        <WindowPicker value={win} onChange={setWin} />
      </div>

      {open && (
        <>
          {mostlyUnrecorded && (
            // Don't let the owner read a conclusion out of mostly-missing data.
            <p className="mt-2 text-xs text-ink-3 leading-snug">
              Most of these were lost before the reason prompt existed, so this is
              not yet a reliable picture — it fills in from here.
            </p>
          )}

          <ul className="mt-3 space-y-2">
            {rows.map((r) => (
              <li key={r.code}>
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className={cn("truncate", r.code === "unrecorded" ? "text-ink-3 italic" : "text-ink font-medium")}>
                    {r.label}
                  </span>
                  <span className="shrink-0 tabular-nums text-ink-3">
                    <span className={cn("font-semibold", r.code === "unrecorded" ? "text-ink-3" : "text-ink")}>
                      {rupee(r.value, { compact: true })}
                    </span>
                    <span className="ml-1.5 text-ink-3">· {r.count} ({r.pct}%)</span>
                  </span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-paper-3 overflow-hidden">
                  <div
                    className={cn("h-full rounded-full", r.code === "unrecorded" ? "bg-slate/40" : "bg-amber")}
                    style={{ width: `${Math.round((r.value / maxValue) * 100)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function WindowPicker({
  value, onChange,
}: { value: string; onChange: (v: (typeof WINDOWS)[number]["id"]) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-hairline p-0.5 bg-paper-2">
      {WINDOWS.map((w) => (
        <button
          key={w.id}
          type="button"
          onClick={() => onChange(w.id)}
          aria-pressed={value === w.id}
          className={cn(
            "px-2 py-0.5 rounded-md text-2xs font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-amber",
            value === w.id ? "bg-paper text-ink shadow-2xs" : "text-ink-3 hover:text-ink",
          )}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}

/** The "nothing lost" line for a window. "All time" has no "last" (R-349: the card used to say
 *  "No deals marked lost in the last all time."). Exported for tests. */
export function emptyLossText(w: { days: number | null; label: string }): string {
  return w.days == null
    ? "No deals marked lost yet."
    : `No deals marked lost in the last ${w.label.toLowerCase()}.`;
}
