/**
 * Leads + Deals — same component drives BOTH /leads and /deals URLs.
 *
 * Route convention (after split, migration 0045):
 *   /leads  → raw leads inbox (NULL plan) — list view, no Kanban
 *   /deals  → qualified deal pipeline      — Kanban (default) + list toggle
 *
 * The same DB table backs both views — the split is just a filter cut
 * (raw vs qualified). Industry convention (HubSpot / Salesforce / Pipedrive)
 * matches: Leads ≠ Deals, they're distinct UI concepts on shared data.
 *
 * Layout (URL-driven):
 *   - Header: eyebrow "Sales" + page-specific title + subtitle
 *   - Actions: search + view toggle (Deals only) + Filter + advanced + Add
 *   - GeminiCard with AI lead intelligence (Deals page only)
 *   - Kanban (default on /deals): 6 stage columns with drag-drop
 *   - List: sortable table for scanning many at scale
 *   - Detail Sheet on card / row click (shared)
 */
"use client";

import * as React from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { toast } from "sonner";
import { useLeads, useUpdateLeadStage, useDeleteLead, useSetLeadJunk } from "@/lib/queries/leads";
import { looksLikeJunk } from "@/lib/leads/junk";
import { useLeadActivities, useLogLeadActivity } from "@/lib/queries/lead-activities";
import { LeadsBulkBar } from "@/components/features/leads/leads-bulk-bar";
import { useQuotesByLead } from "@/lib/queries/quotes";
import { QuoteActionBar } from "@/components/features/quotes/quote-action-bar";
import { useTasks, useTasksForLead, useCompleteTask, useSnoozeTask, useDeleteTask } from "@/lib/queries/tasks";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { AddTaskDialog } from "@/components/features/tasks/add-task-dialog";
import { LeadCard } from "@/components/features/leads/lead-card";
import { AddLeadForm } from "@/components/features/leads/add-lead-form";
import { QuickAddLeadForm } from "@/components/features/leads/quick-add-lead-form";
import { LeadsSmartViews, type SmartView } from "@/components/features/leads/leads-smart-views";
import { MergeLeadsDialog } from "@/components/features/leads/merge-leads-dialog";
import { computeDuplicates } from "@/lib/leads/duplicates";
import { isHotLead, isHighValueLead, hotReason } from "@/lib/leads/heat";
import { SwipeLeadCard } from "@/components/features/leads/swipe-lead-card";
import { ImportCsvDialog } from "@/components/features/leads/import-csv-dialog";
import { ShareFormSheet, ENQUIRY_SHARE } from "@/components/features/leads/share-form-sheet";
import StartTrialDialog from "@/components/features/leads/start-trial-dialog";
import CampaignComposerDialog from "@/components/features/campaigns/campaign-composer-dialog";
import GoogleContactsImportDialog from "@/components/features/contacts/google-contacts-import-dialog";
import SendWhatsAppDialog from "@/components/features/whatsapp/send-whatsapp-dialog";
import { GeminiCard } from "@/components/shared/gemini-card";
import { JunkAIReview } from "@/components/features/leads/junk-ai-review";
import { EmptyState } from "@/components/shared/empty-state";
import { AiDraftButton } from "@/components/shared/ai-draft-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Button, IconButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { rupee, formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/providers/confirm-provider";
import type { Lead } from "@/lib/supabase/database.types";
import { useBreakpoint } from "@/lib/hooks/useBreakpoint";
import { FAB } from "@/components/ui/fab";
import { StatStrip } from "@/components/shared/stat-strip";

// ============================================================
// Stage config (matches prototype LEAD_STAGES)
// ============================================================
const LEAD_STAGES: { id: Lead["stage"]; label: string; dot: string }[] = [
  { id: "new",     label: "New",          dot: "bg-slate" },
  { id: "contact", label: "Contacted",    dot: "bg-amber" },
  { id: "demo",    label: "Demo Done",    dot: "bg-indigo" },
  { id: "trial",   label: "Trial Active", dot: "bg-rose" },
  { id: "quote",   label: "Quote Sent",   dot: "bg-indigo" },
  { id: "won",     label: "Won",          dot: "bg-emerald" },
];

// Deal Pipeline Kanban columns — a deal only ENTERS the pipeline when a quote is
// sent, so raw stages (New / Contacted) never hold deals here and would render as
// permanently-empty columns (the confusing stray "+" at the board edge). Show
// only the real deal stages, in funnel order: Quote Sent → Demo → Trial → Won.
const DEAL_STAGES = (["quote", "demo", "trial", "won"] as const).map(
  (id) => LEAD_STAGES.find((s) => s.id === id)!,
);

// All stage meta including Lost (LEAD_STAGES omits Lost as it's an outcome,
// not a Kanban column). Used to build the page-aware Filter list.
const STAGE_META: { id: Lead["stage"]; label: string; dot: string }[] = [
  ...LEAD_STAGES,
  { id: "lost", label: "Lost", dot: "bg-ink-3" },
];

function LeadsPageInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const pathname     = usePathname();
  const focusLeadId  = searchParams.get("lead");

  const { data: leads, isLoading, error, refetch } = useLeads();
  const updateStage = useUpdateLeadStage();
  const { data: currentUser } = useCurrentUser();
  // Sales role gets a simplified UI — no Kanban / campaign / trial buttons.
  const isSales = currentUser?.role === "sales";
  // URL-driven mode (after the /leads + /deals split). /deals shows the
  // qualified pipeline; /leads shows raw inbox. No tab bar — each URL is
  // its own page now.
  const isDealsPage = pathname === "/deals";

  // Filter offers only the stages that can actually appear on THIS page (else
  // filtering e.g. "Won" on the raw Leads inbox always yields 0 rows). Mirrors
  // the inline row dropdown: raw inbox = New/Contacted; deals = the deal stages.
  const filterStages = STAGE_META.filter((s) =>
    isDealsPage
      ? s.id === "quote" || s.id === "demo" || s.id === "trial" || s.id === "won" || s.id === "lost"
      : s.id === "new" || s.id === "contact",
  );

  const [search, setSearch] = React.useState("");
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overStage, setOverStage] = React.useState<Lead["stage"] | null>(null);
  const [addOpen,         setAddOpen]         = React.useState(false);
  const [quickOpen,       setQuickOpen]       = React.useState(false);
  const [shareOpen,       setShareOpen]       = React.useState(false);
  const [trialOpen,       setTrialOpen]       = React.useState(false);
  const [campaignOpen,    setCampaignOpen]    = React.useState(false);
  const [googleImportOpen, setGoogleImportOpen] = React.useState(false);
  const [csvImportOpen,    setCsvImportOpen]    = React.useState(false);
  // Filter state — multi-select stages + priorities. Empty array = no filter
  // (show all). Owner filter intentionally deferred — UI is already busy.
  const [stageFilter,    setStageFilter]    = React.useState<Lead["stage"][]>([]);
  const [priorityFilter, setPriorityFilter] = React.useState<Array<"low"|"medium"|"high">>([]);
  // Due-bucket filter driven by the insight band's KPI pills.
  //   today    → follow_up_date === today
  //   overdue  → follow_up_date < today
  //   hot      → stage in [demo, trial, quote]
  //   all      → no constraint
  // Smart view = saved filter combo (HubSpot/Close/Attio pattern). Each
  // chip in <LeadsSmartViews/> sets this. The `searched` memo below
  // applies the view as an additional filter cut.
  const [smartView, setSmartView] = React.useState<SmartView>("all");
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
  const [selected, setSelected] = React.useState<Lead | null>(null);
  const [editingLead, setEditingLead] = React.useState<Lead | null>(null);
  // Row "Follow-up" quick action → opens AddTaskDialog scoped to this lead.
  const [followUpLead, setFollowUpLead] = React.useState<Lead | null>(null);
  // Merge-duplicates dialog — holds the cluster (a lead + its matches) to fold.
  const [mergeCluster, setMergeCluster] = React.useState<Lead[] | null>(null);
  // "Follow-ups due today" banner — click to expand the list of due leads.
  const [dueListOpen, setDueListOpen] = React.useState(false);
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
  const [sortBy, setSortBy] = React.useState<"created" | "value" | "company" | "stage" | "age">("created");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");

  // ── Deep-link: open the drawer for the lead in ?lead=<id> ──
  // Runs once when leads load and the URL param is present.
  const deepLinkHandledRef = React.useRef(false);
  React.useEffect(() => {
    if (deepLinkHandledRef.current) return;
    if (!focusLeadId || !leads) return;

    const match = leads.find((l) => l.id === focusLeadId);
    if (!match) {
      deepLinkHandledRef.current = true;
      toast.error(`Lead ${focusLeadId} not found`);
      return;
    }
    deepLinkHandledRef.current = true;
    setSelected(match);

    // Scroll the matching card into view so the user can see where it is in the pipeline
    setTimeout(() => {
      document
        .querySelector(`[data-lead-id="${match.id}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);

    // Clean the param from URL so refresh doesn't re-trigger. Use the CURRENT
    // path (not a hardcoded /leads) so a ?lead= deep-link opened on /deals
    // stays on /deals instead of bouncing the user to /leads.
    router.replace(pathname as never);
  }, [focusLeadId, leads, router, pathname]);

  // Quick "Send quote" from a list row — carries the lead's context into the
  // quote builder. Returning to /leads lands on the list (no auto-opened drawer).
  const goSendQuote = React.useCallback((lead: Lead) => {
    const params = new URLSearchParams();
    params.set("leadId",  lead.id);
    params.set("company", lead.company);
    if (lead.plan)          params.set("plan",  lead.plan);
    if (lead.seats != null) params.set("seats", String(lead.seats));
    if (lead.contact_name)  params.set("contact", lead.contact_name);
    if (lead.contact_email) params.set("email", lead.contact_email);
    if (lead.contact_phone) params.set("phone", lead.contact_phone);
    router.push(`/quotes/new?${params.toString()}` as never);
  }, [router]);

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
  const tab: "leads" | "deals" = isDealsPage ? "deals" : "leads";

  // Duplicate index — computed over ALL leads (dups can span the whole tenant),
  // surfaced as a per-row "Duplicate?" flag + a "Duplicates" smart view. Declared
  // here (before `searched`) because the Duplicates view filters on dup.flagged.
  // Non-destructive: it only flags; merging is an explicit action in the dialog.
  const dup = React.useMemo(() => computeDuplicates(leads ?? []), [leads]);

  // Junk (spam/fake) — a stored flag. junkCount drives the Junk chip; suspects
  // are non-junk leads the heuristic flags for review (surfaced in the Junk view).
  const junkCount = React.useMemo(() => (leads ?? []).filter((l) => l.is_junk).length, [leads]);
  const junkSuspectCount = React.useMemo(
    () => (leads ?? []).filter((l) => !l.is_junk && looksLikeJunk(l).suspect).length,
    [leads],
  );

  // Search + filter both apply BEFORE the tab cut so each view respects them.
  const searched = React.useMemo(() => {
    if (!leads) return [];
    let list = leads;
    // 0. Junk cut — confirmed junk is hidden from EVERY working view. The "Junk"
    //    view is the cleanup workspace: confirmed junk + heuristic SUSPECTS (so
    //    you can review + mark them). Suspects still appear in working views
    //    (they're only flagged, not confirmed) until you mark them.
    list = smartView === "junk"
      ? list.filter((l) => l.is_junk || looksLikeJunk(l).suspect)
      : list.filter((l) => !l.is_junk);
    // 1. Text search across company / contact name / email / plan
    if (search.trim()) {
      const s = search.toLowerCase();
      list = list.filter(
        (l) =>
          l.company.toLowerCase().includes(s) ||
          (l.contact_name?.toLowerCase().includes(s) ?? false) ||
          (l.contact_email?.toLowerCase().includes(s) ?? false) ||
          (l.contact_phone?.toLowerCase().includes(s) ?? false) ||
          (l.plan?.toLowerCase().includes(s) ?? false)
      );
    }
    // 2. Stage filter (any-of). Empty array = no constraint.
    if (stageFilter.length > 0) {
      list = list.filter((l) => stageFilter.includes(l.stage));
    }
    // 3. Priority filter (any-of). Empty array = no constraint.
    if (priorityFilter.length > 0) {
      list = list.filter((l) => priorityFilter.includes(l.priority as "low"|"medium"|"high"));
    }
    // 4. Single unified view filter (one chip row — All / Today / Overdue /
    //    Hot / New / Won MTD / Mine). Each chip maps to exactly one bucket, so
    //    there's no overlap/duplication (the old separate due-bucket KPI row is
    //    gone). Sits on top of search + stage + priority.
    if (smartView !== "all") {
      const todayStr = new Date().toISOString().slice(0, 10);
      const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      if (smartView === "mine") {
        list = list.filter((l) => currentUser && l.owner_id === currentUser.userId);
      } else if (smartView === "today") {
        // Arrived today (new inbound).
        list = list.filter((l) => l.created_at?.slice(0, 10) === todayStr);
      } else if (smartView === "overdue") {
        // Follow-up overdue + still open — the rep's most actionable bucket.
        list = list.filter((l) => l.follow_up_date && l.follow_up_date < todayStr && l.stage !== "won" && l.stage !== "lost");
      } else if (smartView === "hot") {
        list = list.filter(isHotLead);
      } else if (smartView === "new") {
        list = list.filter((l) => l.stage === "new");
      } else if (smartView === "won-mtd") {
        list = list.filter((l) => l.stage === "won" && l.created_at && new Date(l.created_at) >= monthStart);
      } else if (smartView === "duplicates") {
        list = list.filter((l) => dup.flagged.has(l.id));
      }
    }
    return list;
  }, [leads, search, stageFilter, priorityFilter, smartView, currentUser, dup]);
  const activeFilterCount = stageFilter.length + priorityFilter.length;

  // A lead is "raw" (Leads inbox) only while it's early — New or Contacted with
  // no plan yet. The moment it advances (Demo / Trial / Quote) OR gets a plan,
  // it's an active opportunity and belongs in Deals. Won/Lost are deal outcomes,
  // so they're never raw either.
  // A lead stays in the Leads inbox until a quotation is sent. Sending a quote
  // moves its stage to 'quote' (and only then can it go to demo/trial/won) —
  // that's the single gate out of the inbox. So raw = still pre-quote (new/contact).
  const isRaw = (l: Lead) => l.stage === "new" || l.stage === "contact";
  const rawLeads      = React.useMemo(() => searched.filter(isRaw),       [searched]);
  const qualifiedDeals = React.useMemo(() => searched.filter((l) => !isRaw(l)), [searched]);

  // The Kanban / List views consume this — points at whichever tab is active.
  // Junk is stage-agnostic (spam is spam at any stage), so its view bypasses the
  // raw/deals cut and shows every junk + suspect — matching the chip's count.
  const filtered = smartView === "junk" ? searched : (tab === "leads" ? rawLeads : qualifiedDeals);

  // Tab-scoped UNFILTERED subset for the insight band, Smart Views chips,
  // Today strip, and right rail. Without this they show tenant-wide counts
  // (e.g. "All 3") while the table only renders the tab's slice (2 rows),
  // creating the bug Pardeep flagged in dogfood (chip count ≠ table count).
  // Derived from `leads` (not `searched`) so counts stay accurate while
  // the user is searching / filtering.
  const leadsForTab = React.useMemo(
    () => (tab === "leads" ? (leads ?? []).filter(isRaw) : (leads ?? []).filter((l) => !isRaw(l))),
    [leads, tab],
  );

  // Per-tab duplicate count + merge opener (the `dup` index itself is computed
  // higher up, before `searched`, since the Duplicates smart view filters on it).
  const duplicateCountForTab = React.useMemo(
    () => leadsForTab.filter((l) => dup.flagged.has(l.id)).length,
    [leadsForTab, dup],
  );
  /** Open the merge dialog for a lead: cluster = the lead + everything it dups. */
  const openMergeFor = React.useCallback((lead: Lead) => {
    const matches = dup.matchesOf.get(lead.id) ?? [];
    if (matches.length === 0) return;
    setMergeCluster([lead, ...matches.map((m) => m.lead)]);
  }, [dup]);

  // Force list view on mobile (Kanban with 6 vertical stage columns is
  // unusable on phones — each empty stage takes a screen-full).
  // Leads tab always renders as a list (raw leads only live in 'new' /
  // 'contacted', so 4 of 6 Kanban columns would always be empty).
  // Deals tab respects the user's saved preference, EXCEPT on mobile.
  const { isMobile } = useBreakpoint();
  const effectiveView = isMobile ? "list" : (tab === "leads" ? "list" : view);

  // Stats are based on Deals (where value lives — raw leads have no value yet).
  // "Open" deals = qualified but NOT closed (won/lost). Header stats use these
  // so "active deals" + "open pipeline" never count closed outcomes (a Lost
  // deal is not active pipeline). Conversion still uses the full qualified set
  // as the win-rate denominator.
  const openDeals  = qualifiedDeals.filter((l) => l.stage !== "won" && l.stage !== "lost");
  const totalValue = openDeals.reduce((s, l) => s + (l.value ?? 0), 0);
  const wonCount = qualifiedDeals.filter((l) => l.stage === "won").length;
  const conversion =
    qualifiedDeals.length > 0 ? Math.round((wonCount / qualifiedDeals.length) * 100) : 0;

  // Drag handlers
  const handleDrop = (toStage: Lead["stage"]) => {
    if (dragId) {
      const lead = filtered.find((l) => l.id === dragId);
      if (lead && lead.stage !== toStage) {
        updateStage.mutate({ id: dragId, stage: toStage });
        const stageLabel = LEAD_STAGES.find((s) => s.id === toStage)?.label;
        toast.success(`${lead.company} → ${stageLabel}`);
      }
    }
    setDragId(null);
    setOverStage(null);
  };

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto min-h-[calc(100vh-3.5rem)] md:h-[calc(100vh-3.5rem)] flex flex-col">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Sales</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">
            {isDealsPage ? "Deal Pipeline" : "Leads"}
          </h1>
          {!isLoading && leads && (
            isDealsPage ? (
              <div className="mt-2">
                <StatStrip
                  items={[
                    { label: "Active deals",  value: openDeals.length },
                    { label: "Open pipeline", value: rupee(totalValue, { compact: true }), tone: "amber" },
                    { label: "Won",           value: `${conversion}%`, tone: conversion > 0 ? "emerald" : "default" },
                  ]}
                />
              </div>
            ) : (
              <p className="text-sm text-ink-3 mt-1 tabular-nums">
                <b>{rawLeads.length}</b> open lead{rawLeads.length === 1 ? "" : "s"} · call them, email them, update status
              </p>
            )
          )}
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <div className="w-56">
            <Input
              prefix={<Icon name="search" size={14} />}
              placeholder={isDealsPage ? "Search deals…" : "Search leads…"}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {/* View toggle — Kanban for stage flow, List for scale (50+ leads).
              Hidden on the Leads tab because raw leads can only sit in 'new' /
              'contacted', making Kanban mostly empty columns. Leads tab always
              renders as a list (triage queue, not stage flow). Also hidden
              entirely for sales role (lead-only users don't need Kanban). */}
          {!isSales && (
            <div className={cn(
              // Hidden on mobile (Kanban makes no sense on phone, list is forced)
              // Hidden on Leads tab (always list anyway)
              "hidden md:inline-flex rounded-md border border-hairline overflow-hidden",
              tab === "leads" && "md:hidden",
            )}>
              <button
                type="button"
                onClick={() => setView("kanban")}
                className={cn(
                  "px-2.5 py-1.5 text-xs font-medium inline-flex items-center gap-1.5 transition-colors",
                  view === "kanban" ? "bg-ink text-paper" : "bg-paper text-ink-2 hover:bg-paper-2",
                )}
                aria-pressed={view === "kanban"}
                title="Kanban view — best for stage flow"
              >
                <Icon name="layout" size={13} /> Kanban
              </button>
              <button
                type="button"
                onClick={() => setView("list")}
                className={cn(
                  "px-2.5 py-1.5 text-xs font-medium inline-flex items-center gap-1.5 transition-colors border-l border-hairline",
                  view === "list" ? "bg-ink text-paper" : "bg-paper text-ink-2 hover:bg-paper-2",
                )}
                aria-pressed={view === "list"}
                title="List view — best for scanning many leads by value/age"
              >
                <Icon name="more_h" size={13} /> List
              </button>
            </div>
          )}
          {/* Filter dropdown — multi-select stage + priority. Active count
              shows as a badge on the button. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button icon="filter">
                Filter
                {activeFilterCount > 0 && (
                  <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-amber text-paper text-[10px] font-semibold px-1">
                    {activeFilterCount}
                  </span>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-ink-3">Stage</DropdownMenuLabel>
              {filterStages.map((s) => (
                <DropdownMenuCheckboxItem
                  key={s.id}
                  checked={stageFilter.includes(s.id)}
                  onCheckedChange={(checked) => {
                    setStageFilter((prev) =>
                      checked ? [...prev, s.id] : prev.filter((x) => x !== s.id),
                    );
                  }}
                  className="text-sm"
                >
                  <span className={cn("inline-block w-2 h-2 rounded-full mr-2", s.dot)} />
                  {s.label}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-ink-3">Priority</DropdownMenuLabel>
              {(["high","medium","low"] as const).map((p) => (
                <DropdownMenuCheckboxItem
                  key={p}
                  checked={priorityFilter.includes(p)}
                  onCheckedChange={(checked) => {
                    setPriorityFilter((prev) =>
                      checked ? [...prev, p] : prev.filter((x) => x !== p),
                    );
                  }}
                  className="text-sm capitalize"
                >
                  <span className={cn("inline-block w-2 h-2 rounded-full mr-2",
                    p === "high"   && "bg-rose",
                    p === "medium" && "bg-amber",
                    p === "low"    && "bg-slate",
                  )} />
                  {p}
                </DropdownMenuCheckboxItem>
              ))}
              {activeFilterCount > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => { setStageFilter([]); setPriorityFilter([]); }}
                    className="text-sm text-rose"
                  >
                    Clear all filters
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Advanced controls — hidden for sales role to keep the inbox
              focused on call/email/update. Owner/manager get the full set. */}
          {/* Secondary toolbar — desktop-only (hidden md:flex) so a phone's
              header doesn't wrap into a wall of buttons. "Start trial" shows
              ONLY on /deals: per the quote-first funnel a trial follows a quote,
              so offering it on the raw Leads inbox contradicts the model. */}
          {/* Secondary actions rolled into one "More" menu so the header stays
              clean — only Search / Filter / + Add Lead compete for attention. */}
          {!isSales && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="default" icon="more_h" className="hidden md:inline-flex">More</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setCsvImportOpen(true)}>
                  <Icon name="download" size={14} className="text-ink-3" /> Import CSV
                </DropdownMenuItem>
                <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setCampaignOpen(true)}>
                  <Icon name="send" size={14} className="text-ink-3" /> Send campaign
                </DropdownMenuItem>
                <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setGoogleImportOpen(true)}>
                  <Icon name="globe" size={14} className="text-ink-3" /> Import from Google
                </DropdownMenuItem>
                {isDealsPage && (
                  <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setTrialOpen(true)}>
                    <Icon name="clock" size={14} className="text-ink-3" /> Start trial
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setShareOpen(true)}>
                  <Icon name="link" size={14} className="text-ink-3" /> Share enquiry form
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* Add Lead / Deal split-button — hidden on mobile because the
              floating FAB at the bottom-right already provides the same
              action in a more thumb-friendly position.

              The primary button opens the full lead form (12+ fields). On the
              Leads tab a caret opens a dropdown that ALSO offers "Quick add"
              (4 fields). This replaced an earlier hover-reveal popup that was
              undiscoverable, not keyboard-accessible, and impossible to
              trigger on touch devices (no hover) — users reported clicking
              "Quick add" did nothing because the popup vanished on mouse-move. */}
          <div className="hidden md:inline-flex">
            <Button
              variant="primary"
              icon="plus"
              onClick={() => setAddOpen(true)}
              className={tab === "leads" ? "rounded-r-none" : undefined}
            >
              {tab === "leads" ? "Add Lead" : "Add Deal"}
            </Button>
            {tab === "leads" && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="primary"
                    icon="chevron_down"
                    aria-label="More ways to add a lead"
                    className="rounded-l-none border-l border-white/25 px-2"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  <DropdownMenuItem onSelect={() => setAddOpen(true)}>
                    <Icon name="plus" size={14} className="mr-2 text-ink-3" />
                    Full form · all fields
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setQuickOpen(true)}>
                    <Icon name="zap" size={14} className="mr-2 text-amber" />
                    Quick add · 4 fields
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </div>

      {/* Smart Views chip bar — saved filter combos as primary nav.
          Close/Attio/HubSpot pattern. Each chip = one work mode. */}
      {!isLoading && leads && leads.length > 0 && (
        <LeadsSmartViews
          leads={leadsForTab}
          currentUserId={currentUser?.userId}
          duplicateCount={duplicateCountForTab}
          junkCount={junkCount}
          junkSuspectCount={junkSuspectCount}
          active={smartView}
          onChange={setSmartView}
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
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
      {/* AI junk review — only in the Junk view. Lets the operator ask AI to
          decide across the spam pile (verdict + reason + confidence), then
          confirm with one tap. Reversible, human-in-the-loop. */}
      {smartView === "junk" && filtered.length > 0 && (
        <JunkAIReview leads={filtered} />
      )}

      {/* AI lead intelligence
          "Hot leads" = highest-value rows in quote/trial stages — these
          convert at the highest rate per the prototype-era data, and they're
          the ones a rep should actually touch today. The two action buttons
          target the single TOP hot lead (highest value) — Call opens the
          phone dialer; Send nudge opens the mail client with a pre-written
          follow-up. Both gracefully degrade if the contact info is missing. */}
      {!isLoading && leads && leads.length > 0 && !isSales && (() => {
        const hotLeads = filtered
          .filter((l) => l.stage === "quote" || l.stage === "trial")
          .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
        const topHot = hotLeads[0] ?? null;
        // The new Insight band (KPI pills + pulse) already surfaces "Hot"
        // count at the top of the page. Showing this card with a "0 hot
        // leads" empty state is just noise. Render only when there's
        // actually a hot lead to act on. Sales role gets the band only —
        // this card is owner/manager territory (it surfaces aggregate
        // tenant info beyond the rep's individual book).
        if (hotLeads.length === 0) return null;

        const handleCallTop = () => {
          if (!topHot) { toast.info("No hot leads right now"); return; }
          if (!topHot.contact_phone) {
            toast.error(`${topHot.company} has no phone on record · open the lead to add one`);
            return;
          }
          // tel: schemes ignore spaces but be defensive
          window.location.href = `tel:${topHot.contact_phone.replace(/\s+/g, "")}`;
        };

        const handleSendNudge = () => {
          if (!topHot) { toast.info("No hot leads right now"); return; }
          if (!topHot.contact_email) {
            toast.error(`${topHot.company} has no email on record · open the lead to add one`);
            return;
          }
          const signoff = currentUser?.tenantName ?? "your team";
          const subject = `Following up · ${topHot.company}`;
          const body =
            `Hi ${topHot.contact_name ?? "there"},\n\n` +
            `Just checking in on ${topHot.plan ? `the ${topHot.plan} discussion` : "your inquiry"}. ` +
            `Let me know if you have any questions or want to set up a quick call.\n\n` +
            `— ${signoff}`;
          window.location.href = `mailto:${topHot.contact_email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        };

        return (
          // Hidden on mobile — eats vertical real estate that sales reps need
          // for the actual lead list. Desktop keeps it visible since there's
          // plenty of width.
          <div className="mb-4 hidden md:block">
            {tipsOpen ? (
              <GeminiCard
                title="Lead intelligence · Today"
                actions={
                  <>
                    <Button size="sm" variant="primary" icon="phone" disabled={!topHot} onClick={handleCallTop}>
                      {topHot ? `Call ${topHot.company.split(/\s+/)[0]}` : "Call top lead"}
                    </Button>
                    <Button size="sm" icon="mail" disabled={!topHot} onClick={handleSendNudge}>Send nudge</Button>
                    <Button size="sm" variant="ghost" icon="chevron_up" aria-label="Hide tips" onClick={toggleTips} />
                  </>
                }
              >
                <b className="text-ink">{hotLeads.length} hot lead{hotLeads.length === 1 ? "" : "s"} worth focusing today.</b>{" "}
                {topHot
                  ? <>Top: <b>{topHot.company}</b> ({topHot.plan ?? "—"}, {topHot.value ? rupee(topHot.value, { compact: true }) : "value pending"}). Quote/Trial stages convert highest — prioritize today.</>
                  : <>No leads in Quote Sent or Trial Active right now. Move some forward to surface hot opportunities.</>}
              </GeminiCard>
            ) : (
              <button
                type="button"
                onClick={toggleTips}
                className="w-full flex items-center justify-between gap-2 rounded-lg border border-hairline bg-paper-2/40 px-3 py-1.5 text-xs text-ink-2 hover:bg-paper-2"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="sparkles" size={13} className="text-amber-ink" />
                  Lead intelligence · <b className="text-ink">{hotLeads.length}</b> hot lead{hotLeads.length === 1 ? "" : "s"} today
                </span>
                <span className="inline-flex items-center gap-1 text-ink-3"><Icon name="chevron_down" size={13} /> Show</span>
              </button>
            )}
          </div>
        );
      })()}

      {/* Tab bar removed after the /leads + /deals split — navigation between
          the two views is now via sidebar entries. The single-page tab UI
          confused sales reps and added a click for owner/manager too. */}

      {/* Today's follow-ups widget — sales rep ki morning worklist.
          Counts leads where follow_up_date is today OR earlier (overdue too).
          Click the header to expand the actual list of due leads; tap any
          row to open that lead's detail drawer. Hidden if no leads have
          follow_up_date set or none are due. */}
      {(() => {
        if (!leads || leads.length === 0) return null;
        const today      = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
        const dueToday   = leads.filter((l) => l.follow_up_date && l.follow_up_date <= today &&
                                                l.stage !== "won" && l.stage !== "lost");
        if (dueToday.length === 0) return null;
        const overdueCount = dueToday.filter((l) => (l.follow_up_date ?? "") < today).length;
        const totalValue   = dueToday.reduce((s, l) => s + (l.value ?? 0), 0);
        // Most-overdue first (earliest follow_up_date), today's last.
        const sortedDue = [...dueToday].sort(
          (a, b) => (a.follow_up_date ?? "").localeCompare(b.follow_up_date ?? ""),
        );
        return (
          <div className="rounded-lg border border-amber/30 bg-amber-soft/40 mb-3 md:mb-4 overflow-hidden min-w-0">
            {/* Header — click to expand/collapse the list */}
            <button
              type="button"
              onClick={() => setDueListOpen((o) => !o)}
              aria-expanded={dueListOpen}
              className="w-full flex items-center gap-2 md:gap-3 px-3 py-2 md:p-3 text-left hover:bg-amber-soft/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset"
            >
              <Icon name="clock" size={13} className="text-amber-ink flex-shrink-0" />
              <p className="text-[12px] md:text-sm text-ink truncate min-w-0 flex-1">
                <b className="text-amber-ink">{dueToday.length}</b>
                <span className="text-ink-2"> follow-up{dueToday.length === 1 ? "" : "s"} due today</span>
                {overdueCount > 0 && (
                  <span className="text-rose text-[11px] md:text-xs ml-1.5">({overdueCount} overdue)</span>
                )}
                {/* Desktop-only preview line (companies + total value) */}
                <span className="hidden md:inline text-[11px] text-ink-3 ml-2">
                  · {dueToday.slice(0, 3).map((l) => l.company).join(" · ")}
                  {dueToday.length > 3 && ` · +${dueToday.length - 3} more`}
                  {totalValue > 0 && ` · ${rupee(totalValue, { compact: true })} value`}
                </span>
              </p>
              <span className="text-[11px] text-amber-ink font-semibold hidden sm:inline flex-shrink-0">
                {dueListOpen ? "Hide" : "View list"}
              </span>
              <Icon
                name="chevron_down"
                size={16}
                className={cn("text-amber-ink flex-shrink-0 transition-transform", dueListOpen && "rotate-180")}
              />
            </button>

            {/* Expanded list — one tappable row per due lead */}
            {dueListOpen && (
              <div className="border-t border-amber/20 bg-paper/70 max-h-[320px] overflow-y-auto">
                {sortedDue.map((l) => {
                  const od = (l.follow_up_date ?? "") < today;
                  const sub = [
                    l.contact_name || l.contact_phone,
                    l.plan,
                    l.value ? rupee(l.value, { compact: true }) : null,
                  ].filter(Boolean).join(" · ");
                  return (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => setSelected(l)}
                      className="w-full flex items-center gap-3 px-3 py-2 text-left border-b border-hairline/60 last:border-b-0 hover:bg-amber-soft/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset"
                    >
                      <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", od ? "bg-rose" : "bg-amber")} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-ink font-medium truncate">{l.company}</span>
                        <span className="block text-[11px] text-ink-3 truncate">{sub || "—"}</span>
                      </span>
                      <span className="flex-shrink-0 text-right">
                        <span className={cn("block text-[11px] font-semibold", od ? "text-rose" : "text-amber-ink")}>
                          {od ? "Overdue" : "Due today"}
                        </span>
                        <span className="block text-[10px] text-ink-3">{formatDate(l.follow_up_date!)}</span>
                      </span>
                      <Icon name="chevron_right" size={14} className="text-ink-3 flex-shrink-0" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {/* Error */}
      {error && (
        <EmptyState
          icon="alert"
          title="Could not load leads"
          body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
        />
      )}

      {/* Loading */}
      {isLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 flex-1 min-h-0">
          {LEAD_STAGES.map((s) => (
            <div key={s.id} className="bg-paper-2 border-2 border-dashed border-hairline rounded-lg p-2.5 min-h-[400px]">
              <div className="flex items-center gap-1.5 mb-3 px-1">
                <span className={cn("w-1.5 h-1.5 rounded-full", s.dot)} />
                <span className="text-xs font-semibold">{s.label}</span>
              </div>
              <div className="space-y-2">
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty — copy + CTAs swap based on which page we're on. Import CSV
          stays a secondary action for owner/manager only (sales role has it
          hidden from the toolbar above; keeping it consistent here). */}
      {!isLoading && !error && leads && leads.length === 0 && (
        <EmptyState
          icon="target"
          title={isDealsPage ? "No deals yet" : "No leads yet"}
          body={
            isDealsPage
              ? "Qualified deals will appear here once a lead picks a plan. You can also add deals manually with a known seat count + value."
              : "Leads will appear here when customers fill the contact form, or you can add them manually."
          }
          action={
            <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
              {isDealsPage ? "Add your first deal" : "Add your first lead"}
            </Button>
          }
          secondary={!isSales ? <Button icon="download" onClick={() => setCsvImportOpen(true)}>Import CSV</Button> : undefined}
        />
      )}

      {/* Per-view empty — tenant HAS leads but the active smart view filter
          hides all of them. Purpose-specific message per view (research
          finding: generic "no results" loses users; targeted copy with a
          relevant action recovers them). */}
      {!isLoading && !error && leads && leads.length > 0 && filtered.length === 0 && smartView !== "all" && (
        <EmptyState
          icon={
            smartView === "today"   ? "clock" :
            smartView === "hot"     ? "zap" :
            smartView === "new"     ? "inbox" :
            smartView === "won-mtd" ? "trending_up" :
            smartView === "mine"    ? "user" : "target"
          }
          title={
            smartView === "today"   ? "No new leads today" :
            smartView === "hot"     ? "No hot leads right now" :
            smartView === "new"     ? "No new leads" :
            smartView === "won-mtd" ? "No wins this month yet" :
            smartView === "mine"    ? "You don't own any leads yet" :
            "No leads match this view"
          }
          body={
            smartView === "today"   ? "No new leads came in today. Use the Add Lead button to add one manually — new inbound leads will show up here." :
            smartView === "hot"     ? "No leads in Demo / Trial / Quote stage. Move qualified leads forward to surface hot opportunities." :
            smartView === "new"     ? "Inbox is clear. Switch to Hot or Won MTD to see what's moving." :
            smartView === "won-mtd" ? "Close your first deal this month — it'll show up here." :
            smartView === "mine"    ? "Leads assigned to you will appear here. Switch to All to see everyone's." :
            "Try a different view or clear filters."
          }
          action={
            <Button variant="primary" icon="eye" onClick={() => setSmartView("all")}>
              Show all leads
            </Button>
          }
        />
      )}

      {/* Kanban — only shows on Deals tab (raw leads in the Leads tab have
          no meaningful stage flow, so we force list view there).
          flex-1 + min-h-0 lets the grid stretch to fill remaining viewport
          height (page wrapper is min-h-[calc(100vh-3.5rem)] flex-col), so
          columns visually fill instead of bottom cream area showing. */}
      {!isLoading && !error && leads && leads.length > 0 && effectiveView === "kanban" && (
        <>
          {/* Auto-fit: columns keep a usable min width (200px) and grow to fill;
              when 6 don't fit, the board scrolls horizontally instead of crushing. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-flow-col lg:auto-cols-[minmax(200px,1fr)] lg:grid-rows-1 auto-rows-fr gap-3 overflow-x-auto pb-4 flex-1 min-h-0">
            {DEAL_STAGES.map((stage) => {
              const stageLeads = filtered.filter((l) => l.stage === stage.id);
              const stageValue = stageLeads.reduce((s, l) => s + (l.value ?? 0), 0);
              const isOver = overStage === stage.id;

              return (
                <div
                  key={stage.id}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOverStage(stage.id);
                  }}
                  onDragLeave={() => setOverStage(null)}
                  onDrop={() => handleDrop(stage.id)}
                  className={cn(
                    "rounded-lg p-2.5 flex flex-col gap-2 min-h-0 overflow-y-auto",
                    "transition-colors",
                    "bg-paper-2",
                    isOver
                      ? "border-2 border-solid border-amber"
                      : "border-2 border-dashed border-hairline"
                  )}
                >
                  {/* Column header */}
                  <div className="flex items-center justify-between px-1 py-1">
                    <div className="flex items-center gap-1.5">
                      <span className={cn("w-1.5 h-1.5 rounded-full", stage.dot)} />
                      <span className="text-xs font-semibold text-ink">{stage.label}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-paper-2 text-ink-3 tabular-nums">
                        {stageLeads.length}
                      </span>
                    </div>
                    <span className="font-serif text-sm text-ink-3 tabular-nums">
                      {stageValue > 0 ? rupee(stageValue, { compact: true }) : ""}
                    </span>
                  </div>

                  {/* Cards */}
                  {stageLeads.map((lead) => (
                    <LeadCard
                      key={lead.id}
                      lead={lead}
                      isDragging={dragId === lead.id}
                      onDragStart={setDragId}
                      onDragEnd={() => {
                        setDragId(null);
                        setOverStage(null);
                      }}
                      onClick={(l) => setSelected(l)}
                    />
                  ))}

                  {/* Add affordance */}
                  <button
                    onClick={() => setAddOpen(true)}
                    className={cn(
                      "border border-dashed border-hairline rounded-md py-2 px-2",
                      "text-xs text-ink-3 hover:text-ink hover:border-hairline-strong",
                      "flex items-center justify-center gap-1 transition-colors",
                      stageLeads.length === 0 ? "" : "mt-1"
                    )}
                  >
                    <Icon name="plus" size={12} /> Add deal
                  </button>
                </div>
              );
            })}
          </div>

          {/* Help text */}
          <div className="flex items-center gap-2 text-xs text-ink-3 mt-1">
            <Icon name="info" size={12} />
            Drag any card across columns to update stage. Activity log updates automatically.
          </div>
        </>
      )}

      {/* List view — sortable table, designed for scanning at 50+ leads.
          Also the only view available on the Leads tab (triage queue).
          Only render when there ARE rows to show — otherwise the table's
          internal "No leads match." row appears AND the smart empty state
          below also fires, creating a duplicate. Skipping the table here
          lets the smart empty state below own the empty-screen real estate. */}
      {!isLoading && !error && leads && leads.length > 0 && effectiveView === "list" && filtered.length > 0 && (
        <LeadListView
          leads={filtered}
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
          onRowClick={(l) => setSelected(l)}
          onSendQuote={goSendQuote}
          onFollowUp={setFollowUpLead}
          onMerge={openMergeFor}
          dupIds={dup.flagged}
          isDealsPage={isDealsPage}
        />
      )}

      {/* No results from search OR tab cross-over hint.
          The /leads tab shows only raw inquiries (no plan picked); /deals
          shows qualified opportunities (plan set). When tenant has plenty
          of data but the current tab is empty, point the operator at the
          right place instead of generic "no results". */}
      {!isLoading && !error && leads && leads.length > 0 && filtered.length === 0 && smartView === "all" && (
        <div className="mt-6">
          {search.trim() ? (
            <EmptyState
              icon="search"
              title="No leads match"
              body={`No results for "${search}". Try a different search term.`}
              action={<Button icon="x" onClick={() => setSearch("")}>Clear search</Button>}
              compact
            />
          ) : tab === "leads" && qualifiedDeals.length > 0 ? (
            (() => {
              // Active count = qualified, NOT Won/Lost. Matches the sidebar
              // badge logic so the two numbers reconcile (Pardeep dogfood:
              // body said "18 qualified" while sidebar said "14" — that 4
              // gap was Won + Lost. Show active count by default; mention
              // closed only if meaningful (>0).
              const activeDeals = qualifiedDeals.filter((l) => l.stage !== "won" && l.stage !== "lost").length;
              const closedDeals = qualifiedDeals.length - activeDeals;
              return (
                <EmptyState
                  icon="trending_up"
                  title="All your leads have been qualified"
                  body={
                    closedDeals > 0
                      ? `No raw inquiries pending qualification. You have ${activeDeals} active ${activeDeals === 1 ? "deal" : "deals"} in pipeline (+ ${closedDeals} closed). Drag them through stages on the Deals page.`
                      : `No raw inquiries pending qualification. Your ${activeDeals} qualified ${activeDeals === 1 ? "deal is" : "deals are"} on the Deals page — drag them through stages there.`
                  }
                  action={
                    <Button variant="primary" icon="arrow_right" onClick={() => router.push("/deals" as any)}>
                      Go to Deals
                    </Button>
                  }
                  secondary={
                    <Button icon="plus" onClick={() => setAddOpen(true)}>
                      Add a raw lead
                    </Button>
                  }
                  compact
                />
              );
            })()
          ) : tab === "deals" && rawLeads.length > 0 ? (
            <EmptyState
              icon="inbox"
              title="No qualified deals yet"
              body={`You have ${rawLeads.length} raw ${rawLeads.length === 1 ? "lead" : "leads"} awaiting qualification on the Leads page. Pick a plan to qualify them into the pipeline.`}
              action={
                <Button variant="primary" icon="arrow_right" onClick={() => router.push("/leads" as any)}>
                  Go to Leads
                </Button>
              }
              compact
            />
          ) : (
            <EmptyState
              icon="search"
              title="No leads match"
              body="No results match the active filters. Try clearing filters or stage selection."
              action={<Button icon="x" onClick={() => { setStageFilter([]); setPriorityFilter([]); }}>Clear filters</Button>}
              compact
            />
          )}
        </div>
      )}

        </div>{/* /flex-1 main column */}

      </div>{/* /flex split */}

      {/* Detail drawer */}
      <LeadDetailSheet
        lead={selected}
        onClose={() => setSelected(null)}
        onEdit={(l) => {
          setSelected(null);
          setEditingLead(l);
          setAddOpen(true);
        }}
      />

      {/* Row "Follow-up" quick action → schedule a task linked to this lead */}
      {followUpLead && (
        <AddTaskDialog
          open
          onOpenChange={(o) => { if (!o) setFollowUpLead(null); }}
          linkLabel={followUpLead.company}
          linkTo={{ lead_id: followUpLead.id }}
        />
      )}

      {/* Merge duplicates — opened from a row's "Duplicate?" flag */}
      {mergeCluster && mergeCluster.length > 1 && (
        <MergeLeadsDialog cluster={mergeCluster} onClose={() => setMergeCluster(null)} />
      )}

      {/* Add / Edit lead modal */}
      <AddLeadForm
        open={addOpen}
        onOpenChange={(o) => {
          setAddOpen(o);
          if (!o) setEditingLead(null);
        }}
        editingLead={editingLead}
        // On the Deal Pipeline, "Add Deal" creates a NEW record straight in the
        // pipeline (stage "quote") so it actually shows up here.
        defaultStage={isDealsPage ? "quote" : undefined}
      />

      {/* Quick add — 4-field minimal lead capture (company + contact only). */}
      <QuickAddLeadForm
        open={quickOpen}
        onOpenChange={setQuickOpen}
      />

      <StartTrialDialog open={trialOpen} onOpenChange={setTrialOpen} />

      <CampaignComposerDialog open={campaignOpen} onOpenChange={setCampaignOpen} />

      <GoogleContactsImportDialog open={googleImportOpen} onOpenChange={setGoogleImportOpen} />

      {/* CSV bulk upload — 4-field minimal capture, matches Quick form. */}
      <ImportCsvDialog
        open={csvImportOpen}
        onOpenChange={setCsvImportOpen}
        onImportComplete={() => refetch()}
      />

      {/* Share the public enquiry form — collect a prospect's details, auto-creates a lead. */}
      {shareOpen && <ShareFormSheet target={ENQUIRY_SHARE} onClose={() => setShareOpen(false)} />}

      {/* Mobile FAB — thumb-zone primary action, label switches with the URL.
          /leads → "Add lead", /deals → "Add deal".
          The stacked mini-FAB above ("⚡ Quick") opens the 4-field quick
          capture form — same hover-reveal pattern we use on desktop, but
          here it's always-visible since mobile has no hover. */}
      <FAB
        icon="plus"
        label={tab === "leads" ? "Add lead" : "Add deal"}
        onClick={() => setAddOpen(true)}
        quickAction={{
          icon:      "zap",
          label:     "Quick",
          ariaLabel: "Quick add lead — only company + contact + email + phone",
          onClick:   () => setQuickOpen(true),
        }}
      />
    </div>
  );
}

// ============================================================
// Lead detail Sheet (slide-out drawer on card click)
// ============================================================
const ACTIVITY_META: Record<string, { icon: React.ComponentProps<typeof Icon>["name"]; label: string }> = {
  email:    { icon: "mail",    label: "Email sent" },
  email_in: { icon: "inbox",   label: "Reply received" },
  call:     { icon: "phone",   label: "Call" },
  whatsapp: { icon: "whatsapp", label: "WhatsApp" },
  note:     { icon: "edit",    label: "Note" },
  quote:    { icon: "file",    label: "Quote" },
  stage:    { icon: "refresh", label: "Stage change" },
};
function fmtActTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

/** Open a WhatsApp chat — WhatsApp Web on desktop, the app on mobile. */
function openWhatsApp(rawNumber: string, text?: string) {
  const num = (rawNumber || "").replace(/\D/g, "");
  if (!num) return;
  const isMobile = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const q = text ? `${isMobile ? "?" : "&"}text=${encodeURIComponent(text)}` : "";
  const url = isMobile
    ? `https://wa.me/${num}${q}`
    : `https://web.whatsapp.com/send?phone=${num}${q}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

function LeadDetailSheet({
  lead,
  onClose,
  onEdit,
}: {
  lead: Lead | null;
  onClose: () => void;
  onEdit: (lead: Lead) => void;
}) {
  const router      = useRouter();
  const updateStage = useUpdateLeadStage();
  const deleteLead  = useDeleteLead();
  const confirm     = useConfirm();
  const { data: currentUser } = useCurrentUser();
  const logActivity = useLogLeadActivity();
  const { data: activities = [] } = useLeadActivities(lead?.id);
  const [drawerTab, setDrawerTab] = React.useState<"details" | "followups" | "activity">("details");
  React.useEffect(() => { setDrawerTab("details"); }, [lead?.id]);

  // Drag-to-resize the drawer (desktop only): the left edge is a grab handle;
  // the chosen width is remembered per browser. Mobile stays full-width.
  const [panelWidth, setPanelWidth] = React.useState<number | null>(null);
  const widthRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    const saved = Number(localStorage.getItem("lead_drawer_w"));
    if (saved >= 360) { setPanelWidth(saved); widthRef.current = saved; }
  }, []);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(360, Math.min(window.innerWidth - ev.clientX, window.innerWidth * 0.95));
      widthRef.current = w;
      setPanelWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      if (widthRef.current) localStorage.setItem("lead_drawer_w", String(Math.round(widthRef.current)));
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // History: every quote that's been sent to this lead
  const { data: quotesForLead = [] } = useQuotesByLead(lead?.id);

  // Follow-up tasks linked to this lead — drives the "Follow-ups" drawer section
  const { data: tasksForLead = [] } = useTasksForLead(lead?.id);
  const completeTask = useCompleteTask();
  const snoozeTask   = useSnoozeTask();
  const deleteTask   = useDeleteTask();
  const [addTaskOpen, setAddTaskOpen] = React.useState(false);
  const [whatsOpen,   setWhatsOpen]   = React.useState(false);

  if (!lead) return null;
  const hasQuotes = quotesForLead.length > 0;
  const openTasks = tasksForLead.filter((t) => t.status === "pending" || t.status === "snoozed");
  const doneTasks = tasksForLead.filter((t) => t.status === "done");

  const handleDelete = async () => {
    const confirmed = await confirm({
      title: `Permanently delete lead "${lead.company}"?`,
      body: "This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    deleteLead.mutate(lead.id, {
      onSuccess: () => onClose(),
    });
  };

  const handleSendQuote = () => {
    // Pass lead context to QuoteBuilder via URL params
    const params = new URLSearchParams();
    params.set("leadId",  lead.id);
    params.set("company", lead.company);
    if (lead.plan)            params.set("plan",  lead.plan);
    if (lead.seats != null)   params.set("seats", String(lead.seats));
    if (lead.contact_name)    params.set("contact", lead.contact_name);
    if (lead.contact_email)   params.set("email", lead.contact_email);
    if (lead.contact_phone)   params.set("phone", lead.contact_phone);
    onClose();
    router.push(`/quotes/new?${params.toString()}` as any);
  };

  // If lead already has a quote, default the primary CTA to "Revise & resend"
  // (duplicate the latest quote, edit, resend). This avoids accidental duplicates
  // and keeps audit history clean.
  const latestQuote = quotesForLead[0]; // sorted by created_date desc
  const handleReviseQuote = () => {
    if (!latestQuote) return handleSendQuote();
    const params = new URLSearchParams();
    params.set("duplicate", latestQuote.id);
    params.set("leadId",    lead.id);
    params.set("company",   lead.company);
    if (lead.contact_name)  params.set("contact", lead.contact_name);
    if (lead.contact_email) params.set("email",   lead.contact_email);
    if (lead.contact_phone) params.set("phone",   lead.contact_phone);
    onClose();
    router.push(`/quotes/new?${params.toString()}` as any);
  };

  const handleEmail = () => {
    if (!lead.contact_email) {
      toast.error("No email on this lead");
      return;
    }
    const subject = `About your inquiry · ${lead.company}`;
    const signoff = currentUser?.tenantName ?? "your team";
    const body    = `Hi ${lead.contact_name ?? "there"},\n\nThanks for your interest in ${lead.plan ?? "our services"}. Let me know a good time to connect.\n\n— ${signoff}`;
    // Open Gmail compose in a new tab — reliable across machines (a raw mailto:
    // does nothing when no desktop mail client is configured).
    const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(lead.contact_email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    logActivity.mutate({ leadId: lead.id, kind: "email", detail: `Emailed ${lead.contact_email} · ${subject}` });
    toast.success("Logged on the lead's timeline");
  };

  const handleArchive = () => {
    updateStage.mutate({ id: lead.id, stage: "lost" });
    toast.success(`${lead.company} archived`);
    onClose();
  };

  // Smart "next action" suggestion — tells the rep THE one thing to do next
  // instead of making them stare at 10 buttons trying to decide. Pattern from
  // Linear / Notion: cut decision fatigue by surfacing the most likely next
  // move, ranked by lead state + quote age + payment status.
  // Must be declared AFTER handleSendQuote / handleReviseQuote since it
  // closes over them.
  const latestQuoteForAction = quotesForLead[0]; // sorted desc by created_date
  const quoteAgeDays = latestQuoteForAction
    ? Math.floor((Date.now() - new Date(latestQuoteForAction.created_date).getTime()) / (24 * 60 * 60 * 1000))
    : null;

  type NextAction = {
    label: string;
    icon: string;
    tone: "amber" | "rose" | "emerald" | "indigo";
    onClick: () => void;
    hint?: string;
    help?: string;
  };
  const nextAction: NextAction | null = (() => {
    // 1. Paid quote → issue invoice / view invoice / record remainder
    if (latestQuoteForAction?.payment_status === "received") {
      return {
        label: "Issue GST invoice",
        icon: "receipt",
        tone: "emerald",
        onClick: () => { onClose(); router.push(`/quotes/${latestQuoteForAction.id}` as any); },
        hint: `Paid · ₹${(latestQuoteForAction.payment_amount ?? 0).toLocaleString("en-IN")}`,
      };
    }
    if (latestQuoteForAction?.payment_status === "invoiced") {
      return {
        label: "View invoice",
        icon: "receipt",
        tone: "emerald",
        onClick: () => { onClose(); router.push(`/quotes/${latestQuoteForAction.id}` as any); },
        hint: "Already invoiced",
      };
    }
    if (latestQuoteForAction?.payment_status === "partial") {
      return {
        label: "Record remaining payment",
        icon: "rupee",
        tone: "amber",
        onClick: () => { onClose(); router.push(`/quotes/${latestQuoteForAction.id}` as any); },
        hint: "Partial received",
      };
    }
    // 2. Draft quote exists but was never sent → prompt to SEND it (open the
    //    draft), not "revise & resend / chase". A draft has no sent-date, so the
    //    age-based "Sent today / Nd ago" copy below would be misleading.
    if (latestQuoteForAction?.status === "draft") {
      return {
        label: "Send draft quote",
        icon: "send",
        tone: "amber",
        onClick: () => { onClose(); router.push(`/quotes/${latestQuoteForAction.id}` as any); },
        hint: "Not sent yet",
      };
    }
    // 3. Quote SENT but not yet paid → the goal now is getting PAID, so the
    //    primary action is "Record payment" (→ the quote hub, where you can also
    //    preview / resend). Chasing is the header WhatsApp/Call buttons; revising
    //    is the footer "Revise & resend" — so the big CTA drives the money moment,
    //    NOT the edit builder (which is what it wrongly used to open).
    if (latestQuoteForAction && quoteAgeDays !== null) {
      const overdue = quoteAgeDays > 7;
      const ageText = quoteAgeDays === 0 ? "Sent today" : `Sent ${quoteAgeDays}d ago`;
      return {
        label: "Record payment",
        icon: "rupee",
        tone: overdue ? "rose" : "amber",
        onClick: () => { onClose(); router.push(`/quotes/${latestQuoteForAction.id}` as any); },
        hint: overdue ? `${ageText} · overdue — chase them` : ageText,
        help: "Quote is sent. Record the payment here the moment it lands. To chase, use the WhatsApp/Call buttons above; to change the quote, use Revise & resend below.",
      };
    }
    // 4. No quote yet → by stage
    if (lead.stage === "lost") {
      return { label: "Re-engage · send new quote", icon: "send", tone: "indigo", onClick: handleSendQuote };
    }
    if (lead.stage === "won") {
      return { label: "Upsell · new quote", icon: "send", tone: "indigo", onClick: handleSendQuote };
    }
    if (lead.stage === "new" && lead.contact_phone) {
      return { label: "Call now · first contact", icon: "mobile", tone: "amber", onClick: () => { window.location.href = `tel:${lead.contact_phone}`; }, hint: lead.contact_phone ?? undefined };
    }
    if (lead.stage === "trial") {
      return { label: "Convert trial · send quote", icon: "send", tone: "amber", onClick: handleSendQuote };
    }
    // Default: send quote (covers contact/demo stages with no quote yet)
    return { label: "Send Quote", icon: "send", tone: "amber", onClick: handleSendQuote };
  })();

  const stageLabel = LEAD_STAGES.find((s) => s.id === lead.stage)?.label ?? lead.stage;

  return (
    <Sheet open={!!lead} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full sm:w-[var(--lead-w)] sm:max-w-[95vw] p-0 flex flex-col"
        style={{ ["--lead-w" as string]: panelWidth ? `${panelWidth}px` : "28rem" } as React.CSSProperties}
        hideClose
      >
        {/* Drag handle on the left edge — grab to widen/narrow the panel (desktop). */}
        <div
          onMouseDown={startResize}
          className="hidden sm:block absolute inset-y-0 left-0 z-30 w-2 -ml-1 cursor-ew-resize group"
          title="Drag to resize"
          aria-hidden
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-hairline group-hover:bg-amber group-hover:w-1 transition-all" />
        </div>
        <SheetHeader className="!p-5 flex flex-row items-start justify-between gap-3 border-b border-hairline">
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Lead detail</p>
            <SheetTitle className="text-xl mt-1">{lead.company}</SheetTitle>
            <SheetDescription className="text-xs mt-1">
              {lead.id} · Stage: <b className="text-ink">{stageLabel}</b>
            </SheetDescription>
          </div>
          <IconButton icon="x" aria-label="Close" onClick={onClose} />
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Contact action card — first thing in the drawer per research
              (Close.com / Folk pattern). Shows the rep's three primary
              reach-out actions as big tap targets + a GST badge for B2B
              context. Replaces the need to scroll for contact info. */}
          {(lead.contact_phone || lead.contact_email || lead.gstin) && (
            <div className="rounded-lg border border-hairline bg-paper-2/40 p-3">
              {/* Top row — contact name + GST badge if present */}
              <div className="flex items-center justify-between gap-2 mb-3 min-w-0">
                <div className="min-w-0 flex-1">
                  {lead.contact_name && (
                    <p className="font-medium text-ink text-sm truncate">{lead.contact_name}</p>
                  )}
                  {(lead.contact_phone || lead.contact_email) && (
                    <p className="text-[11px] text-ink-3 font-mono truncate">
                      {lead.contact_phone}
                      {lead.contact_phone && lead.contact_email && " · "}
                      {lead.contact_email}
                    </p>
                  )}
                </div>
                {lead.gstin && (
                  <span
                    className="shrink-0 inline-flex items-center gap-1 text-[10px] font-mono font-semibold uppercase px-1.5 py-0.5 rounded bg-indigo-soft text-indigo-ink border border-indigo/20"
                    title="GST Identification Number"
                  >
                    GST {lead.gstin.slice(0, 2)}…
                  </span>
                )}
              </div>

              {/* Action row — Call / WhatsApp / Email as big buttons.
                  These are the rep's bread-and-butter — surface them
                  prominently so 1 tap = action, no scrolling needed. */}
              <div className="grid grid-cols-3 gap-2">
                {lead.contact_phone ? (
                  <a
                    href={`tel:${lead.contact_phone.replace(/\s+/g, "")}`}
                    className="inline-flex items-center justify-center gap-1.5 py-2 rounded-md bg-paper border border-hairline hover:bg-emerald-soft/40 text-emerald text-xs font-semibold transition-colors"
                  >
                    <Icon name="mobile" size={13} /> Call
                  </a>
                ) : (
                  <div className="inline-flex items-center justify-center gap-1.5 py-2 rounded-md bg-paper-2 border border-hairline text-ink-3 text-xs">
                    <Icon name="mobile" size={13} /> —
                  </div>
                )}
                {lead.contact_phone ? (
                  (() => {
                    const phoneDigits = lead.contact_phone.replace(/\D/g, "");
                    const waNumber = phoneDigits.startsWith("91") ? phoneDigits : (phoneDigits.length === 10 ? `91${phoneDigits}` : phoneDigits);
                    const greeting = lead.contact_name ? `Hi ${lead.contact_name},` : "Hello,";
                    const ref = lead.plan ? `about ${lead.plan} for ${lead.company}` : `regarding ${lead.company}`;
                    const waMsg = `${greeting} Following up ${ref}. When's a good time for a quick call?`;
                    return (
                      <a
                        href={`https://wa.me/${waNumber}?text=${encodeURIComponent(waMsg)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => {
                          e.preventDefault();
                          openWhatsApp(waNumber, waMsg);
                          logActivity.mutate({ leadId: lead.id, kind: "whatsapp", detail: `WhatsApp to ${lead.contact_phone}` });
                        }}
                        className="inline-flex items-center justify-center gap-1.5 py-2 rounded-md bg-paper border border-hairline hover:bg-emerald-soft/40 text-emerald text-xs font-semibold transition-colors"
                      >
                        <Icon name="whatsapp" size={13} /> WhatsApp
                      </a>
                    );
                  })()
                ) : (
                  <div className="inline-flex items-center justify-center gap-1.5 py-2 rounded-md bg-paper-2 border border-hairline text-ink-3 text-xs">
                    <Icon name="whatsapp" size={13} /> —
                  </div>
                )}
                {lead.contact_email ? (
                  <a
                    href={`mailto:${lead.contact_email}`}
                    onClick={(e) => { e.preventDefault(); handleEmail(); }}
                    className="inline-flex items-center justify-center gap-1.5 py-2 rounded-md bg-paper border border-hairline hover:bg-indigo-50 text-indigo text-xs font-semibold transition-colors"
                  >
                    <Icon name="mail" size={13} /> Email
                  </a>
                ) : (
                  <div className="inline-flex items-center justify-center gap-1.5 py-2 rounded-md bg-paper-2 border border-hairline text-ink-3 text-xs">
                    <Icon name="mail" size={13} /> —
                  </div>
                )}
              </div>

              {/* AI draft — the "what do I say?" moat. One tap = a Gemini-drafted
                  WhatsApp/email follow-up tailored to THIS lead (plan, seats,
                  stage, notes). Human-in-the-loop: the draft is editable and never
                  sends itself — the rep copies it or opens WhatsApp. Falls back to
                  a solid template if no Gemini key is set. */}
              {(lead.contact_phone || lead.contact_email) && (
                <AiDraftButton
                  leadId={lead.id}
                  channel={lead.contact_phone ? "whatsapp" : "email"}
                  purpose="followup"
                  phone={lead.contact_phone}
                  label="✨ Draft follow-up with AI"
                  variant="outline"
                  className="mt-2 w-full justify-center"
                />
              )}

              {/* Smart Next-Action CTA — surfaces THE one thing to do based on
                  lead state + quote age + payment status. Replaces decision
                  fatigue ("which of these 10 buttons?") with a single ranked
                  suggestion. Logic in `nextAction` above; color-coded by
                  urgency (rose = overdue, amber = pending, emerald = success,
                  indigo = informational). */}
              {/* When a quote already exists, surface the FULL status-aware quote
                  action bar right here (Record payment · Mark accepted · Mark
                  rejected · Open full quote) — the rep never has to leave the
                  drawer to move the quote forward. Falls back to the single smart
                  next-action CTA only when there's no quote yet. */}
              {latestQuoteForAction ? (
                <div className="mt-3 space-y-1.5">
                  <QuoteActionBar
                    quote={latestQuoteForAction}
                    onOpenFullQuote={() => { onClose(); router.push(`/quotes/${latestQuoteForAction.id}` as any); }}
                  />
                  {(() => {
                    const q = latestQuoteForAction;
                    const nothingReceivedYet =
                      !q.payment_status || q.payment_status === "none" || q.payment_status === "awaiting";
                    const unpaidSent =
                      (q.status === "sent" || q.status === "viewed") && nothingReceivedYet;
                    if (!unpaidSent) return null;
                    const overdue = quoteAgeDays !== null && quoteAgeDays > 7;
                    const ageText =
                      quoteAgeDays === null ? "" : quoteAgeDays === 0 ? "Sent today" : `Sent ${quoteAgeDays}d ago`;
                    return (
                      <p className="flex items-start gap-1 text-[11px] leading-snug text-ink-3">
                        <Icon name="info" size={11} className="mt-0.5 shrink-0" />
                        <span>
                          {ageText}
                          {overdue && <span className="text-rose font-medium"> · overdue — chase them</span>}
                          {ageText && ". "}
                          Record payment when it lands, or mark accepted to convert the lead into a customer now
                          (payment can follow). Chase via Call/WhatsApp above.
                        </span>
                      </p>
                    );
                  })()}
                </div>
              ) : nextAction ? (
                <>
                <button
                  type="button"
                  onClick={nextAction.onClick}
                  className={cn(
                    "mt-3 w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-md text-sm font-semibold transition-colors",
                    nextAction.tone === "amber"   && "bg-amber text-white hover:bg-amber/90",
                    nextAction.tone === "rose"    && "bg-rose text-white hover:bg-rose/90",
                    nextAction.tone === "emerald" && "bg-emerald text-white hover:bg-emerald/90",
                    nextAction.tone === "indigo"  && "bg-indigo text-white hover:bg-indigo/90",
                  )}
                >
                  <Icon name={nextAction.icon} size={14} />
                  {nextAction.label}
                  {nextAction.hint && (
                    <span className="text-[11px] opacity-90 ml-1">
                      · {nextAction.hint}
                    </span>
                  )}
                </button>
                {nextAction.help && (
                  <p className="mt-1.5 flex items-start gap-1 text-[11px] leading-snug text-ink-3">
                    <Icon name="info" size={11} className="mt-0.5 shrink-0" />
                    {nextAction.help}
                  </p>
                )}
                </>
              ) : null}
            </div>
          )}

          {/* Tabs — keep the ever-growing Activity log out of the main detail view */}
          <div className="flex gap-1 border-b border-hairline">
            {(["details", "followups", "activity"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setDrawerTab(t)}
                className={cn(
                  "px-3 py-2 text-xs font-semibold border-b-2 -mb-px transition-colors",
                  drawerTab === t ? "border-amber text-amber-ink" : "border-transparent text-ink-3 hover:text-ink",
                )}
              >
                {t === "activity"
                  ? `Activity${activities.length ? ` (${activities.length})` : ""}`
                  : t === "followups"
                    ? `Follow-ups${openTasks.length ? ` (${openTasks.length})` : ""}`
                    : "Details"}
              </button>
            ))}
          </div>

          {drawerTab === "details" && (
          <>
          {/* Grid of facts */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Fact label="Plan" value={lead.plan} />
            <Fact label="Seats" value={lead.seats?.toString()} mono />
            <Fact label="Deal value" value={lead.value ? rupee(lead.value) : "—"} big />
            <Fact label="Source" value={lead.source} mono />
            <Fact label="New / switching" value={lead.subscription_type === "fresh" ? "Fresh subscription" : lead.subscription_type === "switch" ? "Switching vendor" : "—"} />
            <Fact label="Contact name" value={lead.contact_name} />
            <Fact label="Email" value={lead.contact_email} mono />
            <Fact label="Phone" value={lead.contact_phone} mono />
            <Fact label="Created" value={formatDate(lead.created_at)} />
          </div>

          {/* Recent communication — surfaced right here on the main Details view
              (not hidden in the Activity tab) so every call / WhatsApp / email /
              inbound reply is visible the moment you open the lead. Shows the
              latest 3; "See all" opens the full timeline. */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Recent communication</div>
              {activities.length > 3 && (
                <button
                  type="button"
                  onClick={() => setDrawerTab("activity")}
                  className="text-[11px] font-medium text-amber-ink hover:text-amber focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded"
                >
                  See all ({activities.length})
                </button>
              )}
            </div>
            {activities.length === 0 ? (
              <div className="text-sm text-ink-3 italic p-3 bg-paper-2 rounded-md">
                No communication yet. Call / WhatsApp / Email from here — it logs automatically.
              </div>
            ) : (
              <ul className="space-y-2">
                {[...activities]
                  .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
                  .slice(0, 3)
                  .map((a) => {
                    const meta = ACTIVITY_META[a.kind] ?? { icon: "clock" as const, label: a.kind };
                    return (
                      <li key={a.id} className="flex items-start gap-2.5">
                        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-paper-2 text-ink-3">
                          <Icon name={meta.icon} size={12} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-ink truncate">{a.detail || meta.label}</div>
                          <div className="text-[11px] text-ink-3">
                            {meta.label} · {formatDate(a.created_at)} {fmtActTime(a.created_at)}
                          </div>
                        </div>
                      </li>
                    );
                  })}
              </ul>
            )}
          </div>

          {/* Notes */}
          <div>
            <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">Notes</div>
            <div className="text-sm text-ink-2 whitespace-pre-wrap p-3 bg-paper-2 rounded-md min-h-[80px]">
              {lead.notes || <span className="italic text-ink-3">No notes yet.</span>}
            </div>
          </div>
          </>
          )}

          {/* Activity timeline — outbound touches + inbound emails — its own tab */}
          {drawerTab === "activity" && (
          <div>
            <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">Activity</div>
            {activities.length === 0 ? (
              <div className="text-sm text-ink-3 italic p-3 bg-paper-2 rounded-md">
                No activity yet. Emailing, calling or WhatsApp-ing from here gets logged automatically.
              </div>
            ) : (
              <ul className="space-y-2">
                {activities.map((a) => {
                  const meta = ACTIVITY_META[a.kind] ?? { icon: "clock" as const, label: a.kind };
                  return (
                    <li key={a.id} className="flex items-start gap-2.5">
                      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-paper-2 text-ink-3">
                        <Icon name={meta.icon} size={12} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-ink">{a.detail || meta.label}</div>
                        <div className="text-[11px] text-ink-3">
                          {meta.label} · {formatDate(a.created_at)} {fmtActTime(a.created_at)}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          )}

          {drawerTab === "details" && (
          <>
          {/* ── Quotes history (only when this lead has received at least one quote) ── */}
          {hasQuotes && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold">
                  Quotes ({quotesForLead.length})
                </div>
              </div>
              <div className="rounded-md border border-hairline divide-y divide-hairline overflow-hidden">
                {quotesForLead.map((q) => {
                  const statusKind: "muted" | "warning" | "success" | "info" | "danger" =
                    q.status === "draft"    ? "muted" :
                    q.status === "sent"     ? "warning" :
                    q.status === "viewed"   ? "info" :
                    q.status === "accepted" ? "success" :
                    "danger";
                  return (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => {
                        onClose();
                        router.push(`/quotes/${q.id}` as any);
                      }}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-paper-2 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-ink truncate">
                            {q.id}
                          </span>
                          <Badge kind={statusKind} dot>{q.status}</Badge>
                        </div>
                        <div className="text-[11px] text-ink-3 mt-0.5">
                          {formatDate(q.created_at)} · {q.line_items && Array.isArray(q.line_items) ? q.line_items.length : 0} item
                          {Array.isArray(q.line_items) && q.line_items.length === 1 ? "" : "s"}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="font-serif text-sm tabular-nums text-ink">
                          {rupee(q.amount ?? 0)}
                        </div>
                        <Icon name="arrow_right" size={11} className="text-ink-3 ml-auto" />
                      </div>
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-ink-3 mt-1.5 flex items-center gap-1">
                <Icon name="info" size={11} />
                {lead.stage === "won"
                  ? "Click any quote to view · upsell with a new quote below"
                  : lead.stage === "lost"
                  ? "Click any quote to view · re-engage with a fresh quote below"
                  : latestQuote?.status === "draft"
                  ? "Click the draft to review & send it below"
                  : "Click any quote to view · or send a revised quote below"}
              </p>
            </div>
          )}
          </>
          )}

          {/* ── Follow-ups — its own tab ────────────────────────────────
              Sales rep talks to the lead → captures next-action with date.
              List is split: open (pending/snoozed) shown prominently, done
              tucked away as a collapsed audit trail. Overdue rows tinted
              rose so they pull the eye. */}
          {drawerTab === "followups" && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold inline-flex items-center gap-2">
                <Icon name="clock" size={12} />
                Follow-ups
                {openTasks.length > 0 && (
                  <span className="text-[10px] tabular-nums bg-amber-soft text-amber-ink px-1.5 py-0.5 rounded-full">
                    {openTasks.length} open
                  </span>
                )}
              </div>
              <Button size="sm" variant="ghost" icon="plus" onClick={() => setAddTaskOpen(true)}>
                Add
              </Button>
            </div>

            {openTasks.length === 0 && doneTasks.length === 0 ? (
              <p className="text-[12px] text-ink-3 italic">
                No follow-ups scheduled. Click <b>+ Add</b> to set a reminder.
              </p>
            ) : (
              <div className="space-y-1.5">
                {openTasks.map((t) => {
                  const due = new Date(t.due_at);
                  const isOverdue = due.getTime() < Date.now();
                  return (
                    <div
                      key={t.id}
                      className={cn(
                        "rounded-md border px-3 py-2 text-sm flex items-start gap-2",
                        isOverdue
                          ? "border-rose/40 bg-rose-soft/40"
                          : "border-hairline bg-paper-2/30",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => completeTask.mutate(t.id)}
                        className="mt-0.5 w-4 h-4 rounded-full border border-hairline-strong hover:bg-emerald hover:border-emerald transition-colors shrink-0"
                        title="Mark done"
                        aria-label="Mark done"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-ink leading-tight">{t.title}</p>
                        <p className={cn(
                          "text-[11px] mt-0.5 tabular-nums",
                          isOverdue ? "text-rose font-medium" : "text-ink-3",
                        )}>
                          {isOverdue ? "Overdue · " : ""}
                          {due.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                          {t.snooze_count > 0 && ` · snoozed ${t.snooze_count}×`}
                        </p>
                        {t.notes && (
                          <p className="text-[11px] text-ink-3 mt-1 line-clamp-2">{t.notes}</p>
                        )}
                      </div>
                      <div className="flex gap-0.5 shrink-0">
                        <IconButton
                          icon="clock"
                          size="sm"
                          variant="ghost"
                          aria-label="Snooze 1 day"
                          title="Snooze 1 day"
                          onClick={() => snoozeTask.mutate({ id: t.id })}
                        />
                        <IconButton
                          icon="trash"
                          size="sm"
                          variant="ghost"
                          aria-label="Delete task"
                          title="Delete task"
                          onClick={() => deleteTask.mutate(t.id)}
                        />
                      </div>
                    </div>
                  );
                })}
                {doneTasks.length > 0 && (
                  <details className="text-[11px] text-ink-3 mt-2">
                    <summary className="cursor-pointer select-none hover:text-ink">
                      {doneTasks.length} completed
                    </summary>
                    <ul className="mt-1.5 space-y-1 pl-3">
                      {doneTasks.map((t) => (
                        <li key={t.id} className="line-through opacity-70">
                          {t.title} ·{" "}
                          {t.completed_at &&
                            new Date(t.completed_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
          )}

          {drawerTab === "details" && (
          <>
          {/* Quick stage change
              For a raw lead (no plan picked yet), only "new" / "contact" are
              logically valid — demo/trial/quote/won all require a plan to
              make sense. Show only the relevant chips + a hint to qualify
              first if the user wants to progress further. */}
          {(() => {
            // Quote-first funnel: pre-quote leads (new/contact) can only stay
            // pre-quote or be Lost — Demo/Trial/Won unlock only after a quote is
            // sent. Post-quote deals get the deal-stage chips (no going back to
            // the inbox stages).
            const isPreQuote = lead.stage === "new" || lead.stage === "contact";
            const visibleStages = isPreQuote
              ? LEAD_STAGES.filter((s) => s.id === "new" || s.id === "contact" || s.id === "lost")
              : LEAD_STAGES.filter((s) => s.id !== "new" && s.id !== "contact");
            return (
              <div>
                <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">Move to stage</div>
                <div className="flex flex-wrap gap-1.5">
                  {visibleStages.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => {
                        if (s.id !== lead.stage) {
                          updateStage.mutate({ id: lead.id, stage: s.id });
                          toast.success(`${lead.company} → ${s.label}`);
                          onClose();
                        }
                      }}
                      disabled={s.id === lead.stage}
                      className={cn(
                        "text-xs px-2.5 py-1 rounded-full border transition-colors",
                        s.id === lead.stage
                          ? "bg-amber-soft border-amber text-amber-ink font-medium cursor-default"
                          : "border-hairline text-ink-2 hover:bg-paper-2"
                      )}
                    >
                      <span className={cn("inline-block w-1.5 h-1.5 rounded-full mr-1.5", s.dot)} />
                      {s.label}
                    </button>
                  ))}
                </div>
                {isPreQuote && (
                  // Quote-first funnel: the only way forward from a pre-quote
                  // lead is to send a quote — that moves it into Deals and
                  // unlocks Demo / Trial / Won. One click starts the quote.
                  <button
                    type="button"
                    onClick={handleSendQuote}
                    className={cn(
                      "mt-3 w-full text-left text-xs px-3 py-2 rounded-md",
                      "bg-amber-soft hover:bg-amber/15 border border-amber/40",
                      "text-amber-ink font-medium",
                      "inline-flex items-center justify-between gap-2 transition-colors",
                    )}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Icon name="send" size={13} />
                      Send a quote to move into Deals · unlocks Demo / Trial / Won
                    </span>
                    <Icon name="arrow_right" size={13} />
                  </button>
                )}
              </div>
            );
          })()}
          </>
          )}
        </div>

        <SheetFooter className="!p-4 border-t border-hairline !flex-col !items-stretch gap-2">
          {/* Secondary row — edit / archive / delete */}
          <div className="flex justify-between items-center gap-2">
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                icon="edit"
                onClick={() => onEdit(lead)}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleArchive}
              >
                Archive
              </Button>
            </div>
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              onClick={handleDelete}
              loading={deleteLead.isPending}
              className="!text-rose hover:!bg-rose/10"
            >
              Delete
            </Button>
          </div>

          {/* Primary row — communication actions
              Stage-aware so the primary CTA always reflects the actual next
              step a sales person would take with this lead. Call button
              is first because that's the most common mobile action. */}
          <div className="flex justify-end gap-2 pt-2 border-t border-hairline flex-wrap">
            {lead.contact_phone && (
              <Button
                icon="mobile"
                onClick={() => { window.location.href = `tel:${lead.contact_phone}`; }}
                title="Native dialer"
              >
                Call
              </Button>
            )}
            <Button icon="mail" onClick={handleEmail}>Email</Button>
            {lead.contact_phone && (
              <Button
                icon="whatsapp"
                onClick={() => setWhatsOpen(true)}
                title="Send a WhatsApp message via Meta Cloud API"
              >
                WhatsApp
              </Button>
            )}

            {lead.stage === "won" ? (
              <>
                {/* Deal done — money flowed, customer record was auto-created
                    during record_payment. Natural next moves are upsell (a
                    fresh quote tied back to this lead) or open the customer
                    record / accepted quote for context. */}
                <Button icon="send" onClick={handleSendQuote}>
                  Upsell · New quote
                </Button>
                {latestQuote && (
                  <Button
                    variant="primary"
                    icon="receipt"
                    onClick={() => {
                      onClose();
                      router.push(`/quotes/${latestQuote.id}` as any);
                    }}
                  >
                    Open accepted quote
                  </Button>
                )}
              </>
            ) : lead.stage === "lost" ? (
              <>
                {/* Deal lost — only sensible action is to re-engage with a
                    fresh quote (potentially with different pricing). The
                    earlier "revise" of a rejected quote rarely lands. */}
                <Button variant="primary" icon="send" onClick={handleSendQuote}>
                  Re-engage · Send new quote
                </Button>
              </>
            ) : hasQuotes ? (
              latestQuote?.status === "draft" ? (
                /* Draft quote never sent → the one action is to open & send it. */
                <Button
                  variant="primary"
                  icon="send"
                  onClick={() => { onClose(); router.push(`/quotes/${latestQuote.id}` as any); }}
                >
                  Send draft quote
                </Button>
              ) : (
                <>
                  <Button icon="send" onClick={handleSendQuote}>
                    New quote
                  </Button>
                  <Button variant="primary" icon="copy" onClick={handleReviseQuote}>
                    Revise & resend
                  </Button>
                </>
              )
            ) : (
              <Button variant="primary" icon="send" onClick={handleSendQuote}>
                Send Quote
              </Button>
            )}
          </div>
        </SheetFooter>
      </SheetContent>

      {/* Add Follow-up dialog — mounted as a sibling of the Sheet so its
          own modal stacking doesn't fight the drawer. */}
      <AddTaskDialog
        open={addTaskOpen}
        onOpenChange={setAddTaskOpen}
        linkLabel={lead.company}
        linkTo={{ lead_id: lead.id }}
      />

      {/* Send-via-WhatsApp — pre-fills contact phone and an opening line
          using the lead's plan/seats context. */}
      {whatsOpen && lead.contact_phone && (
        <SendWhatsAppDialog
          open={whatsOpen}
          onOpenChange={setWhatsOpen}
          defaultTo={lead.contact_phone}
          defaultText={
            `Hi ${lead.contact_name ?? "there"},\n\n` +
            `Thanks for your interest in ${lead.plan ?? "our cloud services"}` +
            (lead.seats ? ` for ${lead.seats} users.` : ".") +
            `\n\nLet me know if you'd like to schedule a quick call or get a tailored quote.\n\n` +
            `— ${currentUser?.tenantName ?? "your team"}`
          }
          title={`WhatsApp · ${lead.company}`}
          related={{ leadId: lead.id }}
        />
      )}
    </Sheet>
  );
}

// ============================================================
// RowActions — the sticky trailing cell for a lead row. A persistent ⋯ that
// opens a clean, LABELLED action menu (coloured icon + name), so every action
// is unambiguous — no colour-guessing, the two green actions read clearly as
// "Call" vs "WhatsApp". Radix renders it in a portal, so it's never clipped by
// the cell (which is why the old hover-slide panel needed a JS hover-intent).
// ============================================================
function RowActions({
  lead, isSelected, onSendQuote, onFollowUp,
}: {
  lead: Lead;
  isSelected: boolean;
  onSendQuote: (l: Lead) => void;
  onFollowUp: (l: Lead) => void;
}) {
  const phoneDigits = (lead.contact_phone ?? "").replace(/\D/g, "");
  const waNumber = phoneDigits.startsWith("91")
    ? phoneDigits
    : (phoneDigits.length === 10 ? `91${phoneDigits}` : phoneDigits);
  const hasPhone = phoneDigits.length >= 10;
  const hasEmail = Boolean(lead.contact_email);
  const logActivity = useLogLeadActivity();
  const setJunk = useSetLeadJunk();

  const itemCls = "gap-2.5 py-2 cursor-pointer";
  // Primary quick actions inline (Call · WhatsApp · Quote) — ALWAYS fully visible
  // (not faint / hover-only) so they read as tappable buttons at a glance and stay
  // reachable on touch tablets (no hover). Each has a subtle bordered chip so the
  // hit-area is obvious; colour brightens on hover.
  const iconBtn = "flex h-7 w-7 items-center justify-center rounded-md border border-hairline bg-paper text-ink-2 transition-colors hover:bg-paper-2 hover:border-hairline-strong";

  return (
    <td
      className={cn("p-2", isSelected ? "bg-amber-soft" : "")}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-end gap-0.5">
        {hasPhone && (
          <a
            href={`tel:${lead.contact_phone}`}
            title={`Call ${lead.contact_phone}`}
            aria-label={`Call ${lead.company}`}
            className={cn(iconBtn, "hover:text-emerald")}
            onClick={() => logActivity.mutate({ leadId: lead.id, kind: "call", detail: `Called ${lead.contact_phone}` })}
          >
            <Icon name="call" size={16} />
          </a>
        )}
        {hasPhone && (
          <button
            type="button"
            title="WhatsApp"
            aria-label={`WhatsApp ${lead.company}`}
            className={cn(iconBtn, "hover:text-emerald")}
            onClick={() => {
              openWhatsApp(waNumber);
              logActivity.mutate({ leadId: lead.id, kind: "whatsapp", detail: `WhatsApp to ${lead.contact_phone}` });
            }}
          >
            <Icon name="whatsapp" size={16} />
          </button>
        )}
        <button
          type="button"
          title="Send quote"
          aria-label={`Send quote to ${lead.company}`}
          className={cn(iconBtn, "hover:text-amber")}
          onClick={() => onSendQuote(lead)}
        >
          <Icon name="quote" size={16} />
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More actions"
              className="flex h-7 w-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2 data-[state=open]:text-ink"
            >
              <Icon name="more_h" size={18} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[13rem]">
            <DropdownMenuLabel>More actions</DropdownMenuLabel>
            <DropdownMenuItem className={itemCls} onClick={() => onFollowUp(lead)}>
            <Icon name="reminder" size={20} /> Schedule follow-up
          </DropdownMenuItem>
          <DropdownMenuItem
            className={itemCls}
            onClick={() => {
              const url  = `${window.location.origin}/enquiry`;
              const hi   = lead.contact_name ? `Hi ${lead.contact_name},` : "Hello,";
              const text =
                `${hi}\n\n` +
                `Thanks for your interest. To prepare an accurate quote, please fill this short 1-minute form with your requirement (product, number of users, and any notes):\n\n` +
                `${url}\n\n` +
                `Once you submit it, we'll review and send you a price quote with GST. Thank you!`;
              if (hasPhone) {
                // wa.me/<number>?text= reliably opens THIS number's chat (desktop
                // app OR web) with the link pre-filled — not the "new chat" picker.
                window.open(`https://wa.me/${waNumber}?text=${encodeURIComponent(text)}`, "_blank", "noopener");
              } else if (hasEmail) {
                window.location.href = `mailto:${encodeURIComponent(lead.contact_email ?? "")}?subject=${encodeURIComponent("Please share your requirement for a quote")}&body=${encodeURIComponent(text)}`;
              }
              logActivity.mutate({ leadId: lead.id, kind: "email", detail: "Sent enquiry form link" });
            }}
          >
            <Icon name="link" size={20} /> Send enquiry form
          </DropdownMenuItem>

          {hasEmail && <DropdownMenuSeparator />}
          {hasEmail && (
            <DropdownMenuItem asChild className={itemCls}>
              <a
                href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(lead.contact_email ?? "")}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => logActivity.mutate({ leadId: lead.id, kind: "email", detail: `Emailed ${lead.contact_email}` })}
              >
                <Icon name="email" size={20} /> Email
                <span className="ml-auto max-w-[9rem] truncate text-[11px] text-ink-3">{lead.contact_email}</span>
              </a>
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />
          {lead.is_junk ? (
            <DropdownMenuItem className={itemCls} onClick={() => setJunk.mutate({ ids: [lead.id], isJunk: false })}>
              <Icon name="check_circle" size={20} /> Restore from junk
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem className={cn(itemCls, "text-rose")} onClick={() => setJunk.mutate({ ids: [lead.id], isJunk: true })}>
              <Icon name="alert" size={20} /> Mark as junk
            </DropdownMenuItem>
          )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </td>
  );
}

// ============================================================
// LeadListView — table view for scanning leads at scale (50+).
// Same data source + same row-click drawer as Kanban; just a different lens.
// ============================================================

type SortCol = "created" | "value" | "company" | "stage" | "age";

const STAGE_DOT: Record<Lead["stage"], string> = {
  new:     "bg-slate",
  contact: "bg-amber",
  demo:    "bg-indigo",
  trial:   "bg-rose",
  quote:   "bg-indigo",
  won:     "bg-emerald",
  lost:    "bg-ink-3",
};
const STAGE_LABEL: Record<Lead["stage"], string> = {
  new: "New", contact: "Contacted", demo: "Demo Done", trial: "Trial Active",
  quote: "Quote Sent", won: "Won", lost: "Lost",
};

/** Days since `updated_at`. >14 means stale. */
function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

const LEADLIST_COL_ORDER = ["select", "company", "stage", "contact", "plan", "value", "lastupdate", "actions"];
const LEADLIST_COL_WIDTHS: Record<string, string> = {
  select: "4%", company: "20%", stage: "11%", contact: "19%", plan: "14%", value: "10%", lastupdate: "9%", actions: "13%",
};

function LeadListView({
  leads,
  sortBy,
  sortDir,
  onSort,
  onRowClick,
  onSendQuote,
  onFollowUp,
  onMerge,
  dupIds,
  isDealsPage,
}: {
  leads: Lead[];
  sortBy: SortCol;
  sortDir: "asc" | "desc";
  onSort: (col: SortCol) => void;
  onRowClick: (l: Lead) => void;
  onSendQuote: (l: Lead) => void;
  onFollowUp: (l: Lead) => void;
  onMerge: (l: Lead) => void;
  dupIds: Set<string>;
  isDealsPage: boolean;
}) {
  // Stage options in the inline dropdown, gated by the quote-first funnel:
  //  • Leads inbox (pre-quote): only New / Contacted / Lost. Demo/Trial/Quote
  //    are NOT offered — you must Send a quote (📄) to advance, which is what
  //    moves the lead into Deals.
  //  • Deals (post-quote): Quote Sent → Demo Done → Trial Active → Won / Lost.
  const ROW_STAGE_OPTIONS: Lead["stage"][] = isDealsPage
    ? ["quote", "demo", "trial", "won", "lost"]
    : ["new", "contact", "lost"];
  // Stage-mutation hook for quick-change chips on cards. Tapping the stage
  // badge on a mobile card opens a dropdown to flip the stage without
  // needing to open the full detail drawer.
  const updateStage = useUpdateLeadStage();
  const deleteLead  = useDeleteLead();
  const setJunkBulk = useSetLeadJunk();

  // Open follow-up tasks per lead — surfaced as a chip on the row so the rep
  // sees at a glance which leads have a pending task (earliest/most-overdue).
  const { data: allTasks = [] } = useTasks("all");
  const openTaskByLead = React.useMemo(() => {
    const m = new Map<string, { due: string; overdue: boolean; count: number }>();
    const now = Date.now();
    for (const t of allTasks) {
      if (!t.lead_id || (t.status !== "pending" && t.status !== "snoozed")) continue;
      const prev = m.get(t.lead_id);
      if (!prev) m.set(t.lead_id, { due: t.due_at, overdue: new Date(t.due_at).getTime() < now, count: 1 });
      else {
        prev.count += 1;
        if (new Date(t.due_at).getTime() < new Date(prev.due).getTime()) {
          prev.due = t.due_at; prev.overdue = new Date(t.due_at).getTime() < now;
        }
      }
    }
    return m;
  }, [allTasks]);

  // Bulk-select state — desktop power-table only. A Set of lead IDs makes
  // toggle / has() / size O(1). Resets on the leads array changing
  // identity (e.g. after a refetch) to avoid keeping stale IDs.
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

  /** Bulk-mutate stage on all selected leads. Promise.all parallel because
   *  these are independent row updates. */
  const bulkChangeStage = async (stage: Lead["stage"]) => {
    const ids = Array.from(selectedIds);
    try {
      await Promise.all(ids.map((id) => updateStage.mutateAsync({ id, stage })));
      toast.success(`Moved ${ids.length} lead${ids.length === 1 ? "" : "s"} to ${STAGE_LABEL[stage]}`);
    } catch {
      toast.error("Some leads failed to update");
    }
    clearSelection();
  };

  /** Bulk-delete selected leads. The LeadsBulkBar already has a two-step
   *  confirm, so we proceed without an additional prompt. */
  const bulkDelete = async () => {
    const ids = Array.from(selectedIds);
    try {
      await Promise.all(ids.map((id) => deleteLead.mutateAsync(id)));
      toast.success(`Deleted ${ids.length} lead${ids.length === 1 ? "" : "s"}`);
    } catch {
      toast.error("Some leads failed to delete");
    }
    clearSelection();
  };

  /** Bulk-mark selected leads as junk — one update, they leave the working views. */
  const bulkMarkJunk = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try { await setJunkBulk.mutateAsync({ ids, isJunk: true }); } catch { /* hook toasts */ }
    clearSelection();
  };
  // Apply sort (memo so we don't resort on every render).
  // Pre-sort layer (always wins): leads with follow_up_date <= today get
  // hoisted to the top regardless of the user's chosen column sort. Within
  // that group, overdue (older follow_up_date) comes first. After due-today,
  // the user's sort applies normally. This makes the "morning worklist"
  // mental model match the visual order without a separate filter.
  const sorted = React.useMemo(() => {
    const out = [...leads];
    const dir = sortDir === "asc" ? 1 : -1;
    // Sort strictly by the chosen column — default is "created" desc, so the
    // newest lead is always on top. (Due/overdue follow-ups are surfaced by the
    // banner + the Today/Overdue filter chips, so we don't secretly re-pin them
    // here — a sortable table should obey its sort.)
    out.sort((a, b) => {
      switch (sortBy) {
        case "value":   return ((a.value ?? 0) - (b.value ?? 0)) * dir;
        case "company": return a.company.localeCompare(b.company) * dir;
        case "stage":   return a.stage.localeCompare(b.stage) * dir;
        case "age":     return (daysSince(a.updated_at) - daysSince(b.updated_at)) * dir;
        case "created":
        default:        return (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * dir;
      }
    });
    return out;
  }, [leads, sortBy, sortDir]);

  // NOTE: buildWaMessage / followUpLabel / priorityDot helpers used to live
  // here for the inline mobile card. They've been lifted into SwipeLeadCard
  // (the new component handles its own formatting). Desktop / tablet table
  // doesn't need them so they're gone from this file.

  const SortHeader = ({ col, label, align = "left" }: { col: SortCol; label: string; align?: "left" | "right" }) => (
    <th
      onClick={() => onSort(col)}
      className={cn(
        "sticky top-0 z-10 bg-paper-2 p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider cursor-pointer select-none hover:text-ink",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortBy === col && (
          <Icon name={sortDir === "asc" ? "chevron_up" : "chevron_down"} size={11} />
        )}
      </span>
    </th>
  );

  return (
    <>
    {/* Mobile card list — phones only.
        Each card is a SwipeLeadCard:
          - Tap → open drawer
          - Drag right ≥ 80px → Call
          - Drag left  ≥ 80px → WhatsApp
        Dense 3-row layout: header (co/value), contact, meta+actions.
        Stage quick-change chip + inline action icons are tap-isolated
        from the card via stopPropagation. */}
    <ul className="md:hidden space-y-3 pb-2">
      {sorted.map((lead) => {
        const stale = daysSince(lead.updated_at) > 14 && lead.stage !== "won" && lead.stage !== "lost";
        return (
          <SwipeLeadCard
            key={lead.id}
            lead={lead}
            stale={stale}
            task={openTaskByLead.get(lead.id)}
            onTap={onRowClick}
            onChangeStage={(s) => updateStage.mutate({ id: lead.id, stage: s })}
            onSendQuote={onSendQuote}
          />
        );
      })}
      {sorted.length === 0 && (
        <li className="py-8 text-center text-sm text-ink-3">No leads match.</li>
      )}
    </ul>
    {/* ─── End of mobile list — old inline card markup retired ─── */}

    {/* Desktop / tablet power table.
        New columns vs v1:
          - leading checkbox  → bulk select
          - trailing actions  → row-hover Call / WhatsApp / Email icons
        Selecting any row reveals the floating LeadsBulkBar at the
        viewport bottom (stage change, delete). */}
    {/* min-h-[400px] guarantees the table never collapses below a usable
        height even when the rail-below section is tall (sparse-data flex
        competition bug — table had been crushing to 1.6px on /deals when
        only 1-3 deals existed and rail-below's quick-actions grid was
        taking all the flex space). */}
    {/* flex-1 + min-h-0 caps this to the space the flex chain leaves, so the table
        scrolls INTERNALLY (both axes) instead of growing as tall as all its rows.
        Before, the container grew unbounded and the horizontal scrollbar sat at the
        very bottom of that tall element — you had to scroll the whole page down just
        to reach it (Pardeep's dogfood complaint). Capped + sticky header = header
        stays put and the h-scrollbar is always on screen. The md+ fixed-height page
        wrapper is what makes flex-1 resolve to a real cap. */}
    <div className="hidden md:block w-full max-w-full border border-hairline rounded-md overflow-auto bg-paper flex-1 min-h-0">
      {/* Fluid percentage columns — the table fills the container width with no
          horizontal scrollbar at desktop widths. */}
      <table className="w-full table-fixed">
        <colgroup>
          {LEADLIST_COL_ORDER.map((id) => <col key={id} style={{ width: LEADLIST_COL_WIDTHS[id] }} />)}
        </colgroup>
        <thead className="bg-paper-2 border-b border-hairline">
          <tr>
            {/* Select-all checkbox — checked when every row is selected,
                indeterminate when only some are. */}
            <th className="sticky top-0 z-10 bg-paper-2 px-3 py-2">
              <input
                type="checkbox"
                aria-label="Select all leads"
                checked={sorted.length > 0 && selectedIds.size === sorted.length}
                ref={(el) => {
                  if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < sorted.length;
                }}
                onChange={(e) => {
                  if (e.target.checked) setSelectedIds(new Set(sorted.map((l) => l.id)));
                  else clearSelection();
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-4 h-4 accent-amber cursor-pointer"
              />
            </th>
            <SortHeader col="company" label="Company" />
            <SortHeader col="stage" label="Stage" />
            <th className="sticky top-0 z-10 bg-paper-2 px-3 py-2 text-xs font-semibold text-ink-3 uppercase tracking-wider text-left">Contact</th>
            <th className="sticky top-0 z-10 bg-paper-2 px-3 py-2 text-xs font-semibold text-ink-3 uppercase tracking-wider text-left">Plan</th>
            <SortHeader col="value" label="Value" align="right" />
            <SortHeader col="age" label="Last update" />
            {/* Actions column — quick action icons on row hover. */}
            <th className="sticky top-0 z-10 bg-paper-2 px-3 py-2 text-xs font-semibold text-ink-3 uppercase tracking-wider text-right">
              <span className="sr-only">Quick actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((lead) => {
            const stale       = daysSince(lead.updated_at) > 14 && lead.stage !== "won" && lead.stage !== "lost";
            const age         = daysSince(lead.updated_at);
            const isSelected  = selectedIds.has(lead.id);
            // Heat → visual hierarchy. High-value (big money) wins the emerald
            // treatment; else a hot lead (priority high OR late-funnel stage)
            // gets a rose accent. Same isHotLead/isHighValueLead helpers drive
            // the Hot chip + filter, so counts and tags never disagree.
            const isHighValue = isHighValueLead(lead);
            const isHot       = isHotLead(lead);
            const railCls     = isHighValue ? "border-l-2 border-emerald"
                              : isHot       ? "border-l-2 border-rose"
                              :               "border-l-2 border-transparent";
            const isDup       = dupIds.has(lead.id);
            // Phone/email affordances now live inside <RowActions/>.
            return (
              <tr
                key={lead.id}
                data-lead-id={lead.id}
                onClick={() => onRowClick(lead)}
                tabIndex={0}
                aria-label={`Open ${lead.company}`}
                onKeyDown={(e) => {
                  // Keyboard parity with the mouse row-click (WCAG AA). Ignore
                  // when focus is on an inner control (checkbox / stage select /
                  // action link) so their own keys aren't hijacked.
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onRowClick(lead);
                  }
                }}
                className={cn(
                  "border-b border-hairline last:border-0 cursor-pointer transition-colors group",
                  // Selected rows pick up the brand accent. Hover state
                  // layered on top so it still reacts to mouse-over.
                  isSelected
                    ? "bg-amber-soft/60 hover:bg-amber-soft"
                    : "hover:bg-paper-2/40",
                )}
              >
                <td className={cn("p-3", railCls)} onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${lead.company}`}
                    checked={isSelected}
                    onChange={() => toggleId(lead.id)}
                    className="w-4 h-4 accent-amber cursor-pointer"
                  />
                </td>
                <td className="p-3">
                  <div className="flex items-center gap-2">
                    {isHighValue ? (
                      <span className="shrink-0 inline-flex" title="High-value lead (≥ ₹1L)">
                        <Icon name="star" size={13} className="text-emerald" />
                      </span>
                    ) : stale ? (
                      <span
                        className="w-2 h-2 rounded-full bg-rose shrink-0"
                        title={`Stale — no activity for ${age} days`}
                      />
                    ) : null}
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-ink truncate">{lead.company}</span>
                        {isHot && (
                          <span
                            title={`Hot — ${hotReason(lead)}`}
                            className="shrink-0 inline-flex items-center rounded-full bg-rose-soft text-rose text-[10px] font-semibold px-1.5 py-0.5 leading-none cursor-help"
                          >
                            Hot
                          </span>
                        )}
                        {isDup && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onMerge(lead); }}
                            title="Possible duplicate — click to review & merge"
                            className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-amber-soft text-amber-ink text-[10px] font-semibold px-1.5 py-0.5 leading-none border border-amber/30 hover:bg-amber-soft/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber"
                          >
                            <Icon name="copy" size={9} /> Duplicate?
                          </button>
                        )}
                      </div>
                      <div className="text-[10px] text-ink-3 font-mono">{lead.id}</div>
                      {(() => {
                        const tk = openTaskByLead.get(lead.id);
                        if (!tk) return null;
                        return (
                          <span className={cn(
                            "mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                            tk.overdue ? "bg-rose-soft text-rose" : "bg-amber-soft text-amber-ink",
                          )}>
                            <Icon name="clock" size={10} />
                            {tk.overdue ? "Task overdue" : "Task"} · {formatDate(tk.due)}
                            {tk.count > 1 ? ` (+${tk.count - 1})` : ""}
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                </td>
                {/* Stage — 2nd column so pipeline status reads at a glance. Editable
                    inline; stopPropagation so the select doesn't trigger the row click. */}
                <td className="p-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-1.5 flex-nowrap">
                    <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", STAGE_DOT[lead.stage])} />
                    <select
                      value={lead.stage}
                      onChange={(e) => {
                        const stage = e.target.value as Lead["stage"];
                        updateStage.mutate({ id: lead.id, stage });
                        if (!isDealsPage && stage === "lost") {
                          toast.success(`${lead.company} marked Lost`);
                        }
                      }}
                      title="Change stage"
                      aria-label={`Stage for ${lead.company}`}
                      className="text-xs bg-transparent -ml-1 px-1 py-0.5 rounded border border-transparent hover:border-hairline cursor-pointer focus:outline-none focus:ring-1 focus:ring-amber focus:border-amber"
                    >
                      {ROW_STAGE_OPTIONS.map((s) => (
                        <option key={s} value={s}>{STAGE_LABEL[s]}</option>
                      ))}
                    </select>
                  </div>
                </td>
                {/* Email is kept off the row to keep it tight — it shows on hover
                    (title) with a small mail glyph as the cue. Phone stays visible
                    as it's the primary call-to-action in the pipeline. */}
                <td className="px-3 py-2 text-sm" title={lead.contact_email ? `Email: ${lead.contact_email}` : undefined}>
                  <div className="flex items-center gap-1 text-ink">
                    <span className="truncate max-w-[170px]">{lead.contact_name ?? "—"}</span>
                    {lead.contact_email && <Icon name="mail" size={11} className="shrink-0 text-ink-3" />}
                  </div>
                  {lead.contact_phone && (
                    <div className="text-[11px] text-ink-3 font-mono truncate max-w-[180px]">
                      {lead.contact_phone}
                    </div>
                  )}
                </td>
                {/* Plan + seats folded together — saves a column, keeps both
                    facts. Seats bold so quantity reads at a glance. */}
                <td className="px-3 py-2 text-sm text-ink-2">
                  <span className="block truncate" title={lead.plan ?? undefined}>{lead.plan ?? "—"}</span>
                  {lead.seats != null && (
                    <span className="text-[11px] text-ink-3"><span className="font-semibold text-ink-2 tabular-nums">{lead.seats}</span> seats</span>
                  )}
                </td>
                {/* Value — the money, given visual precedence (serif, bold). */}
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                  {lead.value
                    ? <span className={cn("font-serif text-[15px] font-semibold", isHighValue ? "text-emerald" : "text-ink")}>{rupee(lead.value)}</span>
                    : <span className="text-ink-3">—</span>}
                </td>
                <td className="px-3 py-2 text-sm">
                  <span className={cn(
                    "tabular-nums block",
                    stale ? "text-rose font-medium" : "text-ink-3",
                  )}>
                    {age === 0 ? "today" : age === 1 ? "1d ago" : `${age}d ago`}
                  </span>
                  <span className="block text-[10px] text-ink-4 tabular-nums">
                    {formatDate(lead.updated_at)} · {fmtActTime(lead.updated_at)}
                  </span>
                </td>
                {/* Quick actions — dark panel that opens from the ⋯ (hover/click/
                    focus) and stays open while the panel itself is hovered. */}
                <RowActions lead={lead} isSelected={isSelected} onSendQuote={onSendQuote} onFollowUp={onFollowUp} />
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length === 0 && (
        <div className="p-8 text-center text-sm text-ink-3 italic">No leads match.</div>
      )}
      <div className="px-3 py-2 border-t border-hairline bg-paper-2/40 text-[11px] text-ink-3 flex items-center gap-2">
        <Icon name="info" size={11} />
        Click any row to open the drawer · Tick a checkbox to enable bulk actions · Quick actions (Call / WhatsApp / Send quote / ⋯) sit at the end of each row · ★ = high-value, Hot = priority lead
      </div>
    </div>

    {/* Floating bulk action toolbar — only renders when ≥1 row selected. */}
    <LeadsBulkBar
      count={selectedIds.size}
      onChangeStage={bulkChangeStage}
      onDeselectAll={clearSelection}
      onDelete={bulkDelete}
      onMarkJunk={bulkMarkJunk}
    />
    </>
  );
}

// ============================================================
// Fact row helper for detail drawer
// ============================================================
function Fact({ label, value, mono, big }: { label: string; value: string | null | undefined; mono?: boolean; big?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-ink-3 mb-0.5">{label}</div>
      <div className={cn(
        "text-ink",
        mono && "font-mono",
        big && "font-serif text-xl",
        !value && "italic text-ink-3 text-sm"
      )}>
        {value || "—"}
      </div>
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
