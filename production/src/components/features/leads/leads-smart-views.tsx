/**
 * LeadsSmartViews — saved filter views, as a single dropdown.
 *
 * WAS a horizontal chip bar. On the Sales & Pipeline toolbar it sat in a
 * `flex-1 min-w-0 overflow-x-auto` between the search box and the view/filter
 * buttons, and with up to eight chips competing for what was left, the strip
 * collapsed to showing ONE chip with scroll arrows either side. At that width it
 * was worse than a dropdown in every way: you could not see which views existed,
 * could not read their counts, and had to scrub sideways to find anything.
 *
 * WHAT A NAIVE CONVERSION WOULD BREAK. The counts were the point — the chips
 * existed so a rep could read the pipeline without clicking. Putting them behind
 * a trigger hides exactly the information the component was built to surface.
 *
 * So the trigger is not just a label. It carries:
 *   • the active view and its count, so the current filter is always legible; and
 *   • an OVERDUE badge whenever follow-ups have slipped and you are not already
 *     looking at them. Overdue is the one bucket that is time-critical — a
 *     duplicate can wait a week, a follow-up two days late cannot — so it is the
 *     one number that must survive being collapsed.
 *
 * Views:
 *   All leads (default) · All open · Mine · Today (arrived today) · Overdue · Hot · New
 *   Duplicates and Junk appear only when they have something in them.
 *
 * S40: the counts come in from lead_counts().views — the server counts the open leads of
 * the workspace with the same rules this file used to run over the whole lead list in the
 * browser (which, past PostgREST's 1000-row cap, was counting only the newest 1000).
 *
 * @example
 *   <LeadsSmartViews counts={counts.views} currentUserId={me.userId} active={view} onChange={setView} />
 */
"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { STAGE_SLA_DAYS } from "@/lib/leads/velocity";
import type { LeadCounts } from "@/lib/leads/list-page";

export type SmartView = "everything" | "all" | "mine" | "waiting" | "today" | "overdue" | "hot" | "new" | "closing" | "stalled" | "won-mtd" | "duplicates" | "junk";

interface LeadsSmartViewsProps {
  /** Counts over the workspace's OPEN leads (lead_counts().views). */
  counts: LeadCounts["views"];
  /** Current user's UUID — used to compute "Mine" count. */
  currentUserId?: string;
  /** Count of leads flagged as likely duplicates (computed on the page). The
   *  Duplicates entry only appears when this is > 0 — no noise when clean. */
  duplicateCount?: number;
  /** Every non-junk lead, won and lost included — the "All leads" count. */
  everythingCount?: number;
  /** /deals holds only deals (quote → won / lost): its first entry says "Saari deals", and
   *  "New" is not offered — no New lead is on that page. */
  isDealsPage?: boolean;
  /** Count of leads marked junk. Junk shows when > 0 (or suspects exist). */
  junkCount?: number;
  /** Count of NON-junk leads the heuristic suspects as junk — nudges review. */
  junkSuspectCount?: number;
  active: SmartView;
  onChange: (view: SmartView) => void;
  /* ─── THE STAGE FOLDERS LIVE HERE NOW ────────────────────────────────────
     They were a strip of eight chips above this control: a whole band of the page,
     and two of them — All open and Junk — repeated rows this menu already had, a few
     centimetres apart. Pardeep asked for the row to go into the view.

     Only the six the menu did NOT already carry come across. All open stays the `all`
     view and Junk stays in the cleanup group, so the merge removes the duplication
     rather than moving it. */
  folders?: readonly FolderRow[];
  /** The folder in force, or "all". Separate state from `active`, on purpose. */
  activeFolder?: string;
  onFolder?: (id: string) => void;
}

type Tone = "default" | "amber" | "rose";

/** A stage folder, shaped for the same row renderer the views use. */
export interface FolderRow {
  id: string;
  label: string;
  count: number;
  hint: string;
}

interface ViewDef {
  id: SmartView;
  label: string;
  count?: number;
  tone: Tone;
  /** One line explaining what the view holds — shown under the label. */
  hint: string;
}

export function LeadsSmartViews({
  counts, currentUserId, everythingCount, isDealsPage = false, duplicateCount = 0, junkCount = 0, junkSuspectCount = 0, active, onChange,
  folders = [], activeFolder = "all", onFolder,
}: LeadsSmartViewsProps) {
  // ── Counts (server — lead_counts().views, S40) ────────────────────────────
  // Working views never count junk — it lives only under the Junk view. The rules each
  // count uses are the list's own (list-selectors.ts#searchLeads), run in SQL:
  //   • Today = ARRIVED today (the IST date it was created); follow-up due is Overdue's.
  //   • Waiting = the AI sales agent stopped and asked for a person — the flag the agent
  //     itself sets, so this number IS the queue. (Until 24 Aug 2026 nothing read that
  //     flag; a handover nobody can see is a handover that did not happen.)
  //   • Overdue = follow-up date in the past, still open — the most actionable bucket,
  //     which is why it also shows on the trigger.
  //   • Hot = priority high OR late-funnel stage (heat.ts#isHotLead), as the row tags.
  //   • Stalled = open and in the same stage past the SLA; deals with no recorded
  //     stage-change date are NOT counted (updated_at bumps on any edit).
  //   • Closing = expected close on or before the IST month end; undated deals excluded.
  const all       = counts.all;
  const mine      = currentUserId ? counts.mine : 0;
  const waiting   = counts.waiting;
  const todayDue  = counts.today;
  const overdue   = counts.overdue;
  const hot       = counts.hot;
  const newCt     = counts.new;
  const stalledCt = counts.stalled;
  const closingCt = counts.closing;

  const views: ViewDef[] = [
    /* Labelled "All open", not "All", and the hint says what is missing.
       This chip is fed `leadsForTab`, which is `workspaceLeads.filter(isOpenLead)` — so it
       never held won or lost leads, while the label said "All" and the hint said
       "Everything except junk". On 21 Aug that cost real confusion: 19 leads exist, this
       read 17, and the owner reasonably concluded two had disappeared. They were the two
       `won` deals, sitting in the Won folder, which the chip strip had scrolled out of
       view. The data was right and the word was wrong, which is the harder bug to see. */
    /* The page opens here (26 Sep 2026, Pardeep: "by default saari leads show honi
       chahiye"). With one deal just moved to Won, "All open" showed an empty page with
       "No leads match" — every lead existed, the default view simply hid it. */
    { id: "everything", label: isDealsPage ? "All deals" : "All leads", count: everythingCount ?? all, tone: "default",
      hint: isDealsPage
        ? "Every deal, Quote Sent to Won and Lost"
        : "New, Contacted and Lost — not junk. Quoted leads are on Deals." },
    { id: "all",   label: "All open", count: all,     tone: "default",
      hint: "Every open lead. Won and lost are not open — they have their own folders." },
    ...(currentUserId
      ? [{ id: "mine" as SmartView, label: "Mine", count: mine, tone: "default" as Tone, hint: "Assigned to you" }]
      : []),
    /* Placed straight after Mine and toned ROSE, above Today and Overdue. It is the only
       bucket where a CUSTOMER is already waiting on us and the machine has stopped: an
       overdue follow-up is late, this is unanswered. Shown only when it has something in
       it, like Duplicates and Junk — an empty accusing chip trains people to ignore it. */
    ...(waiting > 0
      ? [{ id: "waiting" as SmartView, label: "Waiting on you", count: waiting, tone: "rose" as Tone,
           hint: "The AI stopped and asked for a person — open the lead to see why" }]
      : []),
    { id: "today", label: "Today",   count: todayDue, tone: "amber",   hint: "Arrived today" },
    { id: "overdue", label: "Overdue", count: overdue, tone: "rose",   hint: "Follow-up date has passed" },
    { id: "hot",   label: "Hot",     count: hot,      tone: "default", hint: "High priority or late-stage" },
    ...(isDealsPage ? [] : [{ id: "new" as SmartView, label: "New", count: newCt, tone: "default" as Tone, hint: "Not contacted yet" }]),
    /* Closing this month — the forecast cut. Deliberately EXCLUDES deals with no
       expected close date: "closing this month" is a claim, and a deal nobody has dated
       has not made it. Those show up as "undated" in the KPI strip instead. */
    { id: "stalled", label: "Stalled", count: stalledCt, tone: "rose",
      hint: `No stage movement for ${STAGE_SLA_DAYS}+ days — needs a nudge` },
    { id: "closing", label: "Closing this month", count: closingCt, tone: "amber",
      hint: "Expected to close on or before month end — undated deals are not counted" },
  ];

  // Cleanup views — present only when there is something to clean, so the menu
  // stays short on a tidy pipeline.
  const cleanup: ViewDef[] = [];
  if (duplicateCount > 0) {
    cleanup.push({ id: "duplicates", label: "Duplicates", count: duplicateCount, tone: "rose", hint: "Same company or contact twice" });
  }
  if (junkCount > 0 || junkSuspectCount > 0) {
    cleanup.push({
      id: "junk",
      label: "Junk",
      count: junkCount > 0 ? junkCount : undefined,
      tone: "rose",
      hint: junkSuspectCount > 0 && junkCount === 0 ? `${junkSuspectCount} suspected — review` : "Marked as junk",
    });
  }

  const activeDef = [...views, ...cleanup].find((v) => v.id === active);
  /* Views the page can be opened on (a dashboard tile, R-118) but this menu does not list
     say what they are — "Custom view" over four won deals told the owner nothing. */
  const UNLISTED: Partial<Record<SmartView, string>> = { "won-mtd": "Won this month" };
  const activeLabel = activeDef?.label ?? UNLISTED[active] ?? "Custom view";
  /* A folder in force is what the list is showing, so it is what the trigger says.
     Otherwise the control reads "All open" over a list of six Quote Sent leads. */
  const activeFolderRow = folders.find((f) => f.id === activeFolder);
  const triggerLabel = activeFolderRow?.label ?? activeLabel;
  const triggerCount = activeFolderRow?.count ?? activeDef?.count;
  const narrowed = active !== "everything" || activeFolder !== "all";

  // The signal that must not be lost to the collapse. Suppressed while the user
  // is already in Overdue — telling someone what they are looking at is noise.
  const showOverdueAlert = overdue > 0 && active !== "overdue";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* "outline" once a view is applied, so a filtered pipeline is visibly
            filtered from across the room — the old chip bar signalled that with
            an amber active chip, and losing it would let someone read a filtered
            list as the whole pipeline. */}
        <Button size="sm" variant={narrowed ? "outline" : "ghost"} className="shrink-0">
          <Icon name="eye" size={13} className="text-ink-3" />
          {/* ─── "View:" IS LOAD-BEARING, NOT DECORATION ────────────────────────
              This trigger and the folder chip on the leads page both said "All open", a few
              centimetres apart, so which one governed the list was a guess. The chip keeps its
              bare label — it sits in a row of folders with an inbox icon, which says what it is —
              and the scope goes here, on the control whose whole job is choosing a view.
              Hidden below `sm` because the label is already tight on a phone and the eye icon
              carries the same meaning there.
              1 Oct 2026 (Pardeep, plain-English UI pass): the "View:" text was dropped
              at every width — the eye icon now carries the scope everywhere. */}
          <span className="font-medium">{triggerLabel}</span>
          {triggerCount !== undefined && (
            <span className="text-xs tabular-nums opacity-70">{triggerCount}</span>
          )}
          {showOverdueAlert && (
            <span
              className="ml-0.5 inline-flex items-center gap-1 rounded-full bg-rose-soft px-1.5 py-0.5 text-3xs font-semibold text-rose-ink tabular-nums"
              title={`${overdue} lead${overdue === 1 ? "" : "s"} past their follow-up date`}
            >
              {overdue} overdue
            </span>
          )}
          <Icon name="chevron_down" size={12} className="text-ink-3" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        {folders.length > 0 && onFolder && (
          <>
            <DropdownMenuLabel className="text-3xs uppercase tracking-wider text-ink-3">
              Folders — every open lead is in exactly one
            </DropdownMenuLabel>
            {folders.map((f) => (
              <ViewRow
                key={f.id}
                view={{ label: f.label, count: f.count, tone: "default", hint: f.hint }}
                active={f.id === activeFolder}
                onSelect={() => onFolder(f.id)}
              />
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel className="text-3xs uppercase tracking-wider text-ink-3">
          Views
        </DropdownMenuLabel>
        {views.map((v) => (
          <ViewRow key={v.id} view={v} active={v.id === active} onSelect={() => onChange(v.id)} />
        ))}
        {cleanup.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-3xs uppercase tracking-wider text-ink-3">
              Needs cleanup
            </DropdownMenuLabel>
            {cleanup.map((v) => (
              <ViewRow key={v.id} view={v} active={v.id === active} onSelect={() => onChange(v.id)} />
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ViewRow({ view, active, onSelect }: { view: Omit<ViewDef, "id">; active: boolean; onSelect: () => void }) {
  // Zero is stated rather than hidden: "Overdue 0" is a useful, reassuring fact,
  // and a row whose count vanishes reads as broken.
  const countTone =
    view.count === 0 ? "text-ink-3"
    : view.tone === "rose" ? "text-rose"
    : view.tone === "amber" ? "text-amber-ink"
    : "text-ink-2";

  return (
    <DropdownMenuItem
      onSelect={onSelect}
      role="menuitemradio"
      aria-checked={active}
      className="gap-2 py-1.5"
    >
      {/* Fixed-width slot so labels line up whether or not a row is checked. */}
      <span className="w-3.5 shrink-0">
        {active && <Icon name="check" size={13} className="text-amber" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-xs", active ? "font-semibold text-ink" : "text-ink-2")}>
          {view.label}
        </span>
        {view.hint ? (
          <span className="block text-xs text-ink-3">{view.hint}</span>
        ) : null}
      </span>
      {view.count !== undefined && (
        <span className={cn("text-xs font-semibold tabular-nums shrink-0", countTone)}>
          {view.count}
        </span>
      )}
    </DropdownMenuItem>
  );
}
