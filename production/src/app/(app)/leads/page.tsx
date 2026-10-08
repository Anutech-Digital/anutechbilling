/**
 * Leads + Deals — same component drives BOTH /leads and /deals URLs.
 *
 * The split is BY STAGE (lib/leads/page-scope.ts), not by plan:
 *   /leads  → every stage except won (R-057)          — list + board
 *   /deals  → real deals only: quote / demo / trial / won / lost — board + list
 *             (New / Contacted stay on /leads; Deals audit, 30 Sep 2026)
 *
 * The same DB table backs both views — each page sends its own `stages` to
 * list_leads() and lead_counts(), so the rows and the counts agree.
 *
 * Layout (URL-driven):
 *   - Header: page-specific title ("Leads" area = Sales & Pipeline, /deals = Deals)
 *   - Actions: search + view toggle + Filter + advanced + Add
 *   - Kanban: one column per stage this page shows, with drag-drop (deal-rules.ts gate)
 *   - List: sortable table for scanning many at scale
 *   - Detail Sheet on card / row click (shared)
 */
"use client";


import * as React from "react";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { useUrlList } from "@/lib/hooks/use-url-list";
import { LEAD_VIEWS } from "@/lib/navigation/drilldown";
import { useTeamTree } from "@/lib/queries/team-tree";
import { useTeamMembers } from "@/lib/queries/team";
import { idsForMode, type TeamViewMode } from "@/lib/team/visibility";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { toast } from "sonner";
import {
  BOARD_STAGES, fetchMergeCluster, useDueLeads, useLead, useLeadCounts, useLeadsBoard, useLeadsInfinite, useLostLeads,
  type MergeLead,
} from "@/lib/queries/leads";
import { LossReasonsCard } from "@/components/features/leads/loss-reasons-card";
import { useLogLeadActivity } from "@/lib/queries/lead-activities";
import { useChangeLeadStage } from "@/lib/leads/use-change-stage";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import type { SmartView } from "@/components/features/leads/leads-smart-views";
import { PriorityCallQueue } from "@/components/features/leads/priority-call-queue";
import { useLeadOutcome } from "@/lib/leads/use-outcome";
import { useCallLog } from "@/components/features/leads/call-log-dialog";
import { localDateISO } from "@/lib/leads/outcomes";
import { computeDuplicates } from "@/lib/leads/duplicates";
import { SALES_FOLDERS, type SalesFolder } from "@/lib/leads/folders";
import { JunkAIReview } from "@/components/features/leads/junk-ai-review";
import type { Lead } from "@/lib/supabase/database.types";
import type { LeadListFilters, LeadListRow } from "@/lib/leads/list-page";
import { useBreakpoint } from "@/lib/hooks/useBreakpoint";
import { DEAL_STAGES, filterStagesFor } from "@/lib/leads/stage-meta";
import { boardServerTotals, everythingCountForPage, folderShownOnPage, scopeFiltersForPage, stageShownOnPage } from "@/lib/leads/page-scope";
import {
  boardCut, folderForView, inWorkspace, listCut, searchLeads, type SortCol,
} from "@/lib/leads/list-selectors";
import { toastError } from "@/lib/errors/toast-error";
import { LeadListView } from "@/components/features/leads/lead-list-view";
import { LeadDetailSheet } from "@/components/features/leads/lead-detail-sheet";
import { LeadsToolbar } from "@/components/features/leads/leads-toolbar";
import { LeadsKpiDrawer } from "@/components/features/leads/leads-kpi-drawer";
import { LeadsHotCard } from "@/components/features/leads/leads-hot-card";
import { LeadsKanbanBoard } from "@/components/features/leads/leads-kanban-board";
import { LeadsNoResults, LeadsStatusStates } from "@/components/features/leads/leads-empty-states";
import { LeadsHeaderBar } from "@/components/features/leads/leads-header-bar";
import { LeadsPageDialogs } from "@/components/features/leads/leads-page-dialogs";
import { leadQuoteHref } from "@/lib/leads/lead-quote-href";

/* Page parts live in components/features/leads/ and the rules that pick rows in
   lib/leads/list-selectors.ts (S35, 28 Sep 2026 — this file was 5,125 lines). */

/* Brief mark on the row a deep link opened (R-208) — design tokens only, so it follows the theme. */
const JUST_OPENED_ROW = ["ring-2", "ring-inset", "ring-primary", "bg-primary-soft"];

const PRIORITY_IDS = ["low", "medium", "high"] as const;

function LeadsPageInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const pathname     = usePathname();
  const focusLeadId  = searchParams.get("lead");
  /* ?projectQuote=<leadId> opens the project quotation sheet — the one route both the row
     and the drawer use, since the drawer is a separate component. */
  const projectQuoteId = searchParams.get("projectQuote");

  /* S40: nothing on this page loads every lead any more. The list pages through
     list_leads(), every chip and count comes from lead_counts(), and the parts that are not
     the list read small slim queries — see the "Data" block below. A lead the page needs in
     FULL (the drawer, the project quotation) is read on its own, by id. */
  const { data: projectQuoteLead = null } = useLead(projectQuoteId ?? undefined);
  // Every stage change on this page goes through changeStage — it owns the
  // "why was this lost?" prompt so the seven call sites don't each grow their
  // own version. See lib/leads/use-change-stage.ts.
  const { changeStage } = useChangeLeadStage();
  const { data: currentUser } = useCurrentUser();
  // Sales role gets a simplified UI — no Kanban / campaign / trial buttons.
  const isSales = currentUser?.role === "sales";
  // URL-driven mode (after the /leads + /deals split). /deals shows the
  // qualified pipeline; /leads shows raw inbox. No tab bar — each URL is
  // its own page now.
  const isDealsPage = pathname === "/deals";

  /* Filter offers only the stages that can actually appear on THIS page (else
     filtering e.g. "Won" on the raw Leads inbox always yields 0 rows) — lib/leads/stage-meta.ts. */
  const filterStages = filterStagesFor(isDealsPage);


  /* R-349: search + Filter live in the URL (?q=, ?stage=, ?priority=, ?owner=), so a refresh,
     a shared link, or opening a deal and pressing Back keeps the filtered list. */
  const [search, setSearch] = useUrlState("q");
  const [addOpen,         setAddOpen]         = React.useState(false);
  const [quickOpen,       setQuickOpen]       = React.useState(false);
  const [shareOpen,       setShareOpen]       = React.useState(false);
  const [trialOpen,       setTrialOpen]       = React.useState(false);
  const [campaignOpen,    setCampaignOpen]    = React.useState(false);
  const [googleImportOpen, setGoogleImportOpen] = React.useState(false);
  const [csvImportOpen,    setCsvImportOpen]    = React.useState(false);
  // Filter state — multi-select stages + priorities + owner ("Kiska"). Empty array = no
  // filter (show all). Owner joined 29 Sep 2026, once leads had different owners.
  const filterStageIds = React.useMemo(() => filterStages.map((s) => s.id), [filterStages]);
  const [stageFilter,    setStageFilter]    = useUrlList<Lead["stage"]>("stage", filterStageIds);
  const [priorityFilter, setPriorityFilter] = useUrlList<(typeof PRIORITY_IDS)[number]>("priority", PRIORITY_IDS);
  const [ownerFilter,    setOwnerFilter]    = useUrlList("owner");
  /* R-392: Source (canonical keys, lead-sources.ts) — ?source=google-ads. */
  const [sourceFilter,   setSourceFilter]   = useUrlList("source");
  /* R-392: the board searches by the assigned person's name too (the list does it on the
     server) — id → name from the same team list the Filter menu reads. */
  const { data: teamMembers } = useTeamMembers();
  const ownerNames = React.useMemo(
    () => new Map((teamMembers ?? []).filter((m) => m.full_name).map((m) => [m.id, m.full_name as string])),
    [teamMembers],
  );
  // Due-bucket filter driven by the insight band's KPI pills.
  //   today    → follow_up_date === today
  //   overdue  → follow_up_date < today
  //   hot      → stage in [demo, trial, quote]
  //   all      → no constraint
  // Smart view = saved filter combo (HubSpot/Close/Attio pattern). Each
  // chip in <LeadsSmartViews/> sets this. It travels to the server with the
  // other filters (`listFilters` below) — list_leads() and lead_counts() apply it.
  /* Opens on every lead (won and lost included) — see the "All leads" view. */
  /* R-118: the view can come from the URL (?view=won-mtd) so a dashboard tile opens exactly its rows. */
  const [smartView, setSmartView] = useUrlChoice<SmartView>("view", LEAD_VIEWS, "everything");
  // Collapsible "Lead intelligence" banner — remembers the choice so it doesn't
  // eat board space every visit.
  const [tipsOpen, setTipsOpen] = React.useState(true);
  React.useEffect(() => {
    try { if (localStorage.getItem("ros_leads_tips") === "0") setTipsOpen(false); } catch {}
  }, []);
  const toggleTips = () => setTipsOpen((v) => {
    const next = !v;
    try { localStorage.setItem("ros_leads_tips", next ? "1" : "0"); } catch {}
    return next;
  });

  // Auto-open Google import dialog when redirected back from OAuth with the contacts scope.
  // The dialog will then auto-call /api/contacts/google-fetch with the new provider_token.
  React.useEffect(() => {
    if (searchParams.get("google-import") === "1") {
      setGoogleImportOpen(true);
      // Clean the URL so refresh doesn't re-trigger
      router.replace("/leads" as never);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ?action=<id> — driven by the global QuickActionsPanel in the topbar.
  // Lets the panel open a page-local dialog (Quick add / Full add / Import /
  // Send campaign / Start trial) by navigating here with a `?action=` query.
  // After we handle it, we router.replace to wipe the param so a refresh
  // doesn't re-trigger it.
  React.useEffect(() => {
    const action = searchParams.get("action");
    if (!action) return;
    switch (action) {
      case "quick-add":     setQuickOpen(true);        break;
      case "add":           setAddOpen(true);          break;
      case "import-csv":    setCsvImportOpen(true);    break;
      case "import-google": setGoogleImportOpen(true); break;
      case "campaign":      setCampaignOpen(true);     break;
      case "trial":         setTrialOpen(true);        break;
      // today / overdue — no dialog; let the user use the on-page KPI pills.
    }
    // Strip the param so refresh / back-button don't re-trigger.
    router.replace(pathname as never);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  const [selected, setSelected] = React.useState<Pick<Lead, "id"> | null>(null);
  /* R-342: the open drawer is in the URL — ?lead=<id>, and its tab in ?ltab= (the sheet
     owns that one). Opening a quote or task from the drawer and pressing Back used to land
     on /leads with the drawer closed, because nothing on the history entry said which lead
     was open. replaceState (useUrlState, R-272), so opening a lead adds no history entry. */
  const [, setLeadInUrl] = useUrlState("lead");
  const [, setLeadTabInUrl] = useUrlState("ltab");

  /* WHICH lead the drawer is on stays in `selected`; WHAT that lead currently says comes
     from the query. Two different questions, and conflating them is what let the drawer
     show "Stage: New" seconds after moving the same lead to Contacted on the board behind
     it — see the comment at <LeadDetailSheet>. Read by id (useLead, under ["leads", id]), so
     any invalidation of ["leads"] reaches the drawer the same way it reaches the list.
     S40: the list rows are slim now, and the drawer reads notes, trial and attribution
     fields — so the drawer's lead is this one full row, not the list's copy. */
  const { data: selectedFull } = useLead(selected?.id);
  const selectedLive = selected && selectedFull?.id === selected.id ? selectedFull : null;

  /* Call-queue dependencies. runOutcome performs whatever lib/leads/outcomes.ts says a
     chip does — one entry point, so the chips on the queue, the row and the mobile card
     cannot drift apart (the same reason use-change-stage.ts exists). */
  const runOutcome = useLeadOutcome();
  /* Aur `callLog` wo doosra darwaza hai jo isi baat ko poora karta hai: chips ek jaise
     chalein, aur "Call log" har jagah popup khole. */
  const callLog    = useCallLog(runOutcome);
  const queueLog   = useLogLeadActivity();





  const [editingLead, setEditingLead] = React.useState<Lead | null>(null);
  // Row "Follow-up" quick action → opens AddTaskDialog scoped to this lead.
  const [followUpLead, setFollowUpLead] = React.useState<LeadListRow | null>(null);
  const [waLead, setWaLead] = React.useState<LeadListRow | null>(null);
  // Merge-duplicates dialog — holds the cluster (a lead + its matches) to fold.
  const [mergeCluster, setMergeCluster] = React.useState<MergeLead[] | null>(null);

  // Kanban is great for stage flow; list view is needed once you have 50+ leads
  // and want to scan by value/age/owner. Persisted in localStorage so the user's
  // preferred view sticks across sessions.
  // User's preferred view for the DEALS tab. Leads tab always forces list
  // view because Kanban is a stage-flow tool and raw leads (no plan picked)
  // can only logically live in 'new' or 'contacted' — the other 4 columns
  // would always be empty and just clutter the screen.
  const [view, setView] = React.useState<"kanban" | "list">(() => {
    if (typeof window === "undefined") return "kanban";
    return (window.localStorage.getItem("leads-view") as "kanban" | "list") ?? "kanban";
  });
  React.useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem("leads-view", view);
  }, [view]);
  // Sort state for the list view (kanban ignores this)
  /* Default `wait` — "jise action chahiye pehle". Pehle `created` tha (sabse nayi lead
     upar), jiska nateeja ye tha ki teen din se ruki hui lead teesre panne par chali jati
     thi. Research isi ko galat kehti hai: default order me wo cheez pehle honi chahiye
     jispar kaam BAAKI hai. */
  const [sortBy, setSortBy] = React.useState<SortCol>("wait");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");
  const [kpiOpen, setKpiOpen] = React.useState(false);

  // ── Deep-link: open the drawer for the lead in ?lead=<id> ──
  // Runs once when that lead has been looked up and the URL param is present. S40: looked
  // up by id — the lead may be on page 40 of the list, which the page has not loaded.
  /* Which ?lead= id has been handled. An id, not a flag (R-342): ?lead= now STAYS in the
     URL while the drawer is open, and a row click writes it too — so "handled" must mean
     "this lead", or a row click would re-run the deep link (scroll + flash) on itself.
     R-208: a SECOND deep link in the same visit (the next lead saved from Add lead / Quick
     add) is a different id, so it is handled; closing re-arms it for the same id. */
  const deepLinkHandledRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!focusLeadId) deepLinkHandledRef.current = null;
  }, [focusLeadId]);
  /* On /deals a deal opens its own page (/deals/<id>, 30 Sep 2026), so an old-style
     /deals?lead=<id> link — the /today rows use it — goes there instead of the drawer. */
  const deepLinkToPage = isDealsPage && !!focusLeadId;
  const deepLink = useLead(deepLinkToPage ? undefined : (focusLeadId ?? undefined));
  React.useEffect(() => {
    /* No "handled" ref here: under dev StrictMode the first run's navigation can be dropped
       by the remount, and replacing to the same URL twice is harmless. */
    if (!deepLinkToPage || !focusLeadId) return;
    router.replace(`/deals/${encodeURIComponent(focusLeadId)}` as never);
  }, [deepLinkToPage, focusLeadId, router]);
  React.useEffect(() => {
    if (deepLinkToPage) return;
    if (!focusLeadId || deepLinkHandledRef.current === focusLeadId) return;
    if (!deepLink.isFetched) return;

    const match = deepLink.data ?? null;
    deepLinkHandledRef.current = focusLeadId;
    if (!match) {
      toast.error(`Lead ${focusLeadId} not found`);
      setLeadInUrl("");
      return;
    }
    setSelected(match);

    // Scroll the matching card into view so the user can see where it is in the pipeline,
    // and mark it for a few seconds (R-208: a just-saved lead must be findable at a glance).
    setTimeout(() => {
      const row = document.querySelector<HTMLElement>(`[data-lead-id="${CSS.escape(match.id)}"]`);
      if (!row) return;
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.classList.add(...JUST_OPENED_ROW);
      setTimeout(() => row.classList.remove(...JUST_OPENED_ROW), 3000);
    }, 100);

    /* ?lead= is NOT stripped any more (R-342): it is what makes Back and refresh reopen
       this drawer. Closing the drawer clears it (closeLead). */
  }, [deepLinkToPage, focusLeadId, deepLink.isFetched, deepLink.data, setLeadInUrl]);

  /* Opening a row / card / queue item: /leads keeps its quick drawer; /deals opens the
     deal's own page, where its whole history lives (30 Sep 2026). */
  const openLead = React.useCallback((l: Pick<Lead, "id">) => {
    if (isDealsPage) { router.push(`/deals/${encodeURIComponent(l.id)}` as never); return; }
    deepLinkHandledRef.current = l.id;
    setSelected(l);
    setLeadInUrl(l.id);
  }, [isDealsPage, router, setLeadInUrl]);

  /* The real close — X, Esc, overlay, archive, delete. Clears the drawer from the URL.
     Leaving the drawer for ANOTHER page must not call this (R-342): it would wipe ?lead from
     the history entry Back returns to. The sheet pushes without closing for those. */
  const closeLead = React.useCallback(() => {
    deepLinkHandledRef.current = null;
    setSelected(null);
    setLeadInUrl("");
    setLeadTabInUrl("");
  }, [setLeadInUrl, setLeadTabInUrl]);

  // Quick "Send quote" from a list row — carries the lead's context into the
  // quote builder. Returning to /leads lands on the list (no auto-opened drawer).
  const goSendQuote = React.useCallback((lead: LeadListRow) => {
    /* A custom-software lead gets a PROJECT quotation, not a licence quote — and once it
       has one, "Send quote" opens that quotation instead of making a second. */
    if (lead.enquiry_type === "project") {
      router.push((lead.project_id ? `/projects/${lead.project_id}` : `${pathname}?projectQuote=${lead.id}`) as never);
      return;
    }
    /* R-389 (F5): lead id + plan/seats only — the builder loads company and contact from
       the lead, so the customer's email and phone never go into the URL. */
    router.push(leadQuoteHref(lead) as never);
  }, [router, pathname]);

  // ── Leads vs Deals split ────────────────────────────────────────────────
  // Leads = raw inquiries, no plan picked yet (NULL or empty). Awaiting
  //         qualification.
  // Deals = qualified opportunities (plan set) flowing through stages.
  // Same DB table; different filter cut so the two concepts don't mix.
  // Industry convention (HubSpot / Salesforce / Pipedrive) — direct entity
  // naming beats metaphors like "Inbox" / "Pipeline".
  // Tab is purely URL-derived now — no internal state, no setter. /leads
  // gives the raw inbox, /deals gives the qualified pipeline. The legacy
  // tab-bar UI is removed; navigation between the two is via sidebar.
  /* `"due"` is gone from this union. It was a fourth filter dimension that only the
     removed "Today's Follow-Ups" chip could set, duplicating the `followup` folder.
     What remains is purely which page we are on, and it only labels the Add button. */
  const [salesTab] = React.useState<"raw" | "deals" | "all">(
    isDealsPage ? "deals" : "raw"
  );

  /* Which folder is showing. "all" by default — the page opens on "here is your
     pipeline", not on one slice of it. */
  const [folder, setFolder] = React.useState<SalesFolder | "all">("all");
  /* `tab` is gone. It existed to pick which HALF of the pipeline to show, and there
     are no halves any more — /leads and /deals resolve to the same open set. Every
     place that branched on it either disappeared with the cross-over hints or now
     reads the same value both ways. */

  // Workspace keyword filter removed 2026-08-13. It classified rows by company-name
  // keywords ("excel", "vera") against hardcoded tenant UUIDs — one of which was
  // Delfos Technologies, a real separate tenant, badged as "Excel Tech". RLS already
  // scopes every read to the caller's tenant, so the filter only ever hid the
  // tenant's own leads. Name kept: it is referenced throughout this page.
  /* ── Whose leads ──────────────────────────────────────────────────────────
     The reporting tree decides, not the role — lib/team/visibility.ts. Unlike quotes, all
     14 live leads DO carry an owner_id, so this filter actually bites here, which makes the
     unowned-stays-visible branch the safety net rather than the main path.

     A view, not a wall: row-level enforcement ships in
     20260818150000_user_hierarchy_visibility.sql and is not applied yet. */
  const { data: leadTeamTree } = useTeamTree();
  const leadTeam = React.useMemo(() => leadTeamTree ?? [], [leadTeamTree]);
  const leadMeMember = React.useMemo(
    () => leadTeam.find((u) => u.id === currentUser?.userId) ?? null,
    [leadTeam, currentUser?.userId],
  );
  const [leadTeamMode, setLeadTeamMode] = React.useState<TeamViewMode>("team");

  /* The team toggle's cut, as owner ids: listed owners OR unowned (lib/team/visibility.ts,
     list-selectors.ts#inWorkspace). null = no narrowing. Sent to the server as owner_ids. */
  const teamIds = React.useMemo(
    () => (leadMeMember ? idsForMode(leadMeMember, leadTeam, leadTeamMode) : null),
    [leadMeMember, leadTeam, leadTeamMode],
  );

  // Force list view on mobile (Kanban with 6 vertical stage columns is
  // unusable on phones — each empty stage takes a screen-full).
  // Deals tab respects the user's saved preference, EXCEPT on mobile.
  const { isMobile, width: measuredWidth } = useBreakpoint();
  /* Board is now available on /leads too. It used to be forced to list because raw
     leads only ever sat in `new` / `contact`, so four of the six Kanban columns were
     always empty. Now that every open stage is on this page the board is the whole
     pipeline again — and drag-drop between stages is how a rep advances a deal, which
     is exactly what the folder model cannot do and must not replace. */
  const effectiveView = isMobile ? "list" : view;
  const isList = effectiveView === "list";
  /* useBreakpoint reports desktop until it has measured the window (width 0), so on a phone
     the first render briefly means "board". Neither the list nor the board is fetched until
     the view is known — otherwise every phone visit also pulled the board's rows. */
  const viewKnown = measuredWidth > 0;

  /* The search box goes to the server a beat after the last keystroke, not on every one —
     a count and a page per keypress would be two round trips per letter. */
  const [debouncedSearch, setDebouncedSearch] = React.useState(search);
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  /* ── ONE SET OF FILTERS, TWO READERS ───────────────────────────────────────
     S40. The list pages through list_leads() and every number on the page — the View menu,
     the folder rows, Junk / Duplicates, the Kiska counts, the team note, the KPI tiles, the
     hot-lead card — comes from lead_counts(), both called with THESE filters. Before this
     the page loaded every lead with select("*") and counted in the browser; at 20,000 leads
     that was megabytes per visit, and PostgREST's 1000-row cap meant the chips were
     silently counting only the newest 1000. supabase/tests/lead_counts.test.sql proves, for
     every view × folder, that the count equals the rows the list pages out. */
  /* R-057: on /leads the stages sent to BOTH readers leave out `won` (lib/leads/page-scope.ts),
     so the list and its counts agree; /deals sends the filters unchanged. */
  const listFilters = React.useMemo<LeadListFilters>(() => scopeFiltersForPage({
    owner_ids: teamIds ? [...teamIds] : undefined,
    search: debouncedSearch,
    stages: stageFilter,
    priorities: priorityFilter,
    owners: ownerFilter,
    sources: sourceFilter,
    smart_view: smartView,
    folder: folderForView(folder, smartView),
    /* The default "wait" order (lib/leads/waiting.ts) is worked out by the server, so the
       lead that has waited longest is on page 1 even if it arrived months ago. */
    sort: sortBy === "wait" ? "wait" : "created",
  }, isDealsPage), [teamIds, debouncedSearch, stageFilter, priorityFilter, ownerFilter, sourceFilter, smartView, folder, sortBy, isDealsPage]);

  const countsQ = useLeadCounts(listFilters);
  const counts  = countsQ.data;
  const pagesQ  = useLeadsInfinite(listFilters, 50, { enabled: viewKnown && isList });
  /* The Kanban board reads each column on its own (WC-scale): the stage, the team cut and
     junk are filtered on the server, the newest BOARD_COLUMN_CAP cards per column come back
     with the column's true total, and the browser cuts the rest as before. Slim columns,
     only while the board is on screen. Its chips are server counts like the list's. */
  /* Only this page's columns — /deals has no New / Contacted (lib/leads/page-scope.ts). */
  const boardStages = React.useMemo(() => BOARD_STAGES.filter((s) => stageShownOnPage(s, isDealsPage)), [isDealsPage]);
  const boardQ  = useLeadsBoard(viewKnown && !isList, { ownerIds: teamIds, junk: smartView === "junk", stages: boardStages });
  /* The call queue and the loss card read their own small slices. */
  const dueQ    = useDueLeads(teamIds, search.trim() === "");
  const lostQ   = useLostLeads(teamIds, isDealsPage);

  const isLoading = countsQ.isLoading || !viewKnown || (isList ? pagesQ.isLoading : boardQ.isLoading);
  const error = countsQ.error ?? (isList ? pagesQ.error : boardQ.error) ?? null;
  const refetch = React.useCallback(() => {
    void countsQ.refetch();
    void (isList ? pagesQ.refetch() : boardQ.refetch());
  }, [countsQ, pagesQ, boardQ, isList]);
  /** Does this workspace have ANY lead — what `leads.length > 0` used to answer. */
  const totalLeads = counts?.pool.total;

  /* The list's rows. A "mark junk" is patched into the cache before the server answers
     (queries/leads.ts#patchCachedLeads); dropping junk here makes that tap vanish the row at
     once, as it did when the page filtered its in-memory list. */
  const listRows = React.useMemo<LeadListRow[]>(() => {
    const rows = pagesQ.data ?? [];
    return smartView === "junk" ? rows : rows.filter((l) => !l.is_junk);
  }, [pagesQ.data, smartView]);
  const dupIds = React.useMemo(
    () => new Set(listRows.filter((l) => l.is_duplicate).map((l) => l.id)),
    [listRows],
  );

  /* ── The board's cut (Kanban only) — the old in-browser selectors, over slim rows ── */
  const folderToday = React.useMemo(() => localDateISO(new Date()), []);
  const boardLeads = React.useMemo<LeadListRow[]>(() => {
    if (isList) return [];
    /* R-057: the board on /leads holds no won cards either. */
    const rows = (boardQ.data?.rows ?? []).filter((l) => stageShownOnPage(l.stage, isDealsPage));
    const workspace = teamIds === null ? rows : inWorkspace(rows, teamIds);
    const dup = computeDuplicates(workspace);
    const searched = searchLeads(workspace, {
      search, stageFilter, priorityFilter, ownerFilter, sourceFilter, ownerNames, smartView, currentUser, dupFlagged: dup.flagged, now: new Date(),
    });
    /* ── THE BOARD MUST CONTAIN ITS OWN LAST COLUMN ───────────────────────────
       The list cut is open-only when no folder is picked, and the board's stages end at
       `won` — so the Won column read 0 cards three inches below a chip saying 🏆 Won 2.
       Won is also the board's DROP TARGET. So the board's base is every non-junk, non-lost
       lead; picking a folder hands control back to the list cut (list-selectors#boardCut). */
    const cutFolder = folderForView(folder, smartView);
    return boardCut(searched, listCut(searched, cutFolder, smartView, folderToday), cutFolder, smartView);
  }, [isList, isDealsPage, boardQ.data, teamIds, search, stageFilter, priorityFilter, ownerFilter, sourceFilter, ownerNames, smartView, currentUser, folder, folderToday]);

  /** The rows the current view is showing — what `filtered` was. */
  const shownRows = isList ? listRows : boardLeads;
  /** How many rows the view holds in total (the list only loads a page of them). */
  const shownCount = isList ? (counts?.list.matching ?? listRows.length) : boardLeads.length;

  const activeFilterCount = stageFilter.length + priorityFilter.length + ownerFilter.length + sourceFilter.length;

  /* ── The folder chips are the filter ──────────────────────────────────────
     "Inbox" and "Qualified Deals" used to switch between the two halves of the old
     /leads-vs-/deals split. After the merge both resolved to the same open set, so
     clicking either changed nothing — and "Qualified Deals 1" sat above a list of 9.
     A control that looks like a filter and filters nothing is worse than no control:
     the rep believes the list in front of them has been narrowed.

     The folder counts are lead_counts().folders — counted over the SEARCHED set (every
     filter + the view), not over open leads: Won and Lost are folders too, and a base that
     had already dropped closed leads would report both as 0 forever. The list's folder cut
     is the same rule on the server (inSalesFolder), pinned by lead_counts.test.sql. */
  /* ─── THE SIX FOLDERS THE VIEW MENU DID NOT ALREADY HAVE ────────────────
     The chip strip is gone; these move into <LeadsSmartViews/> so there is ONE place
     a list gets narrowed. All open and Junk are deliberately absent — the menu already
     carries both, and repeating them here would move the duplication instead of
     removing it. */
  const folderRows = React.useMemo(
    () =>
      /* R-057: no Won folder on /leads; no Inbox / Talks on /deals (page-scope.ts). */
      SALES_FOLDERS.filter((f) => folderShownOnPage(f.id, isDealsPage)).map((f) => {
        const count = counts?.folders[f.id] ?? 0;
        /* Only when it IS empty — see the note above. */
        return { id: f.id as string, label: f.label, count, hint: count === 0 ? f.hint : "" };
      }),
    [counts, isDealsPage],
  );

  /* ── ONE SELECTION AT A TIME ────────────────────────────────────────────────
     The chip row drove THREE independent pieces of state — `folder`, `smartView` and
     `salesTab` — and no chip cleared the others. Picking Hot Deals and then Junk left
     both lit, over a list of junk; picking Today's Follow-Ups and then Inbox left the
     follow-up cut silently applied underneath a chip that said Inbox. Two highlighted
     chips is not a cosmetic problem: the rep believes the list has been narrowed one way
     when it has been narrowed another.

     Every chip now goes through one of these two, so a chip added later cannot forget a
     dimension. */
  const selectFolder = React.useCallback((f: SalesFolder | "all") => {
    setFolder(f);
    setSmartView("everything");
  }, [setSmartView]);
  /* The Smart Views dropdown is the OTHER filter surface, and it used to stack on top of
     whatever chip was lit. Selecting from it now releases the folder, so exactly one of
     the two is ever in force. */
  const selectSmartView = React.useCallback((v: SmartView) => {
    setSmartView(v);
    setFolder("all");
  }, [setSmartView]);

  /** Open the merge dialog for a lead: cluster = the lead + everything it duplicates, read
   *  from the server when Merge is pressed (list_leads dup_of — the row's flag's own rule). */
  const openMergeFor = React.useCallback(async (lead: LeadListRow) => {
    try {
      const cluster = await fetchMergeCluster(lead.id, teamIds);
      if (cluster.length > 1) setMergeCluster(cluster);
      else toast.info(`${lead.company} has no duplicate left to merge`);
    } catch (err) {
      toastError(err, { fallback: "Could not look up the duplicates" });
    }
  }, [teamIds]);

  /* ── EVERY NON-JUNK LEAD IS A DEAL ─────────────────────────────────────────
     The KPI tiles ("Show the numbers") are lead_counts().kpi — over every non-junk lead in
     the workspace, whatever its stage, never over the searched set, so the totals answer
     "how much is there" rather than "how much survives what I typed". (The band once read
     "Open Pipeline ₹0" beside "Open leads: 8" because it started at stage > contact; a stage
     is no longer a reason to be left out of the totals.)
     Win rate over DECIDED deals only — won ÷ (won + lost); see lib/leads/forecast.ts. */
  const kpi = counts?.kpi;
  const wonCount = kpi?.won ?? 0;
  const decidedCount = (kpi?.won ?? 0) + (kpi?.lost ?? 0);
  const conversion = decidedCount > 0 ? Math.round((wonCount * 100) / decidedCount) : null;

  return (
    <div className="h-[calc(100vh-3.5rem-4rem)] md:h-[calc(100vh-3.5rem)] max-w-[1800px] mx-auto p-3 sm:p-4 flex flex-col overflow-hidden min-w-0">
      {/* The sticky title bar, and why its offsets and this wrapper's height are what they
          are — see leads-header-bar.tsx. */}
      <LeadsHeaderBar salesTab={salesTab} isDealsPage={isDealsPage} setAddOpen={setAddOpen} setQuickOpen={setQuickOpen} />


      {/* Expanded Intelligence Drawer */}
      {kpiOpen && !isLoading && counts && (totalLeads ?? 0) > 0 && (
        <LeadsKpiDrawer
          totalValue={counts.kpi.open_value}
          pipelineByType={{
            subscription: counts.kpi.open_value - counts.kpi.open_value_project,
            project: counts.kpi.open_value_project,
          }}
          openCount={counts.kpi.open_count}
          highPriority={counts.pool.high_priority}
          totalInquiries={counts.pool.total}
          wonCount={wonCount}
          decidedCount={decidedCount}
          conversion={conversion}
        />
      )}




      {/* ─── Main content + right rail split.
          flex-1 + min-h-0 makes this section take up all remaining
          vertical space in the page wrapper (so the table area can
          stretch even with only one row of data). Below xl (≤1279px)
          this is a single column — the rail's own visibility class
          keeps it dormant. On xl+ the rail appears (320px) and the
          main column flexes to fill the remainder.
          Drawer / FAB / modals live OUTSIDE this flex (position:fixed),
          so they aren't constrained by the split. */}
      <div className="flex gap-6 flex-1 min-h-0">
        {/* R-197: this column SCROLLS. The wrapper above clips at the viewport height, and on a
            short screen (~938px) the hot card + call queue filled it, so the board and the list
            were cut off with no way to reach them. Board and list keep a min-h floor below, so
            the scroll never squashes them to 0px. See board-reachable.test.ts. */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-y-auto custom-scrollbar">
      {/* AI junk review — only in the Junk view. Lets the operator ask AI to
          decide across the spam pile (verdict + reason + confidence), then
          confirm with one tap. Reversible, human-in-the-loop. */}
      {/* The rows on screen — the list's loaded pages, or the board's cut. */}
      {smartView === "junk" && shownRows.length > 0 && (
        <JunkAIReview leads={shownRows} />
      )}

      {/* AI lead intelligence
          "Hot leads" = highest-value rows in quote/trial stages — these
          convert at the highest rate per the prototype-era data, and they're
          the ones a rep should actually touch today. The two action buttons
          target the single TOP hot lead (highest value) — Call opens the
          phone dialer; Send nudge opens the mail client with a pre-written
          follow-up. Both gracefully degrade if the contact info is missing. */}
      {!isLoading && counts && (totalLeads ?? 0) > 0 && !isSales && search.trim() === "" && (
        <LeadsHotCard hotCount={counts.list.hot} topHot={counts.list.hot_top} currentUser={currentUser} tipsOpen={tipsOpen} toggleTips={toggleTips} />
      )}


      {/* Tab bar removed after the /leads + /deals split — navigation between
          the two views is now via sidebar entries. The single-page tab UI
          confused sales reps and added a click for owner/manager too. */}

      {/* 🔥 Today's priority call queue — replaces the read-only "Today's follow-ups"
          widget that used to sit here. Same source data (follow_up_date <= today, with
          overdue included), but each row now dials, WhatsApps and records the outcome
          without leaving the bar. The old widget could only tell a rep WHO to call and
          then made them go and find the lead to do anything about it.

          It also self-hides, states how many due leads it is NOT showing, and names the
          ones with no phone number — see priority-call-queue.tsx for why each of those
          matters more than it sounds. */}
      {/* `mb-3`: band aur table ke beech saans. Bina iske dono chipke hue the aur band
          table ka hi ek header jaisa lagta tha — jabki wo alag cheez hai. */}
      {!isLoading && (totalLeads ?? 0) > 0 && search.trim() === "" && (
        <div className="mb-3">
        <PriorityCallQueue
          leads={dueQ.data ?? []}
          tenantName={currentUser?.tenantName}
          onOutcome={(o, l) => callLog.run(o, l)}
          onOpen={openLead}
          onLogCall={(l) => queueLog.mutate({ leadId: l.id, kind: "call", detail: `Called ${l.contact_phone ?? ""}` })}
          onLogWhatsApp={(l) => queueLog.mutate({ leadId: l.id, kind: "whatsapp", detail: `WhatsApp to ${l.contact_phone ?? ""}` })}
        />
        </div>
      )}

      {/* Loss analytics — owner-level "why are we losing?", in money. Deals tab
          only: the raw-inquiry tab has no stage flow, so losses aren't its story.
          The card handles its own empty state and hides nothing. */}
      {!isLoading && !error && isDealsPage && (totalLeads ?? 0) > 0 && (
        <div className="mb-3">
          <LossReasonsCard leads={lostQ.data ?? []} />
        </div>
      )}

      {/* R-277 (Pardeep, 6 Oct): the search + filter bar sits DIRECTLY above the list /
          Kanban it filters. It used to sit above the hot card, the call queue and (on /deals)
          the loss-reasons card, so after typing a search or picking a filter the result was
          a scroll away. Sticky inside this scrolling column, so it stays at hand while the
          list scrolls — phone too. Order is pinned by toolbar-above-list.test.ts. */}
      {/* Search + Views dropdown + Filter buttons.
          The Views control used to be a chip strip in a flex-1 overflow-x-auto
          box here. Eight chips in the space left over between the search box and
          the buttons meant one visible chip and two scroll arrows. It is a
          dropdown now, so the row no longer needs a scrolling middle section —
          and the width it was hogging goes to the search box, which was the
          other cramped control on this row. */}
      {!isLoading && counts && (
        <div className="sticky top-0 z-10 -mx-1 px-1 pt-1.5 bg-paper/95 backdrop-blur-sm">
          <LeadsToolbar
            pool={counts.pool}
            leadMeMember={leadMeMember}
            leadTeam={leadTeam}
            leadTeamMode={leadTeamMode}
            setLeadTeamMode={setLeadTeamMode}
            search={search}
            setSearch={setSearch}
            viewCounts={counts.views}
            everythingCount={everythingCountForPage(counts, isDealsPage)}
            isDealsPage={isDealsPage}
            currentUser={currentUser}
            duplicateCountForTab={counts.views.duplicates}
            junkCount={counts.workspace.junk}
            junkSuspectCount={counts.workspace.suspects}
            smartView={smartView}
            selectSmartView={selectSmartView}
            folderRows={folderRows}
            folder={folder}
            selectFolder={selectFolder}
            effectiveView={effectiveView}
            setView={setView}
            isMobile={isMobile}
            activeFilterCount={activeFilterCount}
            filterStages={filterStages}
            stageFilter={stageFilter}
            setStageFilter={setStageFilter}
            priorityFilter={priorityFilter}
            setPriorityFilter={setPriorityFilter}
            ownerFilter={ownerFilter}
            setOwnerFilter={setOwnerFilter}
            sourceFilter={sourceFilter}
            setSourceFilter={setSourceFilter}
            isSales={isSales}
            kpiOpen={kpiOpen}
            setKpiOpen={setKpiOpen}
            setCsvImportOpen={setCsvImportOpen}
            setCampaignOpen={setCampaignOpen}
            setGoogleImportOpen={setGoogleImportOpen}
            setShareOpen={setShareOpen}
          />
        </div>
      )}

      {/* Below the toolbar: a filter or view with no rows shows its empty state right under
          the controls that caused it (R-277). Renders nothing when there are rows. */}
      <LeadsStatusStates
        error={error}
        refetch={refetch}
        isLoading={isLoading}
        totalLeads={totalLeads}
        isDealsPage={isDealsPage}
        isSales={isSales}
        shownCount={shownCount}
        smartView={smartView}
        setAddOpen={setAddOpen}
        setCsvImportOpen={setCsvImportOpen}
        setSmartView={setSmartView}
      />

      {/* Kanban — only shows on Deals tab (raw leads in the Leads tab have
          no meaningful stage flow, so we force list view there).
          flex-1 + min-h-0 lets the grid stretch to fill remaining viewport
          height (page wrapper is min-h-[calc(100vh-3.5rem)] flex-col), so
          columns visually fill instead of bottom cream area showing. */}
      {!isLoading && !error && (totalLeads ?? 0) > 0 && effectiveView === "kanban" && (
        <LeadsKanbanBoard
          boardLeads={boardLeads}
          columnTotals={boardQ.data?.totals}
          /* R-070: column ₹ totals from the server (lead_counts, same filters) — exact even
             for a capped column; undefined under a folder / the Junk view (page-scope.ts). */
          serverColumnTotals={boardServerTotals(counts, folder, smartView)}
          stages={DEAL_STAGES.filter((s) => stageShownOnPage(s.id, isDealsPage))}
          changeStage={changeStage}
          setSelected={openLead}
          setAddOpen={setAddOpen}
        />
      )}

      {/* List view — sortable table, designed for scanning at 50+ leads.
          Also the only view available on the Leads tab (triage queue).
          Only render when there ARE rows to show — otherwise the table's
          internal "No leads match." row appears AND the smart empty state
          below also fires, creating a duplicate. Skipping the table here
          lets the smart empty state below own the empty-screen real estate. */}
      {!isLoading && !error && (totalLeads ?? 0) > 0 && effectiveView === "list" && listRows.length > 0 && (
        <div className="flex-1 min-h-[480px] flex flex-col">
        <LeadListView
          leads={listRows}
          /* S40: the list is PAGED. The server already ordered it for "wait" and "created"
             (newest first); any other column sorts the rows loaded so far, and the footer
             says so. */
          serverSorted={sortDir === "desc" && (sortBy === "wait" || sortBy === "created")}
          paging={{
            total: counts?.list.matching ?? listRows.length,
            hasMore: Boolean(pagesQ.hasNextPage),
            loadingMore: pagesQ.isFetchingNextPage,
            onLoadMore: () => { void pagesQ.fetchNextPage(); },
          }}
          sortBy={sortBy}
          sortDir={sortDir}
          onSort={(col) => {
            if (sortBy === col) setSortDir(sortDir === "asc" ? "desc" : "asc");
            else { setSortBy(col); setSortDir(col === "company" ? "asc" : "desc"); }
          }}
          // Both Leads + Deals rows open the rich drawer now (consistency): a
          // raw lead's first move is to CONTACT (call/WhatsApp/email/follow-up/
          // send-quote) — all live in the drawer. Qualifying is still one click
          // away via the drawer's "Edit" button, so nothing is lost.
          onRowClick={openLead}
          onSendQuote={goSendQuote}
          onFollowUp={setFollowUpLead}
          onWhatsApp={(l) => setWaLead(l)}
          onMerge={openMergeFor}
          dupIds={dupIds}
        />
        </div>
      )}

      <LeadsNoResults
        isLoading={isLoading}
        error={error}
        totalLeads={totalLeads}
        shownCount={shownCount}
        smartView={smartView}
        search={search}
        setSearch={setSearch}
        setStageFilter={setStageFilter}
        setPriorityFilter={setPriorityFilter}
      />

        </div>{/* /flex-1 main column */}

      </div>{/* /flex split */}

      {/* Detail drawer.

          `selectedLive`, NOT `selected`. Reported 23 Aug 2026: tapping the drawer's "Move
          to Contacted" nudge moved the card on the board behind it — New went to 0,
          Contacted to 1, so the write plainly succeeded — while the drawer kept saying
          "Stage: New" and kept showing the nudge that had just done its job.

          `selected` is a Lead OBJECT captured in state when the row was clicked, so it is
          a snapshot frozen at open time. Every mutation in here invalidates ["leads"] and
          the list re-renders correctly; the drawer alone was reading a copy nobody
          refreshes. Resolving the row by id on each render means one source of truth for
          both, which is what made the board and the drawer disagree in the first place.

          This was never specific to the nudge — the in-drawer stage dropdown had the same
          staleness and nobody had noticed, because it sits next to a stage label it also
          failed to update. The nudge only made the disagreement loud enough to see.

          S40: `selected` holds only the id now, and the lead is read by that id (useLead) —
          the list's rows are slim and the drawer needs the full record. A background
          refetch keeps the last data on screen, so the drawer does not blank mid-refetch;
          on first open it appears once that one row has arrived. */}
      <LeadDetailSheet
        lead={selectedLive}
        onClose={closeLead}
        onEdit={(l) => {
          closeLead();
          setEditingLead(l);
          setAddOpen(true);
        }}
      />

      <LeadsPageDialogs
        followUpLead={followUpLead}
        setFollowUpLead={setFollowUpLead}
        waLead={waLead}
        setWaLead={setWaLead}
        mergeCluster={mergeCluster}
        setMergeCluster={setMergeCluster}
        projectQuoteLead={projectQuoteLead}
        closeProjectQuote={() => router.replace(pathname as never)}
        addOpen={addOpen}
        setAddOpen={setAddOpen}
        editingLead={editingLead}
        setEditingLead={setEditingLead}
        isDealsPage={isDealsPage}
        quickOpen={quickOpen}
        setQuickOpen={setQuickOpen}
        trialOpen={trialOpen}
        setTrialOpen={setTrialOpen}
        callLog={callLog}
        campaignOpen={campaignOpen}
        setCampaignOpen={setCampaignOpen}
        googleImportOpen={googleImportOpen}
        setGoogleImportOpen={setGoogleImportOpen}
        csvImportOpen={csvImportOpen}
        setCsvImportOpen={setCsvImportOpen}
        refetch={refetch}
        shareOpen={shareOpen}
        setShareOpen={setShareOpen}
      />

      {/* NO FAB HERE, deliberately (removed 13 Aug 2026 at Pardeep's request).
          The primary action lives in the sticky header instead, so it is visible
          at every scroll position without covering the last row of the list —
          which is what the bottom-right FAB was doing over the card grid.

          §20 asks for a FAB on mobile for thumb reach, and this does trade that
          away: the top-right corner is a longer stretch one-handed than the
          bottom-right. Noted as a deliberate deviation, not an oversight.

          The "⚡ Quick" mini-FAB went with it. The 4-field quick-capture form is
          NOT orphaned — it is still reachable from the top-bar quick-actions
          panel (quick-actions-panel.tsx) and from Ctrl+K → "Open the quick-add
          form" (command-palette.tsx), both of which route here via
          ?action=quick-add. */}
    </div>
  );
}

// LeadsPageInner uses useSearchParams() — Next.js requires that to live under
// a Suspense boundary so static prerender can bail out gracefully.
export default function LeadsPage() {
  return (
    <React.Suspense fallback={<div className="p-8 text-sm text-ink-3">Loading deals…</div>}>
      <LeadsPageInner />
    </React.Suspense>
  );
}