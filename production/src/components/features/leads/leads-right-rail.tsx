/**
 * LeadsRightRail — desktop-only 320px insight rail.
 *
 * Shown on the Leads / Deals page on viewports ≥ 1280px (xl: breakpoint).
 * Fills the empty right side of the screen with actionable rep-focused
 * content so a wide monitor isn't 60% whitespace.
 *
 * Sections (top to bottom, all conditionally shown only when data exists):
 *   1. Today's plan        — leads with follow_up_date ≤ today
 *   2. Top hot leads       — top 3 by ₹ in quote / trial / demo stage
 *   3. Smart suggestions   — stale leads, missing follow-ups
 *   4. Empty-state pitch   — "Get started" CTA if no leads at all
 *
 * Each section is self-quiescent — if its data is empty it just doesn't
 * render. So with active leads + hot opportunities + stale rows the rail
 * fills up; with a brand-new tenant it's mostly an empty-state CTA.
 *
 * All tap targets emit through callback props — the rail itself doesn't
 * mutate state. Parent (leads/page) owns the routing + drawer-open logic.
 *
 * @example
 *   <LeadsRightRail
 *     leads={leads}
 *     onOpenLead={(l) => setSelected(l)}
 *     onAddLead={() => setAddOpen(true)}
 *     onImportCsv={() => setCsvImportOpen(true)}
 *   />
 */
"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { rupee, cn } from "@/lib/utils";
import type { Lead } from "@/lib/supabase/database.types";
import { istToday } from "@/lib/dates/ist";
import { leadTitle } from "@/lib/leads/display-name";

interface LeadsRightRailProps {
  leads: Lead[];
  onOpenLead: (lead: Lead) => void;
  onAddLead: () => void;
  onImportCsv?: () => void;
  /**
   * Layout mode.
   *   "side" (default) — vertical sticky aside on the right (xl+).
   *   "below"          — horizontal band below the table (md-lg).
   *
   * Pages typically mount this twice — once in each mode with mutually
   * exclusive visibility classes so the same content fills empty space
   * at every viewport without duplicating data fetches.
   */
  orientation?: "side" | "below";
  /** Additional CSS classes — primarily used by the caller to apply
   *  visibility rules (e.g., `hidden md:block xl:hidden`). */
  className?: string;
}

const STAGE_LABEL: Record<Lead["stage"], string> = {
  new: "New", contact: "Contacted", demo: "Demo", trial: "Trial",
  quote: "Quote", won: "Won", lost: "Lost",
};

export function LeadsRightRail({
  leads, onOpenLead, onAddLead, onImportCsv,
  orientation = "side",
  className,
}: LeadsRightRailProps) {
  const isBelow = orientation === "below";
  const today = istToday();
  const open  = leads.filter((l) => l.stage !== "won" && l.stage !== "lost");

  // ── Today's plan ─────────────────────────────────────
  // Anything due TODAY or earlier (overdue). Sorted overdue-first so the
  // most-neglected leads bubble to the top of the rep's worklist.
  const todaysPlan = open
    .filter((l) => l.follow_up_date && l.follow_up_date <= today)
    .sort((a, b) => (a.follow_up_date ?? "").localeCompare(b.follow_up_date ?? ""))
    .slice(0, 5);

  // ── Top hot leads ────────────────────────────────────
  // High-intent stages, sorted by ₹ value (biggest first).
  const hotLeads = leads
    .filter((l) => l.stage === "demo" || l.stage === "trial" || l.stage === "quote")
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, 3);

  // ── Smart suggestions ───────────────────────────────
  const noFollowUp = open.filter((l) => !l.follow_up_date).length;
  // "Stale" = updated_at > 14 days ago. Using updated_at not created_at
  // catches leads we've been ignoring even if they were touched once.
  const staleLeads = open.filter((l) => {
    const days = (Date.now() - new Date(l.updated_at).getTime()) / 86_400_000;
    return days > 14;
  }).length;

  // ── Empty state ─────────────────────────────────────
  const isEmpty = leads.length === 0;

  return (
    <aside
      className={cn(
        isBelow
          ? // ── Horizontal band below table — fills empty vertical space
            //    at md-lg viewports. Sections render in a grid. No outer
            //    container bg/border — let cards float on page bg so
            //    empty space inside doesn't look like a "broken box".
            "mt-6 w-full"
          : // ── Vertical aside on the right — xl+ desktop.
            //    Positioned `fixed` to the right edge of the viewport from
            //    top-14 (below the global top bar). This way the rail is
            //    visible from page load — independent of how much content
            //    sits above the flex split (KPI strip, pipeline pulse,
            //    lead intelligence card, etc.). The page wrapper adds
            //    `xl:pr-[336px]` so main content doesn't slide under.
            //
            //    Earlier approaches:
            //    • sticky top-14 h-[calc(100vh-3.5rem)] — natural y was
            //      ~516px (after KPI etc.), so rail clipped at viewport
            //      bottom and never "stuck" because parent had no scroll.
            //    • h-full — rail shrank to parent's leftover height
            //      (~126px) because parent was tight from overflow-hidden.
            //    Fixed-positioning is the only robust solution.
            cn(
              "w-80",
              "fixed right-0 top-14 z-10",
              "border-l border-hairline bg-paper-2/40",
              "p-5 overflow-y-auto",
              "h-[calc(100vh-3.5rem)]",
            ),
        // Section spacing — when below, sections are in a grid; when side,
        // they stack vertically.
        isBelow ? "" : "space-y-6",
        className,
      )}
      aria-label="Lead insights"
    >
      {/* ─── Empty state — first-time pitch ─── */}
      {isEmpty && (
        <div className="text-center pt-8">
          <Icon name="target" size={32} className="text-amber mx-auto mb-3" />
          <h3 className="font-serif text-lg text-ink mb-1">Add your first lead</h3>
          <p className="text-xs text-ink-3 leading-relaxed mb-4">
            Start by adding a lead manually or import a batch from CSV.
            They'll appear in this list and the daily worklist.
          </p>
          <div className="space-y-2">
            <Button variant="primary" icon="plus" onClick={onAddLead} className="w-full justify-center">
              Add lead manually
            </Button>
            {onImportCsv && (
              <Button icon="download" onClick={onImportCsv} className="w-full justify-center">
                Import CSV
              </Button>
            )}
          </div>
        </div>
      )}

      {/* ─── Data sections — grid in "below" mode (side-by-side at md+),
            stacked vertically in "side" mode (default for xl+). ─── */}
      <div className={cn(
        isBelow
          ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5"
          : "space-y-6",
      )}>
      {/* ─── Today's plan ─── */}
      {!isEmpty && todaysPlan.length > 0 && (
        <Section
          title="Today's plan"
          icon="clock"
          count={todaysPlan.length}
          countTone="amber"
        >
          <ul className="space-y-1.5">
            {todaysPlan.map((l) => {
              const isOverdue = l.follow_up_date && l.follow_up_date < today;
              return (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => onOpenLead(l)}
                    className="w-full text-left p-2 rounded-md hover:bg-paper transition-colors group"
                  >
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <div className="font-medium text-sm text-ink truncate flex-1" title={leadTitle(l).hint ?? undefined}>
                        {leadTitle(l).label}
                      </div>
                      <Badge
                        kind={isOverdue ? "danger" : "warning"}
                        size="sm"
                      >
                        {isOverdue ? "Overdue" : "Today"}
                      </Badge>
                    </div>
                    {/* R-279: when the title already IS the contact's name, show only the phone. */}
                    {l.contact_name && (
                      <div className="text-xs text-ink-3 truncate mt-0.5 group-hover:text-ink-2">
                        {[leadTitle(l).source === "contact" ? null : l.contact_name, l.contact_phone].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {/* ─── Top hot leads ─── */}
      {!isEmpty && hotLeads.length > 0 && (
        <Section title="Top hot leads" icon="zap">
          <ul className="space-y-1.5">
            {hotLeads.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => onOpenLead(l)}
                  className="w-full text-left p-2 rounded-md hover:bg-paper transition-colors"
                >
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <div className="font-medium text-sm text-ink truncate flex-1" title={leadTitle(l).hint ?? undefined}>
                      {leadTitle(l).label}
                    </div>
                    <span className="font-serif text-sm text-ink tabular-nums shrink-0">
                      {l.value ? rupee(l.value, { compact: true }) : "—"}
                    </span>
                  </div>
                  <div className="text-xs text-ink-3 mt-0.5 inline-flex items-center gap-1.5">
                    <span className="capitalize">{STAGE_LABEL[l.stage]}</span>
                    {l.seats && <span>· {l.seats} seats</span>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* ─── Smart suggestions ─── */}
      {!isEmpty && (noFollowUp > 0 || staleLeads > 0) && (
        <Section title="Needs attention" icon="alert">
          <ul className="space-y-1.5">
            {noFollowUp > 0 && (
              <li className="p-2 rounded-md bg-paper border border-hairline">
                <div className="text-sm text-ink font-medium">
                  {noFollowUp} lead{noFollowUp === 1 ? "" : "s"} without a follow-up date
                </div>
                <p className="text-xs text-ink-3 mt-0.5 leading-snug">
                  Schedule one so they don't fall through the cracks.
                </p>
              </li>
            )}
            {staleLeads > 0 && (
              <li className="p-2 rounded-md bg-paper border border-hairline">
                <div className="text-sm text-ink font-medium">
                  {staleLeads} stale lead{staleLeads === 1 ? "" : "s"} (14+ days no activity)
                </div>
                <p className="text-xs text-ink-3 mt-0.5 leading-snug">
                  Touch base or mark lost to clean the pipeline.
                </p>
              </li>
            )}
          </ul>
        </Section>
      )}
      {/* ─── Quick actions — ALWAYS renders (no data dependency).
            Gives the rep one-tap shortcuts to capture more leads and
            ensures the rail always has visible content even when other
            sections are empty (sparse data fills the page nonetheless). */}
      {!isEmpty && (
        <Section title="Quick actions" icon="zap">
          <div className="grid grid-cols-2 gap-2">
            <ActionTile icon="plus"     label="Add lead"      onClick={onAddLead} />
            <ActionTile icon="zap"      label="Quick add"     onClick={onAddLead} tone="amber-soft" />
            {onImportCsv && (
              <ActionTile icon="download" label="Import CSV"  onClick={onImportCsv} />
            )}
            <ActionTile icon="user"     label="View contacts" onClick={onAddLead} />
          </div>
        </Section>
      )}
      </div>{/* /data sections grid */}
    </aside>
  );
}

// ============================================================
// ActionTile — compact tap-target for Quick actions section.
// Square-ish tile with icon on top + label below. 2x2 grid friendly.
// ============================================================
function ActionTile({
  icon, label, onClick, tone = "default",
}: {
  icon: string;
  label: string;
  onClick: () => void;
  tone?: "default" | "amber-soft";
}) {
  const toneClass = tone === "amber-soft"
    ? "bg-amber-soft border-amber/30 text-amber-ink hover:bg-amber-soft/70"
    : "bg-paper border-hairline text-ink hover:bg-paper-2";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "p-2.5 rounded-md border text-left transition-colors min-h-[64px]",
        "flex flex-col items-start gap-1",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2",
        toneClass,
      )}
    >
      <Icon name={icon} size={14} className={tone === "amber-soft" ? "text-amber-ink" : "text-amber"} />
      <span className="text-xs font-semibold leading-tight">{label}</span>
    </button>
  );
}

// ============================================================
// Section header — small uppercase title + count chip
// ============================================================
function Section({
  title, icon, count, countTone, children,
}: {
  title: string;
  icon: string;
  count?: number;
  countTone?: "amber" | "muted";
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-3xs uppercase font-semibold text-ink-3 tracking-[0.1em] mb-2 inline-flex items-center gap-1.5">
        <Icon name={icon} size={11} className="text-amber" />
        {title}
        {count !== undefined && count > 0 && (
          <span
            className={cn(
              "inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-3xs font-semibold tabular-nums",
              countTone === "amber"
                ? "bg-amber text-paper"
                : "bg-paper-2 text-ink-3 border border-hairline",
            )}
          >
            {count}
          </span>
        )}
      </h3>
      {children}
    </section>
  );
}
