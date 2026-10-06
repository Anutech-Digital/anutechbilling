/**
 * LeadsInsightBand — header band visible above the Leads / Deals list.
 *
 * Two stacked rows:
 *   1. KPI pills — Today · Overdue · Hot · This week · This month · Won MTD
 *      (last 3 hidden on mobile to preserve thumb space).
 *   2. Pipeline pulse — horizontal stacked bar showing the % of leads in
 *      each active stage. Tap a segment to filter by that stage.
 *
 * Tap interactions:
 *   - Today / Overdue / Hot pill → calls `onChangeDueFilter` with that key.
 *     Tapping the active pill again toggles back to "all".
 *   - Pulse segment → calls `onToggleStage` with the segment's stage id.
 *     Parent decides whether to set the stage filter to that single value
 *     or union it.
 *
 * Design rationale:
 *   - Pills give MAX info density in MIN vertical space — sales reps care
 *     about "what do I need to do today" first, "what's hot" second.
 *   - Pulse visualizes pipeline shape at a glance. A healthy pipeline has
 *     proportional segments; if 80% is "New", lead-gen is fine but
 *     qualification is broken.
 *   - Both rows are tappable filters — clicking is one tap to drill down.
 *
 * @example
 *   <LeadsInsightBand
 *     leads={allLeads}
 *     dueFilter={dueFilter}
 *     activeStages={stageFilter}
 *     onChangeDueFilter={setDueFilter}
 *     onToggleStage={(s) => setStageFilter([s])}
 *   />
 */
"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { rupee, cn } from "@/lib/utils";
import type { Lead } from "@/lib/supabase/database.types";
import { istToday } from "@/lib/dates/ist";
import { LEAD_STAGE_IDS, STAGE_DOT, STAGE_LABEL } from "@/lib/leads/stage-meta";

export type LeadsDueFilter = "all" | "today" | "overdue" | "hot";

interface LeadsInsightBandProps {
  /** Full leads array (pre-filter). The band always shows the universe,
   *  never the search-filtered subset, so KPIs stay accurate while the
   *  user types into search. */
  leads: Lead[];
  /** Currently active due/hot filter — drives the highlighted pill. */
  dueFilter: LeadsDueFilter;
  /** Stage IDs in the active stage filter — dims pulse segments that
   *  aren't included (when filter has 1+ items). */
  activeStages: Lead["stage"][];
  onChangeDueFilter: (f: LeadsDueFilter) => void;
  onToggleStage: (stage: Lead["stage"]) => void;
}

// Pipeline stages, in order. We exclude "lost" so the pulse stays focused
// on forward-flowing leads (a "lost" graveyard segment just makes the bar
// noisier for the question "where is my pipeline?").
// R-249: the funnel order and labels come from lib/leads/stage-meta, as on the board.
const ACTIVE_STAGES: Array<Lead["stage"]> = LEAD_STAGE_IDS;

const stageMeta = (s: Lead["stage"]) => ({ label: STAGE_LABEL[s], segment: STAGE_DOT[s], dot: STAGE_DOT[s] });
const STAGE_META: Record<Lead["stage"], { label: string; segment: string; dot: string }> = {
  new: stageMeta("new"), contact: stageMeta("contact"), quote: stageMeta("quote"), demo: stageMeta("demo"),
  trial: stageMeta("trial"), won: stageMeta("won"), lost: stageMeta("lost"),
};

export function LeadsInsightBand({
  leads,
  dueFilter,
  activeStages,
  onChangeDueFilter,
  onToggleStage,
}: LeadsInsightBandProps) {
  // Time bounds — computed once per render (data set is small).
  const today = istToday();
  const monthStartDate = new Date();
  monthStartDate.setDate(1);
  monthStartDate.setHours(0, 0, 0, 0);
  const weekAgoDate = new Date();
  weekAgoDate.setDate(weekAgoDate.getDate() - 7);
  const monthAgoDate = new Date();
  monthAgoDate.setDate(monthAgoDate.getDate() - 30);

  // ── KPI counts ─────────────────────────────────────────────
  // "Open" excludes won/lost — those don't need follow-ups.
  const openLeads = leads.filter((l) => l.stage !== "won" && l.stage !== "lost");
  // "Today" KPI = leads created today (operator-friendly: "aaj jo aayi").
  // The Overdue KPI handles follow-up urgency separately.
  const dueTodayCount = leads.filter((l) => l.created_at?.slice(0, 10) === today).length;
  const overdueCount  = openLeads.filter((l) => l.follow_up_date && l.follow_up_date < today).length;
  // "Hot" = stages where the customer is engaged + a deal is on the table.
  const hotCount = leads.filter((l) =>
    l.stage === "demo" || l.stage === "trial" || l.stage === "quote",
  ).length;
  const newThisWeek  = leads.filter((l) => l.created_at && new Date(l.created_at) >= weekAgoDate).length;
  // newThisMonth (30-day count) was dropped from KPI strip — Won MTD captures
  // the more useful "this month" signal. Keep variable definition removed.
  const wonMtdValue = leads
    .filter((l) => l.stage === "won" && l.created_at && new Date(l.created_at) >= monthStartDate)
    .reduce((s, l) => s + (l.value ?? 0), 0);

  // ── Pulse: ₹ value per stage (Indian CRM pattern — value-weighted
  // pulse tells you WHERE the money is, not just how many cards. A stage
  // with 1 ₹10L deal matters more than a stage with 5 ₹50k leads).
  // Counts are preserved for the legend so reps see both signals.
  const stageStats = ACTIVE_STAGES.reduce<Record<string, { count: number; value: number }>>((acc, s) => {
    const inStage = leads.filter((l) => l.stage === s);
    acc[s] = {
      count: inStage.length,
      // If a lead has no value yet (raw lead), substitute a nominal 1 so
      // count-only stages still get a sliver in the bar.
      value: inStage.reduce((sum, l) => sum + Math.max(l.value ?? 0, 1), 0),
    };
    return acc;
  }, {});
  const pulseTotal = Object.values(stageStats).reduce((s, c) => s + c.value, 0);
  const totalCount = Object.values(stageStats).reduce((s, c) => s + c.count, 0);

  return (
    <div className="space-y-3 mb-5">
      {/* Row 1 — KPI pills.
          Mobile + tablet (<1024px): 3 cols (Today / Overdue / Hot) — the actionable trio.
          Laptop+ (≥1024px): 6 cols (+ This week / This month / Won MTD) — overview metrics.
          The last 3 KpiPills below use `hidden lg:flex` so they're skipped
          at the narrower widths to avoid text-wrapping inside each pill. */}
      <div className="grid grid-cols-3 lg:grid-cols-5 gap-2 md:gap-3">
        <KpiPill
          icon="clock"
          label="Today"
          value={dueTodayCount}
          tone={dueTodayCount > 0 ? "amber" : "muted"}
          active={dueFilter === "today"}
          onClick={() => onChangeDueFilter(dueFilter === "today" ? "all" : "today")}
          tooltipText="Leads created today"
        />
        <KpiPill
          icon="alert"
          label="Overdue"
          value={overdueCount}
          tone={overdueCount > 0 ? "rose" : "muted"}
          active={dueFilter === "overdue"}
          onClick={() => onChangeDueFilter(dueFilter === "overdue" ? "all" : "overdue")}
          tooltipText="Follow-ups missed — call these first"
        />
        <KpiPill
          icon="zap"
          label="Hot"
          value={hotCount}
          tone={hotCount > 0 ? "amber-soft" : "muted"}
          active={dueFilter === "hot"}
          onClick={() => onChangeDueFilter(dueFilter === "hot" ? "all" : "hot")}
          tooltipText="Leads in demo / trial / quote — high-intent"
        />
        {/* Desktop-only secondary stats. Read-only (no filter behaviour). */}
        <KpiPill
          icon="trending_up"
          label="This week"
          value={newThisWeek}
          tone="muted"
          className="hidden lg:flex"
          tooltipText="Leads added in the last 7 days"
        />
        {/* "This month" pill dropped from 5-pill layout — overlapped with
            "Won MTD" semantically. Research showed: 5 KPIs max for B2B
            (Stripe / Datadog / Linear all cap at 4-5). */}
        <KpiPill
          icon="rupee"
          label="Won this month"
          value={wonMtdValue}
          formatAs="currency"
          tone={wonMtdValue > 0 ? "emerald" : "muted"}
          className="hidden lg:flex"
          tooltipText="Total ₹ value of leads won this month"
        />
      </div>

      {/* Row 2 — Pipeline pulse.
          Stacked horizontal bar. Width per segment ∝ count.
          On desktop a legend appears below so users can read stage labels
          without hovering. */}
      {pulseTotal > 0 ? (
        <div>
          <div
            className="flex h-2.5 rounded-full overflow-hidden border border-hairline bg-paper-2"
            role="img"
            aria-label="Pipeline distribution by stage"
          >
            {ACTIVE_STAGES.map((stage) => {
              const { count, value } = stageStats[stage];
              if (count === 0) return null;
              const pct = (value / pulseTotal) * 100;
              const isDimmed = activeStages.length > 0 && !activeStages.includes(stage);
              return (
                <Tooltip key={stage}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => onToggleStage(stage)}
                      className={cn(
                        "h-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:opacity-80",
                        STAGE_META[stage].segment,
                        isDimmed && "opacity-25",
                      )}
                      style={{ width: `${pct}%` }}
                      aria-label={`${STAGE_META[stage].label}: ${count} leads · ${rupee(value, { compact: true })} (${pct.toFixed(0)}%)`}
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    {STAGE_META[stage].label}: {count} lead{count === 1 ? "" : "s"} · {rupee(value, { compact: true })} · {pct.toFixed(0)}%
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
          {/* Legend — desktop only. Each entry is itself a filter toggle so
              users who can't reach a thin segment can click the label.
              Shows count + ₹ value so reps can see both signals at a glance. */}
          <div className="hidden md:flex items-center gap-4 mt-1.5 flex-wrap">
            {ACTIVE_STAGES.map((stage) => {
              const { count, value } = stageStats[stage];
              if (count === 0) return null;
              const isDimmed = activeStages.length > 0 && !activeStages.includes(stage);
              return (
                <button
                  key={stage}
                  type="button"
                  onClick={() => onToggleStage(stage)}
                  className={cn(
                    "inline-flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink transition-colors",
                    isDimmed && "opacity-50",
                  )}
                >
                  <span className={cn("w-1.5 h-1.5 rounded-full", STAGE_META[stage].dot)} />
                  <span className="uppercase tracking-wider font-semibold">{STAGE_META[stage].label}</span>
                  <span className="tabular-nums">{count}</span>
                  <span className="tabular-nums text-ink-2 font-semibold">{rupee(value, { compact: true })}</span>
                </button>
              );
            })}
            {/* Total ₹ pipeline at the end of the legend. Shows aggregate value
                across all visible stages — useful at a glance for owners. */}
            {pulseTotal > totalCount && (
              <span className="inline-flex items-center gap-1.5 text-xs text-ink-3 ml-auto">
                <span>Total</span>
                <span className="font-serif text-ink tabular-nums text-sm">{rupee(pulseTotal, { compact: true })}</span>
              </span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ============================================================
// KPI pill — small card with icon, label, big number
// ============================================================
type KpiTone = "muted" | "amber" | "amber-soft" | "rose" | "emerald";

interface KpiPillProps {
  icon: string;
  label: string;
  value: number;
  tone: KpiTone;
  active?: boolean;
  className?: string;
  formatAs?: "number" | "currency";
  onClick?: () => void;
  tooltipText?: string;
}

function KpiPill({
  icon, label, value, tone, active, className, formatAs, onClick, tooltipText,
}: KpiPillProps) {
  const wrapper: Record<KpiTone, string> = {
    muted:        "bg-paper-2 border-hairline text-ink",
    amber:        "bg-amber text-paper border-amber/0 shadow-md shadow-amber/20",
    "amber-soft": "bg-amber-soft border-amber/30 text-amber-ink",
    rose:         "bg-rose/10 border-rose/30 text-rose",
    emerald:      "bg-emerald-soft border-emerald/30 text-emerald",
  };
  const iconColor: Record<KpiTone, string> = {
    muted:        "text-ink-3",
    amber:        "text-paper",
    "amber-soft": "text-amber-ink",
    rose:         "text-rose",
    emerald:      "text-emerald",
  };

  const inner = (
    <>
      <div className="flex items-center gap-1 text-3xs uppercase tracking-wider font-semibold opacity-80">
        <Icon name={icon} size={11} className={iconColor[tone]} />
        {label}
      </div>
      <div className="font-serif text-xl md:text-2xl tabular-nums leading-tight">
        {formatAs === "currency" ? rupee(value, { compact: true }) : value}
      </div>
    </>
  );

  // Active-state focus ring stands out without needing to change colours.
  const baseClass = cn(
    "px-3 py-2 rounded-lg border text-left transition-all flex flex-col gap-0.5",
    wrapper[tone],
    active && "ring-2 ring-offset-2 ring-amber ring-offset-paper",
    onClick && "hover:brightness-105 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2",
    className,
  );

  const content = onClick ? (
    <button type="button" onClick={onClick} className={baseClass}>
      {inner}
    </button>
  ) : (
    <div className={baseClass}>{inner}</div>
  );

  if (!tooltipText) return content;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  );
}
