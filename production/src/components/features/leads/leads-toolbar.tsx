"use client";
/**
 * The Sales & Pipeline toolbar — whose leads, search, views, Kanban/List, Filter and More.
 * Moved verbatim out of (app)/leads/page.tsx (S35, 28 Sep 2026). All state stays in the
 * page; this only draws it.
 *
 * S40: every number here is a server count (lead_counts() — `pool`, `viewCounts`, …); the
 * toolbar no longer receives the lead list. Export CSV fetches the leads when pressed.
 */
import * as React from "react";
import { toast } from "sonner";
import { TeamViewToggle } from "@/components/shared/team-view-toggle";
import { HIERARCHY_ENFORCED_IN_DATABASE } from "@/lib/team/enforcement";
import type { TeamViewMode } from "@/lib/team/visibility";
import type { useTeamTree } from "@/lib/queries/team-tree";
import { LeadsSmartViews, type SmartView } from "@/components/features/leads/leads-smart-views";
import { downloadCSV } from "@/lib/csv";
import { LEADS_CSV_HEADERS, leadsCsvRows } from "@/lib/export/crm-csv";
import { fetchLeadsForExport } from "@/lib/queries/leads";
import { toastError } from "@/lib/errors/toast-error";
import { teamNoteCounts, type LeadCounts } from "@/lib/leads/list-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { Lead } from "@/lib/supabase/database.types";
import type { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import type { SalesFolder } from "@/lib/leads/folders";
import type { StageMeta } from "@/lib/leads/stage-meta";
import { istToday } from "@/lib/dates/ist";
import { UNASSIGNED } from "@/lib/leads/list-selectors";
import { useTeamMembers } from "@/lib/queries/team";
import { sourceFilterOptions, sourceLabel } from "@/lib/leads/lead-sources";
import { DEFAULT_LEAD_SORT, LEAD_SORT_LABELS, LEAD_SORTS, type LeadSort } from "@/lib/leads/lead-sort";

/** R-056: why the Kanban button does nothing on a phone. */
export const KANBAN_MOBILE_HINT = "Kanban needs a larger screen";

type TeamMember = NonNullable<ReturnType<typeof useTeamTree>["data"]>[number];
type Priority = "low" | "medium" | "high";

export interface LeadsToolbarProps {
  /** lead_counts().pool — every lead the caller can see, before any filter. */
  pool: LeadCounts["pool"];
  leadMeMember: TeamMember | null;
  leadTeam: TeamMember[];
  leadTeamMode: TeamViewMode;
  setLeadTeamMode: (m: TeamViewMode) => void;
  search: string;
  setSearch: (v: string) => void;
  /** lead_counts().views — the View menu's counts. */
  viewCounts: LeadCounts["views"];
  everythingCount: number;
  /** /deals: the everything entry reads "Saari deals" and the New view is not offered. */
  isDealsPage?: boolean;
  currentUser: ReturnType<typeof useCurrentUser>["data"];
  duplicateCountForTab: number;
  junkCount: number;
  junkSuspectCount: number;
  smartView: SmartView;
  selectSmartView: (v: SmartView) => void;
  folderRows: { id: string; label: string; count: number; hint: string }[];
  folder: SalesFolder | "all";
  selectFolder: (f: SalesFolder | "all") => void;
  effectiveView: "kanban" | "list";
  setView: (v: "kanban" | "list") => void;
  /** R-056: on a phone the page always shows the list (the board needs width), so the
      Kanban button is shown but unavailable — tapping it explains why instead of doing
      nothing. */
  isMobile?: boolean;
  activeFilterCount: number;
  filterStages: StageMeta[];
  stageFilter: Lead["stage"][];
  setStageFilter: React.Dispatch<React.SetStateAction<Lead["stage"][]>>;
  priorityFilter: Priority[];
  setPriorityFilter: React.Dispatch<React.SetStateAction<Priority[]>>;
  /** "Kiska" — owner ids, or UNASSIGNED; empty = everyone. */
  ownerFilter: string[];
  setOwnerFilter: React.Dispatch<React.SetStateAction<string[]>>;
  /** R-392: canonical source keys (lead-sources.ts); empty = every source. */
  sourceFilter: string[];
  setSourceFilter: React.Dispatch<React.SetStateAction<string[]>>;
  /** R-420: the Sort menu's choice (?sort=) — the list and the Kanban both follow it. */
  leadSort: LeadSort;
  setLeadSort: (s: LeadSort) => void;
  isSales: boolean;
  kpiOpen: boolean;
  setKpiOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setCsvImportOpen: (open: boolean) => void;
  setCampaignOpen: (open: boolean) => void;
  setGoogleImportOpen: (open: boolean) => void;
  setShareOpen: (open: boolean) => void;
}

export function LeadsToolbar({
  pool, leadMeMember, leadTeam, leadTeamMode, setLeadTeamMode, search, setSearch, viewCounts,
  everythingCount, isDealsPage = false, currentUser, duplicateCountForTab, junkCount, junkSuspectCount, smartView,
  selectSmartView, folderRows, folder, selectFolder, effectiveView, setView, isMobile = false, activeFilterCount,
  filterStages, stageFilter, setStageFilter, priorityFilter, setPriorityFilter, ownerFilter, setOwnerFilter, sourceFilter, setSourceFilter, leadSort, setLeadSort, isSales, kpiOpen,
  setKpiOpen, setCsvImportOpen, setCampaignOpen, setGoogleImportOpen, setShareOpen,
}: LeadsToolbarProps) {
  // Names for the "Kiska" filter — the reporting tree (leadTeam) carries ids and roles only.
  const { data: members = [] } = useTeamMembers();
  const meId = currentUser?.userId ?? leadMeMember?.id ?? null;
  /* A source picked from a shared link that this workspace has no lead for still shows
     (count 0), so it can be un-ticked. */
  const sourceOptions = React.useMemo(() => {
    const opts = sourceFilterOptions(pool.by_source);
    const missing = sourceFilter.filter((s) => !opts.some((o) => o.value === s))
      .map((s) => ({ value: s, label: sourceLabel(s), count: 0 }));
    return [...opts, ...missing];
  }, [pool.by_source, sourceFilter]);
  const [exporting, setExporting] = React.useState(false);
  /* Data-portability (audit B7): saari leads, jaisi darj hain. Fetched on the click, in
     pages — the export used to write whatever the page had loaded, which stopped at 1000. */
  const exportCsv = async () => {
    setExporting(true);
    try {
      const rows = await fetchLeadsForExport();
      downloadCSV(`leads-${istToday()}.csv`, [...LEADS_CSV_HEADERS], leadsCsvRows(rows));
      toast.success(`Exported ${rows.length} leads to CSV`);
    } catch (err) {
      toastError(err, { fallback: "Could not export the leads" });
    } finally {
      setExporting(false);
    }
  };
  return (
    <>
    {/* Whose leads. Renders nothing for a rep with no reports — both halves would show
        the same rows, and a control that does nothing teaches people that controls do
        nothing. */}
    <TeamViewToggle
      className="shrink-0 mb-2"
      me={leadMeMember}
      all={leadTeam}
      mode={leadTeamMode}
      onChange={setLeadTeamMode}
      enforcedInDatabase={HIERARCHY_ENFORCED_IN_DATABASE}
      /* Counted BEFORE the toggle narrows anything — the note describes the pool being
         filtered, not the result. Unowned rows show in both halves, so without this the
         note claims "only records assigned to you" over rows assigned to nobody. */
      counts={teamNoteCounts(pool)}
    />

    <div className="shrink-0 mb-3 flex items-center gap-2 flex-wrap">
      <div className="w-full sm:w-auto sm:flex-1 sm:min-w-[180px] sm:max-w-sm">
        <Input aria-label="Search leads & deals"
          prefix={<Icon name="search" size={14} />}
          placeholder="Search leads & deals…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 text-xs"
        />
      </div>

      <LeadsSmartViews
        counts={viewCounts}
        everythingCount={everythingCount}
        isDealsPage={isDealsPage}
        currentUserId={currentUser?.userId}
        duplicateCount={duplicateCountForTab}
        junkCount={junkCount}
        junkSuspectCount={junkSuspectCount}
        active={smartView}
        onChange={selectSmartView}
        folders={folderRows}
        activeFolder={folder}
        onFolder={(id) => selectFolder(id as typeof folder)}
      />

      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        {/* View Switcher: Kanban vs List */}
        <div className="inline-flex rounded-md border border-hairline overflow-hidden">
          <button
            type="button"
            onClick={() => {
              /* R-056: the page forces the list on mobile, so setView("kanban") here was a
                 silent no-op. aria-disabled (not `disabled`) keeps it focusable and tappable
                 — a phone has no hover, so the tap is where the reason gets said. */
              if (isMobile) {
                toast.info(KANBAN_MOBILE_HINT);
                return;
              }
              setView("kanban");
            }}
            aria-pressed={effectiveView === "kanban"}
            aria-disabled={isMobile || undefined}
            className={cn(
              "px-2.5 py-1 text-xs font-medium inline-flex items-center gap-1 transition-colors",
              isMobile
                ? "bg-paper text-ink-3 opacity-60 cursor-not-allowed"
                : effectiveView === "kanban"
                  ? "bg-ink text-paper cursor-pointer"
                  : "bg-paper text-ink-2 hover:bg-paper-2 cursor-pointer"
            )}
            title={isMobile ? KANBAN_MOBILE_HINT : "Kanban view"}
          >
            <Icon name="layout" size={13} /> Kanban
          </button>
          <button
            type="button"
            onClick={() => setView("list")}
            aria-pressed={effectiveView === "list"}
            className={cn(
              "px-2.5 py-1 text-xs font-medium inline-flex items-center gap-1 transition-colors border-l border-hairline cursor-pointer",
              effectiveView === "list" ? "bg-ink text-paper" : "bg-paper text-ink-2 hover:bg-paper-2"
            )}
            title="List view"
          >
            <Icon name="more_h" size={13} /> List
          </button>
        </div>

        {/* Filter Dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button icon="filter" size="sm">
              Filter
              {activeFilterCount > 0 && (
                <span className="ml-1 inline-flex items-center justify-center min-w-[16px] h-[16px] rounded-full bg-amber text-paper text-xs font-semibold px-1">
                  {activeFilterCount}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 max-h-[70vh] overflow-y-auto">
            <DropdownMenuLabel className="text-3xs uppercase tracking-wider text-ink-3">Stage</DropdownMenuLabel>
            {filterStages.map((s) => (
              <DropdownMenuCheckboxItem
                key={s.id}
                checked={stageFilter.includes(s.id)}
                onCheckedChange={(checked) => {
                  setStageFilter((prev) =>
                    checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)
                  );
                }}
                className="text-sm"
              >
                <span className={cn("inline-block w-2 h-2 rounded-full mr-2", s.dot)} />
                {s.label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-3xs uppercase tracking-wider text-ink-3">Priority</DropdownMenuLabel>
            {(["high","medium","low"] as const).map((p) => (
              <DropdownMenuCheckboxItem
                key={p}
                checked={priorityFilter.includes(p)}
                onCheckedChange={(checked) => {
                  setPriorityFilter((prev) =>
                    checked ? [...prev, p] : prev.filter((x) => x !== p)
                  );
                }}
                className="text-sm capitalize"
              >
                <span className={cn("inline-block w-2 h-2 rounded-full mr-2",
                  p === "high"   && "bg-rose",
                  p === "medium" && "bg-amber",
                  p === "low"    && "bg-slate"
                )} />
                {p}
              </DropdownMenuCheckboxItem>
            ))}
            {/* Kiska — only when there is someone besides me to pick. Me first, then the
                team by name, then leads nobody owns. Counts are over every lead you can see
                (lead_counts().pool — server counts, S40). */}
            {members.length > 1 && (
              <>
                <DropdownMenuSeparator />
                {/* R-392: the lead's owner_id IS the person it is assigned to ("Mine" =
                    assigned to you) — so the heading says that, not "Owner". */}
                <DropdownMenuLabel className="text-3xs uppercase tracking-wider text-ink-3">Assigned to</DropdownMenuLabel>
                {[
                  ...(meId ? [{ id: meId, label: "Me" }] : []),
                  ...members
                    .filter((m) => m.id !== meId)
                    .map((m) => ({ id: m.id, label: m.full_name || m.email || "Unknown" }))
                    .sort((a, b) => a.label.localeCompare(b.label)),
                  { id: UNASSIGNED, label: "Unassigned" },
                ].map((o) => {
                  const n = o.id === UNASSIGNED ? pool.unassigned : (pool.by_owner[o.id] ?? 0);
                  return (
                    <DropdownMenuCheckboxItem
                      key={o.id}
                      checked={ownerFilter.includes(o.id)}
                      onCheckedChange={(checked) => {
                        setOwnerFilter((prev) => (checked ? [...prev, o.id] : prev.filter((x) => x !== o.id)));
                      }}
                      className="text-sm"
                    >
                      <span className="flex-1 truncate">{o.label}</span>
                      <span className="ml-2 text-xs text-ink-3 tabular-nums">{n}</span>
                    </DropdownMenuCheckboxItem>
                  );
                })}
              </>
            )}
            {/* R-392: Source — only the sources this workspace's leads carry, labelled,
                with server counts (lead_counts().pool.by_source). Kept in the URL (?source=). */}
            {sourceOptions.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-3xs uppercase tracking-wider text-ink-3">Source</DropdownMenuLabel>
                {sourceOptions.map((o) => (
                  <DropdownMenuCheckboxItem
                    key={o.value}
                    checked={sourceFilter.includes(o.value)}
                    onCheckedChange={(checked) => {
                      setSourceFilter((prev) => (checked ? [...prev, o.value] : prev.filter((x) => x !== o.value)));
                    }}
                    className="text-sm"
                  >
                    <span className="flex-1 truncate">{o.label}</span>
                    <span className="ml-2 text-xs text-ink-3 tabular-nums">{o.count}</span>
                  </DropdownMenuCheckboxItem>
                ))}
              </>
            )}
            {activeFilterCount > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => { setStageFilter([]); setPriorityFilter([]); setOwnerFilter([]); setSourceFilter([]); }}
                  className="text-sm text-rose"
                >
                  Clear all filters
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* R-420: Sort — one choice for the list and the Kanban, kept in the URL (?sort=).
            On a phone the button is the icon alone (plus a dot when it is not the default),
            so the row still fits 375px; the menu names every order. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button icon="sort" size="sm" aria-label={`Sort: ${LEAD_SORT_LABELS[leadSort]}`} title="Sort">
              <span className="hidden sm:inline">{LEAD_SORT_LABELS[leadSort]}</span>
              {leadSort !== DEFAULT_LEAD_SORT && (
                <span aria-hidden className="sm:hidden ml-0.5 inline-block w-1.5 h-1.5 rounded-full bg-amber" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="text-3xs uppercase tracking-wider text-ink-3">Sort by</DropdownMenuLabel>
            {LEAD_SORTS.map((s) => (
              <DropdownMenuCheckboxItem
                key={s}
                checked={leadSort === s}
                onCheckedChange={() => setLeadSort(s)}
                className="text-sm"
              >
                {LEAD_SORT_LABELS[s]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {!isSales && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="default" size="sm" icon="more_h">More</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {/* The numbers that used to sit in a permanent band above every lead: same
                  tiles, one click away instead of always on screen. */}
              <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setKpiOpen((o) => !o)}>
                <Icon name="bar_chart" size={14} /> {kpiOpen ? "Hide the numbers" : "Show the numbers"}
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setCsvImportOpen(true)}>
                <Icon name="download" size={14} className="text-ink-3" /> Import CSV
              </DropdownMenuItem>
              {/* Data-portability (audit B7): saari leads, jaisi darj hain. */}
              <DropdownMenuItem className="gap-2 cursor-pointer" disabled={exporting} onSelect={() => { void exportCsv(); }}>
                <Icon name="upload" size={14} className="text-ink-3" /> {exporting ? "Exporting…" : "Export CSV"}
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setCampaignOpen(true)}>
                <Icon name="send" size={14} className="text-ink-3" /> Send campaign
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setGoogleImportOpen(true)}>
                <Icon name="globe" size={14} className="text-ink-3" /> Import from Google
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setShareOpen(true)}>
                <Icon name="link" size={14} className="text-ink-3" /> Share enquiry form
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
    </>
  );
}
