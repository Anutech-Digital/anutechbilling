/**
 * LeadsSmartViews — horizontal chip bar with saved filter views.
 *
 * Replaces the "list of leads" mental model with a "list of work modes."
 * Pattern stolen from Close.com + Attio + HubSpot's smart views.
 *
 * Each view is a saved filter combo. Reps tap a chip → list re-filters
 * to match. Counts shown on each chip give an at-a-glance pipeline read.
 *
 * Built-in views (v1):
 *   • All        — every lead
 *   • Mine       — leads owned by current user
 *   • Today      — leads that ARRIVED today (created today) — new inbound
 *   • Hot        — demo / trial / quote stage
 *   • New        — stage = new
 *   • Won MTD    — won leads created this month (₹ chip)
 *
 * Custom user-saved views (v2 — localStorage) deferred to a follow-up
 * task. v1 ships the 6 built-ins which cover ~80% of rep workflows.
 *
 * @example
 *   <LeadsSmartViews
 *     leads={leads}
 *     currentUserId={me.userId}
 *     active={view}
 *     onChange={setView}
 *   />
 */
"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { isHotLead } from "@/lib/leads/heat";
import type { Lead } from "@/lib/supabase/database.types";

export type SmartView = "all" | "mine" | "today" | "overdue" | "hot" | "new" | "won-mtd" | "duplicates" | "junk";

interface LeadsSmartViewsProps {
  leads: Lead[];
  /** Current user's UUID — used to compute "Mine" count. */
  currentUserId?: string;
  /** Count of leads flagged as likely duplicates (computed on the page). The
   *  Duplicates chip only appears when this is > 0 — no noise when clean. */
  duplicateCount?: number;
  /** Count of leads marked junk. Junk chip shows when > 0 (or suspects exist). */
  junkCount?: number;
  /** Count of NON-junk leads the heuristic suspects as junk — nudges review. */
  junkSuspectCount?: number;
  active: SmartView;
  onChange: (view: SmartView) => void;
}

export function LeadsSmartViews({ leads, currentUserId, duplicateCount = 0, junkCount = 0, junkSuspectCount = 0, active, onChange }: LeadsSmartViewsProps) {
  const today = new Date().toISOString().slice(0, 10);

  // ── Compute counts for each view ──────────────────────────
  // Working views never count junk — it lives only under the Junk chip.
  const working  = leads.filter((l) => !l.is_junk);
  const all      = working.length;
  const mine     = currentUserId ? working.filter((l) => l.owner_id === currentUserId).length : 0;
  // Count leads that ARRIVED today (created today) — matches the
  // operator's mental model of "what came in today?". Follow-up due
  // belongs to the Overdue KPI in the insight band, not here.
  const todayDue = working.filter((l) => l.created_at?.slice(0, 10) === today).length;
  // Overdue = follow-up date in the past, still open (not won/lost). The most
  // actionable bucket for a rep — surfaced as its own chip (was a separate KPI row).
  const overdue  = working.filter((l) => l.follow_up_date && l.follow_up_date < today && l.stage !== "won" && l.stage !== "lost").length;
  // "Hot" = priority high OR late-funnel stage — same isHotLead the row tags use,
  // so the chip count always matches the number of Hot-tagged rows.
  const hot      = working.filter(isHotLead).length;
  const newCt    = working.filter((l) => l.stage === "new").length;

  return (
    <div className="mb-4 flex items-center gap-2 overflow-x-auto pb-1">
      {/* Eyebrow label — sets context for the chip row */}
      <div className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-ink-3 shrink-0 pr-1.5">
        <Icon name="eye" size={11} className="text-ink-3" />
        Views
      </div>

      <ViewChip label="All"        count={all}      active={active === "all"}      onClick={() => onChange("all")} />
      {currentUserId && (
        <ViewChip label="Mine"     count={mine}     active={active === "mine"}     onClick={() => onChange("mine")} />
      )}
      <ViewChip label="Today"      count={todayDue} active={active === "today"}    onClick={() => onChange("today")} tone="amber" />
      <ViewChip label="Overdue"    count={overdue}  active={active === "overdue"}  onClick={() => onChange("overdue")} tone="rose" />
      <ViewChip label="Hot"        count={hot}      active={active === "hot"}      onClick={() => onChange("hot")} />
      <ViewChip label="New"        count={newCt}    active={active === "new"}      onClick={() => onChange("new")} />
      {duplicateCount > 0 && (
        <ViewChip label="Duplicates" count={duplicateCount} active={active === "duplicates"} onClick={() => onChange("duplicates")} tone="rose" />
      )}
      {/* Junk — shows once there's junk OR the heuristic suspects some, so the
          operator can clean the inbox. Count = marked junk. */}
      {(junkCount > 0 || junkSuspectCount > 0) && (
        <ViewChip
          label={junkSuspectCount > 0 && junkCount === 0 ? `Junk · ${junkSuspectCount} to review` : "Junk"}
          count={junkCount > 0 ? junkCount : undefined}
          active={active === "junk"}
          onClick={() => onChange("junk")}
          tone="rose"
        />
      )}
    </div>
  );
}

interface ViewChipProps {
  label: string;
  /** Numeric count badge (e.g., 12 leads). Mutually exclusive with valueChip. */
  count?: number;
  /** Pre-formatted value badge (e.g., "₹2.5 L"). Use for monetary views. */
  valueChip?: string;
  active?: boolean;
  tone?: "default" | "amber" | "emerald" | "rose";
  onClick: () => void;
}

function ViewChip({ label, count, valueChip, active, tone = "default", onClick }: ViewChipProps) {
  // Inactive chips stay neutral; the active chip picks up an amber bg so
  // the user always knows which view they're looking at.
  const baseToneClass = active
    ? "bg-amber text-paper border-amber/0 shadow-sm shadow-amber/30"
    : tone === "amber"
    ? "bg-amber-soft border-amber/30 text-amber-ink hover:bg-amber-soft/70"
    : tone === "emerald"
    ? "bg-emerald-soft border-emerald/30 text-emerald hover:bg-emerald-soft/70"
    : tone === "rose"
    ? "bg-rose-soft border-rose/30 text-rose hover:bg-rose-soft/70"
    : "bg-paper border-hairline text-ink-2 hover:bg-paper-2";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 shrink-0",
        "px-3 py-1 rounded-full border text-xs font-medium",
        "transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2",
        baseToneClass,
      )}
    >
      {label}
      {count !== undefined && (
        <span className="text-[10px] tabular-nums opacity-80">{count}</span>
      )}
      {valueChip && (
        <span className="text-[10px] tabular-nums font-semibold">{valueChip}</span>
      )}
    </button>
  );
}
