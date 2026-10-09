/**
 * Quotes — list matching prototype design.
 */
"use client";

import { istToday } from "@/lib/dates/ist";
import * as React from "react";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { QUOTE_TABS } from "@/lib/navigation/drilldown";
import { useListKeys } from "@/lib/hooks/useKeyboard";
import { useTeamTree } from "@/lib/queries/team-tree";
import { TeamViewToggle } from "@/components/shared/team-view-toggle";
import { HIERARCHY_ENFORCED_IN_DATABASE } from "@/lib/team/enforcement";
import { idsForMode, type TeamViewMode } from "@/lib/team/visibility";
import { KeyHintBar, ShortcutsSheet } from "@/components/shared/shortcuts-sheet";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { QUOTE_FOCI, QUOTE_FOCUS_LABEL, quoteInFocus, focusValue, type QuoteFocus } from "@/lib/quotes/focus";
import { FocusBanner } from "@/components/shared/focus-banner";
import { useQuotes, useDeleteQuote, quoteDeleteBlockReason } from "@/lib/queries/quotes";
import { useQuoteLeadContacts } from "@/lib/queries/quote-lead-contacts";
import { quoteMatchesSearch, quotePartyName } from "@/lib/quotes/quote-party-name";
import { useSubscriptions } from "@/lib/queries/subscriptions";
import type { Subscription } from "@/lib/supabase/database.types";
import { useProjectSales, useDeleteProjectSale, type ProjectSaleWithTotals } from "@/lib/queries/projects";
import { CreateProjectQuoteDialog } from "@/components/features/projects/create-project-quote-dialog";
import { useCustomer } from "@/lib/queries/customers";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { quotePlaceOfSupply } from "@/lib/quotes/quote-place-of-supply";
import { useLead } from "@/lib/queries/leads";
import { GeminiCard } from "@/components/shared/gemini-card";
import { EmptyState } from "@/components/shared/empty-state";
import { quotesEmptyCopy } from "@/lib/quotes/empty-tab";
import { computeMargin } from "@/components/features/margin-pill";
import { Skeleton } from "@/components/ui/skeleton";
import { Button, IconButton } from "@/components/ui/button";
import { QuotePreviewDialog } from "@/components/features/quotes/quote-preview-dialog";
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { FAB } from "@/components/ui/fab";
import { downloadCSV } from "@/lib/csv";
import { QUOTES_CSV_HEADERS, quotesCsvRows } from "@/lib/export/crm-csv";
import { rupee, daysBetween, cleanDisplayName, phoneSuffixOf, formatDate } from "@/lib/utils";
import { unifiedStatus, cashNote } from "@/lib/quotes/status-badge";
import { awaitsMyApproval } from "@/lib/quotes/awaiting-approval";
import { ApprovalsStrip } from "@/components/features/quotes/approvals-strip";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/providers/confirm-provider";
import { isForeignCurrency, foreignEquivalent, formatForeign } from "@/lib/currency";
import type { Quote } from "@/lib/supabase/database.types";
/* R-105: same paging rule + "Load N more" control as Payments (R-104) and the shared DataTable. */
import { usePagedRows, LoadMore } from "../payments/load-more";
import { QUOTES_PAGE_SIZE, quotesPagingKey } from "./paging";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { COPY } from "@/lib/copy";
import { anyCostUnknown } from "@/lib/quotes/line-cost";
import { quoteListTab, quoteTabCounts, isPipelineQuote } from "@/lib/quotes/list-tab";

/** A quote's total in ITS billing currency (foreign quotes show $/€…; books stay ₹). */
function quoteMoney(q: { amount: number | null; currency?: string | null; exchange_rate?: number | null }): string {
  if (!q.amount) return "—";
  if (isForeignCurrency(q.currency)) {
    return formatForeign(foreignEquivalent(q.amount, q.exchange_rate && q.exchange_rate > 0 ? q.exchange_rate : 1), q.currency ?? "");
  }
  return rupee(q.amount);
}

/**
 * Quote ke total ki IKAI — "/mo" flex par, "/yr" annual par, khaali jab pata na ho.
 *
 * Pardeep, 31 Aug 2026: "commitment bhi show karo monthly ya yearly." ₹15,340 aur
 * ₹76,464 dono sahi total hain — farak sirf ye hai ki ek MAHINE ka hai aur doosra SAAL
 * ka, aur list par wo farak dikhe bina do quote compare karna andaza ban jata hai.
 *
 * null par khaali: purani quotes jinke billing_cycle set hi nahi hua, unpar "/yr" ka
 * ANDAZA chhapna galat ikai ki wahi bimari hai — na dikhana behtar hai.
 */
function cycleSuffix(cycle: string | null | undefined): string {
  return cycle === "monthly" ? "/mo" : cycle === "yearly" ? "/yr" : "";
}

/**
 * A quote's margin, from its LINE ITEMS.
 *
 * Two things this used to do and no longer does:
 *
 * • It read `quotes.total_cost`, an aggregate column that at least one writer forgot
 *   to set. Q-2026-9778 stores 0 there while its line carries ₹19,800, so this list
 *   showed "Pipeline margin ₹0" on a quote making 17.5%.
 *
 * • When that column was empty it guessed `amount × 0.83` — a flat 17% invented out
 *   of nothing and then summed into a KPI tile that read like a measurement. That was
 *   the fourth copy of the same guess in this codebase.
 *
 * `known: false` means the margin genuinely cannot be worked out, and callers must
 * show that rather than a number. Returning 0 would be indistinguishable from a
 * break-even deal.
 */
function estimateMarginForQuote(q: Quote): ReturnType<typeof computeMargin> & { known: boolean } {
  const lines = Array.isArray(q.line_items) ? q.line_items : [];
  const taxable = q.subtotal
    ? q.subtotal - Math.round(q.subtotal * (q.discount_pct / 100))
    : (q.amount ?? 0);

  if (lines.length === 0) return { ...computeMargin(0, 0), known: false };

  const cost = lines.reduce((s, l) => s + l.qty * l.cost, 0);
  /* R-388: same rule as the approval matrix — our own support plan at ₹0 is known. */
  const known = !anyCostUnknown(lines);
  return { ...computeMargin(cost, taxable), known };
}

/* unifiedStatus + the cash note now live in lib/quotes/status-badge.ts, with tests.
   They decide what an operator believes about money at a glance, and while they lived
   here nothing could test them — which is how a quote holding ₹20,000 came to display
   "Out for review". */

/** R-272: allowed values for the URL-held view and team mode (anything else → default). */
const QUOTE_VIEWS = ["subscription", "project"] as const;
const TEAM_MODES: readonly TeamViewMode[] = ["team", "mine"];

export default function QuotesPage() {
  const router = useRouter();
  const { data: quotes, isLoading, error, refetch } = useQuotes();
  /* R-278: a quote for a lead with no company was saved as "Prospect" and could not be
     found by the lead's email or phone. The lead's contact is read alongside, so the row
     shows a real name (old rows too, no data change) and search covers name/email/phone. */
  const leadIdsOnQuotes = React.useMemo(
    () => (quotes ?? []).map((q) => q.lead_id).filter((id): id is string => !!id),
    [quotes],
  );
  const { data: leadContacts } = useQuoteLeadContacts(leadIdsOnQuotes);
  const leadOf = (q: Quote) => (q.lead_id ? leadContacts?.get(q.lead_id) ?? null : null);
  const partyOf = (q: Quote) => quotePartyName(q.customer_name, leadOf(q));
  /* ── Which quotes turned into a live subscription, and what is still owed ──
     Asked 11 Sep 2026: "I want to know which quote has an active subscription, and
     if I gave someone a grace period, show that too." Neither was visible here —
     a quote marked Accepted / Awaiting payment looked identical whether it had
     produced a running service or nothing at all.

     `subscriptions.quote_id` is the link. Fetched ONCE and indexed, not queried per
     row: a 14-quote page would otherwise be 14 extra round trips, and this list grows. */
  const { data: allSubs } = useSubscriptions();
  const subByQuoteId = React.useMemo(() => {
    const m = new Map<string, Subscription>();
    for (const sub of allSubs ?? []) if (sub.quote_id) m.set(sub.quote_id, sub);
    return m;
  }, [allSubs]);
  const { data: projectQuotes } = useProjectSales();
  const deleteQuote = useDeleteQuote();
  const [tab, setTab] = useUrlChoice<string>("tab", QUOTE_TABS, "all"); // R-118
  /* R-118: a money tile's exact set (lib/quotes/focus.ts) — "" = none. */
  const [focus, setFocus] = useUrlChoice<QuoteFocus>("focus", QUOTE_FOCI, "");
  const tabOn = (t: string) => { setFocus(""); setTab(t); };
  const focusOn = (f: QuoteFocus) => { setTab("all"); setFocus(f); };
  /* R-272: search, view and team mode live in the URL like tab/focus, so opening a quote
     and pressing Back returns to the same filtered list instead of every quote. */
  const [search, setSearch] = useUrlState("q", "");
  // Clean split — Subscription is the default (most quotes live here); Project
  // is one tab away. No mixed "All" view, no empty default.
  const [view, setView] = useUrlChoice<"subscription" | "project">("view", QUOTE_VIEWS, "subscription");
  const [projectQuoteOpen, setProjectQuoteOpen] = React.useState(false);
  const [editProject, setEditProject] = React.useState<ProjectSaleWithTotals | null>(null);
  const deleteProject = useDeleteProjectSale();
  const [previewing, setPreviewing] = React.useState<Quote | null>(null);
  const [kpiOpen, setKpiOpen] = React.useState(true);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const confirm = useConfirm();

  const handleDelete = async (q: Quote) => {
    // Hard-block quotes that already carry a payment (cascade would wipe the
    // payment ledger). Same guard the mutation enforces — surfaced early here.
    const blocked = quoteDeleteBlockReason(q);
    if (blocked) {
      toast.error(blocked);
      return;
    }
    if (await confirm({
      title: `Permanently delete quote ${q.id}?`,
      body: "This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    })) {
      deleteQuote.mutate(q);
    }
  };

  const handleDuplicate = (q: Quote) => {
    const params = new URLSearchParams();
    params.set("duplicate", q.id);
    if (q.lead_id)       params.set("leadId",  q.lead_id);
    if (q.customer_name) params.set("company", q.customer_name);
    router.push(`/quotes/new?${params.toString()}` as any);
  };

  // Workspace keyword filter removed 2026-08-13 — RLS already scopes to tenant.
  /* ── Whose quotes ─────────────────────────────────────────────────────────
     The tree decides, not the role — see lib/team/visibility.ts. An UNOWNED quote stays
     visible to everybody, and that is not a loophole: all 25 quotes in the live books have
     owner_id NULL, so filtering them out would empty this page while the rows sat safely
     in the database. Company data nobody has claimed is not private data.

     Note what this is: a view. Row-level enforcement ships in
     20260818150000_user_hierarchy_visibility.sql and is not applied yet, which is why the
     toggle carries a caveat rather than implying privacy. */
  const { data: me } = useCurrentUser();
  const { data: teamTree } = useTeamTree();
  const team = React.useMemo(() => teamTree ?? [], [teamTree]);
  const meMember = React.useMemo(
    () => team.find((u) => u.id === me?.userId) ?? null,
    [team, me?.userId],
  );
  const [teamMode, setTeamMode] = useUrlChoice<TeamViewMode>("who", TEAM_MODES, "team"); // R-272

  const quotesByWorkspace = React.useMemo(() => {
    const rows = quotes ?? [];
    if (!meMember) return rows;
    const ids = idsForMode(meMember, team, teamMode);
    if (ids === null) return rows;
    return rows.filter((q) =>
      !q.owner_id ||
      ids.includes(q.owner_id) ||
      /* A quote waiting on YOUR approval is always yours to see, whoever owns it and
         whichever view you are in. Asking somebody to approve a quote and then hiding it
         behind a team filter is a deadlock: the sidebar counts it, the queue cannot show
         it, and nobody can send it. Being asked to sign something makes you a party to it.
         This also keeps the badge honest — the count and this page now select the same
         rows, which is the rule useNavBadges is written around. */
      awaitsMyApproval(q, { id: me?.userId ?? "", role: me?.role }),
    );
  }, [quotes, meMember, team, teamMode, me?.userId, me?.role]);

  // Counts per status — adds an "invoiced" bucket on top of the quote.status
  // enum, derived from payment_status. Truly-done deals (accepted + paid +
  // GST invoice issued) get their own tab; the Accepted tab then surfaces
  // only the still-in-flight ones (accepted but money flow incomplete).
  /* R-469: every quote sits in exactly ONE tab (lib/quotes/list-tab.ts), so the tab
     counts add up to All. Before, an invoiced quote with a balance counted under
     Accepted/Invoiced AND Awaiting payment, and a rejected one showed under Expired. */
  const counts = React.useMemo(() => quoteTabCounts(quotesByWorkspace), [quotesByWorkspace]);

  // Awaiting payment = money expected but not yet fully received. Includes an
  // INVOICED quote that still has a balance due — else real outstanding cash
  // (invoiced-but-part-paid) would hide from the "chase the cash" worklist.

  /* ── Quotes waiting on THIS person's approval ─────────────────────────────
     The queue the quote page has been promising. Until this existed, the banner said
     "it is in their approvals queue" and there was no such thing — a pending quote was
     visible only to whoever thought to open it, so the other owner had no way to know.

     Deliberately NOT another status tab. Draft and Sent already count these rows, and
     two counts sitting in one row of folders get read as a total (the mistake this
     codebase has made twice) — so it lives in its own strip below, worded as a filter.
     One predicate, shared with the quote banner and the sidebar badge, so the three can
     never disagree about which quotes these are. */
  const myApprovals = me
    ? quotesByWorkspace.filter((q) => awaitsMyApproval(q, { id: me.userId, role: me.role }))
    : [];
  const [onlyMyApprovals, setOnlyMyApprovals] = React.useState(false);
  /* Turn the filter off by itself once the queue empties — otherwise clearing the last
     approval leaves the operator on a filter with nothing in it, which reads as the list
     having broken rather than the work being finished. */
  React.useEffect(() => {
    if (onlyMyApprovals && myApprovals.length === 0) setOnlyMyApprovals(false);
  }, [onlyMyApprovals, myApprovals.length]);

  const tabs: TabBarItem[] = [
    { id: "all",      label: "All",      count: counts.all ?? 0 },
    { id: "draft",    label: "Draft",    count: counts.draft ?? 0, dot: "slate" },
    { id: "sent",     label: "Sent",     count: counts.sent ?? 0, dot: "amber" },
    { id: "viewed",   label: "Viewed",   count: counts.viewed ?? 0, dot: "indigo" },
    { id: "accepted", label: "Accepted", count: counts.accepted,        dot: "emerald" },
    { id: "awaiting", label: "Awaiting payment", count: counts.awaiting, dot: "amber" },
    { id: "invoiced", label: "Invoiced", count: counts.invoiced,  dot: "emerald" },
    { id: "rejected", label: "Rejected", count: counts.rejected, dot: "rose" },
    { id: "expired",  label: "Expired",  count: counts.expired, dot: "slate" },
  ];

  // Filter
  const filtered = quotesByWorkspace.filter((q) => {
    /* Stacks with the status tabs, which is why turning it on also resets the tab to All
       (see the strip below). Left on "Invoiced", the two filters intersect to nothing and
       an operator who just clicked "Review them" would be shown an empty table. */
    if (onlyMyApprovals && !awaitsMyApproval(q, { id: me?.userId ?? "", role: me?.role })) return false;
    if (focus && !quoteInFocus(q, focus)) return false;   // the tile's own predicate
    if (tab !== "all" && quoteListTab(q) !== tab) return false;
    return quoteMatchesSearch(q, leadOf(q), search);
  });

  /* ── j / k / Enter over this table ────────────────────────────────────────
     `count` is the FILTERED length, so the selection is re-clamped whenever a tab or a
     search changes the list. Without that, Enter after a filter would open whichever row
     had slid into the old index — the wrong quote, confidently. See useListKeys. */
  /* R-105: paint 50 at a time (R-024 rule). Tab counts, KPIs, the pipeline/renewal totals
     and the CSV export still use every quote in `filtered` / `quotesByWorkspace`; only the
     two lists are paged. A new tab, focus, search, team view or approvals filter starts
     again at one page. */
  const paged = usePagedRows(
    filtered,
    QUOTES_PAGE_SIZE,
    quotesPagingKey({ tab, focus, search, teamMode, onlyMyApprovals }),
  );

  const keys = useListKeys({
    count: paged.shown.length,   // only the rows on screen (R-105)
    onOpen: (i) => {
      const q = paged.shown[i];
      if (q) router.push(`/quotes/${q.id}` as never);
    },
  });

  /* The selected row scrolls itself into view: driving a long list by keyboard is useless
     if the highlight walks off the bottom of the screen. */
  const selectedRowRef = React.useRef<HTMLTableRowElement | null>(null);
  React.useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [keys.index]);

  // KPIs
  /* R-469: Pipeline = quotes still open (draft, sent, viewed) — not invoiced, rejected or
     replaced ones. The margin tile below reads the same set. */
  const pipelineQuotes = quotesByWorkspace.filter(isPipelineQuote);
  const totalValue = focusValue(quotesByWorkspace, "pipeline");
  const acceptedValue = focusValue(quotesByWorkspace, "accepted");
  const sentValue = focusValue(quotesByWorkspace, "review");
  /* Only quotes whose margin is actually KNOWN are summed, and how many were left
     out is carried alongside — a total that silently drops the unknown ones reads as
     a complete measurement of the pipeline when it is a partial one. */
  const marginablePipeline = pipelineQuotes.map((q) => estimateMarginForQuote(q));
  const pipelineMargin = marginablePipeline.filter((m) => m.known).reduce((s, m) => s + m.margin, 0);
  const pipelineMarginUnknownCount = marginablePipeline.filter((m) => !m.known).length;
  /* Every accepted quote (invoiced ones too) — the same set as the Accepted tile's value. */
  const acceptedCount = quotesByWorkspace.filter((q) => quoteInFocus(q, "accepted")).length;
  const sentishCount = quotesByWorkspace.filter((q) => quoteInFocus(q, "review")).length;
  const expiringCount = sentishCount;
  const winRate = quotesByWorkspace.length > 0
    ? Math.round((acceptedCount / Math.max(1, quotesByWorkspace.filter((q) => q.status !== "draft").length)) * 100)
    : 0;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto flex flex-col min-h-[calc(100vh-56px)]">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Revenue</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Quotes</h1>
          <p className="text-sm text-ink-3 mt-1">All generated quotes · sorted by most recent</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {view === "project" ? (
            <Button variant="primary" icon="plus" onClick={() => setProjectQuoteOpen(true)}>
              {COPY.newQuote}
            </Button>
          ) : (
            <Button asChild variant="primary" icon="plus">
              <Link href={"/quotes/new" as any}>{COPY.newQuote}</Link>
            </Button>
          )}
        </div>
      </div>

      {/* Subscription vs Project quotes toggle */}
      <div className="mb-4">
        <TabBar
          value={view}
          onChange={(v) => setView(v as "subscription" | "project")}
          items={[
            { id: "subscription", label: "Subscription", count: quotes?.length || undefined },
            { id: "project",      label: "Project",      count: projectQuotes?.length || undefined },
          ]}
        />
      </div>

      {/* ─── PROJECT quotes view ─── */}
      {view === "project" && (
        (projectQuotes?.length ?? 0) > 0 ? (
          <Card flush>
            {/* Mobile card list — phones only */}
            <ul className="md:hidden divide-y divide-hairline">
              {(projectQuotes ?? []).map((p) => (
                <li key={p.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      {p.customer_id ? (
                        <Link href={`/customers/${p.customer_id}` as never} className="font-medium text-ink hover:text-amber-ink hover:underline block truncate">{p.customer_name}</Link>
                      ) : (
                        <span className="font-medium text-ink block truncate">{p.customer_name}</span>
                      )}
                      <Link href={`/projects/${p.id}` as never} className="text-2xs text-ink-2 hover:text-amber-ink hover:underline block truncate">{p.title}</Link>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button type="button" aria-label="Actions" className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-paper-2 hover:text-ink shrink-0">
                          <Icon name="more_h" size={18} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-[12rem]">
                        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => router.push(`/projects/${p.id}` as any)}>
                          <Icon name="eye" size={15} /> Open project
                        </DropdownMenuItem>
                        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => window.open(`/project-quote/${p.id}?t=${p.public_token}`, "_blank", "noopener")}>
                          <Icon name="file" size={15} /> Preview quote (customer view)
                        </DropdownMenuItem>
                        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setEditProject(p)}>
                          <Icon name="edit" size={15} /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem destructive className="gap-2.5 py-2 cursor-pointer" onClick={async () => {
                          if (await confirm({ title: `Delete project "${p.title}"?`, body: "This removes the project + its milestone schedule. (Blocked if any milestone is already invoiced — delete that invoice first.)\n\nThis cannot be undone.", confirmLabel: "Delete", danger: true })) {
                            deleteProject.mutate(p.id);
                          }
                        }}>
                          <Icon name="trash" size={15} /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-2">
                    <Badge kind={p.status === "completed" ? "success" : p.status === "cancelled" ? "muted" : p.status === "quoted" ? "info" : "warning"} size="sm" dot>
                      {p.status === "quoted" ? "Quotation" : p.status}
                    </Badge>
                    <div className="text-right">
                      <span className="font-serif text-base tabular-nums text-ink">{rupee(p.total_amount)}</span>
                      {p.receivable > 0 && <span className="block text-3xs text-rose">{rupee(p.receivable)} due</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            <div className="hidden md:block overflow-auto max-h-[calc(100vh-15rem)]">
              <table className="w-full text-sm min-w-[620px]">
                <thead className="sticky top-0 z-10 bg-paper-2 border-b border-hairline text-3xs uppercase tracking-wider text-ink-3">
                  <tr>
                    <th className="text-left px-4 py-2.5">Customer / Project</th>
                    <th className="text-left px-3 py-2.5">Type</th>
                    <th className="text-right px-3 py-2.5">Amount (incl GST)</th>
                    <th className="text-right px-3 py-2.5">Outstanding</th>
                    <th className="text-left px-4 py-2.5">Status</th>
                    <th className="w-12"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {(projectQuotes ?? []).map((p) => (
                    <tr key={p.id} className="hover:bg-paper-2/40">
                      <td className="px-4 py-3">
                        {p.customer_id ? (
                          <Link href={`/customers/${p.customer_id}` as never} className="font-medium text-ink hover:text-amber-ink hover:underline">{p.customer_name}</Link>
                        ) : (
                          <span className="font-medium text-ink">{p.customer_name}</span>
                        )}
                        <span className="text-ink-3"> · </span>
                        <Link href={`/projects/${p.id}` as never} className="text-ink-2 hover:text-amber-ink hover:underline">{p.title}</Link>
                      </td>
                      <td className="px-3 py-3"><Badge kind="info" size="sm">Project</Badge></td>
                      <td className="px-3 py-3 text-right tabular-nums font-medium text-ink">{rupee(p.total_amount)}</td>
                      <td className="px-3 py-3 text-right tabular-nums"><span className={p.receivable > 0 ? "text-rose" : "text-emerald"}>{rupee(p.receivable)}</span></td>
                      <td className="px-4 py-3">
                        <Badge kind={p.status === "completed" ? "success" : p.status === "cancelled" ? "muted" : p.status === "quoted" ? "info" : "warning"} size="sm" dot>
                          {p.status === "quoted" ? "Quotation" : p.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button type="button" aria-label="Actions" className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2">
                              <Icon name="more_h" size={18} />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-[12rem]">
                            <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => router.push(`/projects/${p.id}` as any)}>
                              <Icon name="eye" size={15} /> Open project
                            </DropdownMenuItem>
                            <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => window.open(`/project-quote/${p.id}?t=${p.public_token}`, "_blank", "noopener")}>
                              <Icon name="file" size={15} /> Preview quote (customer view)
                            </DropdownMenuItem>
                            <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setEditProject(p)}>
                              <Icon name="edit" size={15} /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem destructive className="gap-2.5 py-2 cursor-pointer" onClick={async () => {
                              if (await confirm({ title: `Delete project "${p.title}"?`, body: "This removes the project + its milestone schedule. (Blocked if any milestone is already invoiced — delete that invoice first.)\n\nThis cannot be undone.", confirmLabel: "Delete", danger: true })) {
                                deleteProject.mutate(p.id);
                              }
                            }}>
                              <Icon name="trash" size={15} /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : (
          (() => {
            /* R-063: say it is empty for THIS kind, and point at the other tab. */
            const c = quotesEmptyCopy("project", quotes?.length ?? 0);
            return (
              <EmptyState icon="package" title={c.title} body={c.body}
                action={<Button variant="primary" icon="file" onClick={() => router.push("/projects" as never)}>Project Sales</Button>}
                secondary={c.switchLabel ? <Button onClick={() => setView("subscription")}>{c.switchLabel}</Button> : undefined} />
            );
          })()
        )
      )}

      {view === "subscription" && (
        <>
          {/* Collapsible KPI & Quote Intelligence Banner */}
          {!isLoading && quotes && quotes.length > 0 && (
            <div className="mb-4 bg-paper border border-hairline rounded-lg overflow-hidden transition-all shadow-xs">
              <button
                type="button"
                onClick={() => setKpiOpen((o) => !o)}
                className="w-full flex items-center justify-between px-3.5 py-2.5 bg-paper-2/70 hover:bg-paper-2 transition-colors text-left cursor-pointer"
              >
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <Icon name="bar_chart" size={15} className="text-amber-ink" />
                  <span className="font-semibold text-ink">Quote Analytics &amp; Intelligence</span>
                  <span className="text-ink-3">·</span>
                  <span className="text-ink-2 font-mono font-medium">Pipeline: <b className="text-amber-ink">{rupee(totalValue, { compact: true })}</b></span>
                  <span className="text-ink-3 font-mono">·</span>
                  <span className="text-ink-2 font-mono font-medium">Out for Review: <b className="text-ink">{rupee(sentValue, { compact: true })}</b> ({sentishCount})</span>
                  <span className="text-ink-3 font-mono">·</span>
                  <span className="text-ink-2 font-mono font-medium">Accepted: <b className="text-emerald">{rupee(acceptedValue, { compact: true })}</b> ({acceptedCount})</span>
                </div>
                <div className="flex items-center gap-1 text-xs font-semibold text-amber-ink shrink-0 ml-2">
                  <span>{kpiOpen ? "Collapse" : "Expand"}</span>
                  <Icon name={kpiOpen ? "chevron_up" : "chevron_down"} size={14} />
                </div>
              </button>

              {kpiOpen && (
                <div className="p-3 border-t border-hairline space-y-3 bg-paper">
                  {/* Interactive KPI Stat Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                    <button
                      type="button"
                      onClick={() => focusOn("pipeline")}
                      aria-pressed={focus === "pipeline"}
                      className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left hover:border-amber/60 transition-all cursor-pointer"
                    >
                      <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Pipeline</p>
                      <p className="font-serif text-lg font-bold text-amber-ink tabular-nums mt-0.5">{rupee(totalValue, { compact: true })}</p>
                    </button>
                    <button
                      type="button"
                      onClick={() => focusOn("review")}
                      aria-pressed={focus === "review"}
                      className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left hover:border-amber/60 transition-all cursor-pointer"
                    >
                      <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Out for review</p>
                      <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{rupee(sentValue, { compact: true })}</p>
                    </button>
                    <button
                      type="button"
                      onClick={() => focusOn("accepted")}
                      aria-pressed={focus === "accepted"}
                      className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left hover:border-emerald/60 transition-all cursor-pointer"
                    >
                      <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Accepted</p>
                      <p className="font-serif text-lg font-bold text-emerald tabular-nums mt-0.5">{rupee(acceptedValue, { compact: true })}</p>
                    </button>
                    <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                      <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Pipeline Margin</p>
                      <p className="font-serif text-lg font-bold text-emerald tabular-nums mt-0.5">{rupee(pipelineMargin, { compact: true })}</p>
                      {/* A total that silently drops the unknowns reads as a complete
                          measurement of the pipeline when it is a partial one. */}
                      {pipelineMarginUnknownCount > 0 && (
                        <p className="mt-0.5 text-3xs leading-snug text-amber-ink">
                          {pipelineMarginUnknownCount} quote{pipelineMarginUnknownCount === 1 ? "" : "s"} excluded — no cost
                        </p>
                      )}
                    </div>
                    <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                      <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Win Rate</p>
                      <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{winRate}%</p>
                    </div>
                    {/* The list's own set (team cut applied) — quotes.length counted every
                        quote in the workspace while the list below showed the team's. */}
                    <button
                      type="button"
                      onClick={() => tabOn("all")}
                      className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left hover:border-amber/60 transition-all cursor-pointer"
                    >
                      <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Total Quotes</p>
                      <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{quotesByWorkspace.length}</p>
                    </button>
                  </div>

                  {/* Quote Intelligence */}
                  {expiringCount > 0 && (
                    <GeminiCard
                      title="Quote intelligence"
                      actions={
                        /* Until 2 Oct 2026 this button toasted "Nudge sent for N expiring
                           quotes" and sent nothing — a success message for an action that
                           never happened. It now opens the quotes it is about. */
                        <Button size="sm" variant="primary" icon="eye" onClick={() => focusOn("review")}>
                          Show these quotes
                        </Button>
                      }
                      compact
                    >
                      <b>{expiringCount} quote{expiringCount === 1 ? "" : "s"} out for review.</b> Follow-ups run on their own on day 2, 4 and 7 after sending — drafted on the lead while the follow-up setting is on hold.
                    </GeminiCard>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Somebody is waiting on you ───────────────────────────
              Above the tabs and outside them, because it is not a status — it is work
              addressed to the person reading the screen. Its own component so it can be
              render-tested: the one pending quote in the live books was raised by the only
              login on this machine, and nobody may approve their own quote, so the running
              app correctly shows this strip to no one. */}
          <ApprovalsStrip
            count={myApprovals.length}
            filtered={onlyMyApprovals}
            onToggle={(next) => {
              setOnlyMyApprovals(next);
              /* All, so the approval filter cannot land on a status tab that excludes every
                 quote it just selected — an operator who clicked "Review them" and got an
                 empty table would read it as the queue being wrong. */
              if (next) tabOn("all");
            }}
          />

          {/* Sticky Horizontal TabBar + Date Range + Search */}
          {!isLoading && quotes && quotes.length > 0 && (
            <div className="sticky top-[56px] z-20 bg-paper/95 backdrop-blur-md py-3 -mx-4 px-4 md:-mx-6 md:px-6 lg:-mx-8 lg:px-8 mb-4 border-b border-hairline transition-all space-y-3">
              {focus && (
                <FocusBanner label={QUOTE_FOCUS_LABEL[focus]} count={filtered.length} onClear={() => setFocus("")} />
              )}
              <TabBar className="overflow-y-hidden" value={tab} onChange={tabOn} items={tabs} />
              <div className="flex justify-between items-center gap-3 flex-wrap">
                <div className="text-xs text-ink-3">
                  {paged.hidden > 0
                    ? <>Showing {paged.shown.length} of {filtered.length} quotes</>
                    : <>Showing {filtered.length} of {counts.all ?? 0} quote{counts.all === 1 ? "" : "s"}</>}
                  {/* Beside the count on purpose: the count is the thing the toggle
                      changes, and a filter whose effect is shown somewhere else on the
                      page reads as the list being wrong. */}
                  <TeamViewToggle
                    className="mt-1.5"
                    me={meMember}
                    all={team}
                    mode={teamMode}
                    onChange={setTeamMode}
                    /* False until 20260818150000_user_hierarchy_visibility.sql is applied.
                       One flag, one call site, so the caveat disappears everywhere the day
                       the database actually enforces it. */
                    enforcedInDatabase={HIERARCHY_ENFORCED_IN_DATABASE}
                    /* This page is why the counts exist: every quote in the live books has a
                       NULL owner, so both halves of the toggle show the same rows and the
                       note used to call them "assigned to you". */
                    counts={{
                      total: (quotes ?? []).length,
                      unassigned: (quotes ?? []).filter((q) => !q.owner_id).length,
                    }}
                  />
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <div className="w-full sm:w-64">
                    <Input
                      aria-label="Search quotes"
                      prefix={<Icon name="search" size={14} />}
                      placeholder="Quote ID, customer, product…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  {/* Data-portability (audit B7): jo list dikh rahi hai wahi utarti hai. */}
                  <Button
                    variant="outline"
                    icon="download"
                    onClick={() => {
                      downloadCSV(`quotes-${istToday()}.csv`, [...QUOTES_CSV_HEADERS], quotesCsvRows(quotes ?? []));
                      toast.success(`Exported ${(quotes ?? []).length} quotes to CSV`);
                    }}
                  >
                    <span className="hidden md:inline">Export</span>
                  </Button>
                </div>
              </div>
            </div>
          )}

      {/* Error */}
      {error && (
        <EmptyState
          icon="alert"
          title="Could not load quotes"
          body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
        />
      )}

      {/* Loading */}
      {isLoading && (
        <Card flush>
          <table className="w-full">
            <tbody>
              {[1, 2, 3, 4, 5].map((i) => (
                <tr key={i} className="border-b border-hairline">
                  {[1, 2, 3, 4, 5, 6].map((j) => (
                    <td key={j} className="p-3"><Skeleton className="h-3 w-full" /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Empty */}
      {!isLoading && !error && quotes && quotes.length === 0 && (() => {
        /* R-063: was "No quotes yet" even with project quotes in the next tab. */
        const c = quotesEmptyCopy("subscription", projectQuotes?.length ?? 0);
        return (
          <EmptyState
            icon="file"
            title={c.title}
            body={c.body}
            action={
              <Button asChild variant="primary" icon="plus">
                <Link href={"/quotes/new" as any}>{c.switchLabel ? "New quote" : "Create your first quote"}</Link>
              </Button>
            }
            secondary={c.switchLabel ? <Button onClick={() => setView("project")}>{c.switchLabel}</Button> : undefined}
          />
        );
      })()}

      {/* Filtered empty */}
      {!isLoading && !error && quotes && quotes.length > 0 && filtered.length === 0 && (
        <div className="mt-6">
          <EmptyState
            icon="search"
            title="No quotes match"
            body={search ? `No results for "${search}".` : `No quotes in "${tab}" status.`}
            action={<Button icon="x" onClick={() => { tabOn("all"); setSearch(""); }}>Clear filters</Button>}
            compact
          />
        </div>
      )}

      {/* Adaptive card list — phones, tablets, and medium viewports (< 1280px) */}
      {!isLoading && !error && filtered.length > 0 && (
        <ul className="xl:hidden space-y-2 mb-3">
          {paged.shown.map((q) => {
            const uStatus = unifiedStatus(q);
            const note = cashNote(q);
            const dl = q.expires_date ? daysBetween(new Date(), q.expires_date) : null;
            return (
              <li key={q.id}>
                <Link
                  href={`/quotes/${q.id}` as never}
                  className="block bg-paper border border-hairline rounded-lg p-3.5 active:bg-paper-2/50 hover:border-amber/50 transition-colors"
                >
                  {/* Top row: ID + amount */}
                  <div className="flex items-start justify-between gap-3 mb-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-mono text-xs font-semibold text-ink">{q.id}</span>
                        {q.is_extension ? (
                          <Badge kind="warning" className="font-sans text-3xs">
                            Extension · {Math.round((q.extension_months ?? 12) / 12)}yr
                          </Badge>
                        ) : q.is_renewal ? (
                          <Badge kind="info" className="font-sans text-3xs">Renewal</Badge>
                        ) : q.is_add_seats ? (
                          <Badge kind="info" className="font-sans text-3xs">Prorata</Badge>
                        ) : q.is_one_off ? (
                          <Badge kind="muted" className="font-sans text-3xs">Direct invoice</Badge>
                        ) : null}
                      </div>
                      <p className="text-sm font-semibold text-ink mt-1 truncate">
                        {cleanDisplayName(partyOf(q))}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-serif text-base font-bold tabular-nums text-ink">
                        {quoteMoney(q)}
                        <span className="text-2xs font-normal text-ink-3">{cycleSuffix(q.billing_cycle)}</span>
                      </p>
                      <p className="text-2xs text-ink-3 tabular-nums">
                        {q.seats ?? "—"} seats
                      </p>
                    </div>
                  </div>
                  {/* Bottom row: plan + status badges */}
                  <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-hairline/60">
                    <span className="text-xs text-ink-2 truncate font-medium">
                      {q.plan ?? "—"}
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {dl !== null && dl >= 0 && dl <= 7 && q.status === "sent" && (
                        <Badge kind="warning" size="sm">
                          {dl}d left
                        </Badge>
                      )}
                      {/* The cash note never appeared on the card at all — only in the
                          desktop table. So below 1280px, where this card list IS the page,
                          a quote holding ₹20,000 showed a status badge and no money
                          anywhere. Same helper as the table, so the two cannot drift. */}
                      {note && (
                        <span className={cn(
                          "text-3xs font-semibold tabular-nums",
                          note.tone === "owed" ? "text-rose" : "text-amber-ink",
                        )}>
                          {note.text}
                        </span>
                      )}
                      <Badge kind={uStatus.kind} size="sm" dot>{uStatus.label}</Badge>
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
          {paged.hidden > 0 && (
            <li>
              <LoadMore hidden={paged.hidden} pageSize={QUOTES_PAGE_SIZE} noun="quotes" onLoadMore={paged.loadMore} />
            </li>
          )}
          <li className="pt-2 text-center text-2xs text-ink-3">
            Showing {paged.hidden > 0 ? `${paged.shown.length} of ${filtered.length}` : `${filtered.length} of ${counts.all ?? 0}`} · Total {rupee(filtered.reduce((s, q) => s + (q.amount ?? 0), 0), { compact: true })}
          </li>
        </ul>
      )}

      {/* Desktop table — large viewports (>= 1280px) */}
      {!isLoading && !error && filtered.length > 0 && (
        <div className="hidden xl:block">
          <Card flush>
            <table className="w-full">
              <thead className="bg-paper-2 border-b border-hairline-strong">
                <tr>
                  <th className="text-left px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider">Quote</th>
                  <th className="text-left px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider">Customer</th>
                  <th className="text-left px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider">Plan</th>
                  <th className="text-right px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider">Amount</th>
                  <th className="text-right px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider" title="Annual margin">Margin</th>
                  <th className="text-left px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                  <th className="text-left px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider">Validity</th>
                  <th className="px-2 py-2.5 text-right"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {paged.shown.map((q, rowIndex) => {
                  const margin = estimateMarginForQuote(q);
                  const uStatus = unifiedStatus(q);
                  const dl = q.expires_date ? daysBetween(new Date(), q.expires_date) : null;
                  const expiringSoon = dl !== null && dl >= 0 && dl <= 7;
                  const kbSelected = rowIndex === keys.index;
                  return (
                    <tr
                      key={q.id}
                      ref={kbSelected ? selectedRowRef : undefined}
                      onClick={() => router.push(`/quotes/${q.id}` as any)}
                      /* aria-selected, not only a tint: a screen reader has to know which
                         row Enter will open, and a background colour says nothing to it. */
                      aria-selected={kbSelected}
                      className={cn(
                        "group border-b border-hairline last:border-0 cursor-pointer transition-colors",
                        kbSelected
                          ? "bg-amber-soft/60 ring-1 ring-inset ring-amber/40"
                          : "hover:bg-paper-2/50",
                      )}
                    >
                      {/* Compact ID — the tail number as a chip; full ID on hover. */}
                      <td className="px-3 py-2.5 align-top" title={q.id}>
                        <div className="flex items-center gap-1.5">
                          <span className="inline-flex items-center rounded-md bg-paper-2 px-1.5 py-0.5 font-mono text-2xs font-semibold text-ink">
                            #{q.id.split("-").pop()}
                          </span>
                          {q.is_extension ? (
                            <Badge kind="warning" className="font-sans text-3xs">
                              Ext · {Math.round((q.extension_months ?? 12) / 12)}yr
                            </Badge>
                          ) : q.is_renewal ? (
                            <Badge kind="info" className="font-sans text-3xs">Renewal</Badge>
                          ) : q.is_add_seats ? (
                            <Badge kind="info" className="font-sans text-3xs">Prorata</Badge>
                          ) : q.is_one_off ? (
                            <Badge kind="muted" className="font-sans text-3xs">Direct invoice</Badge>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <div className="font-medium text-ink leading-snug break-words max-w-[220px]" title={cleanDisplayName(partyOf(q))}>{cleanDisplayName(partyOf(q))}</div>
                        {phoneSuffixOf(partyOf(q)) && (
                          <div className="text-3xs text-ink-3 tabular-nums mt-0.5">{phoneSuffixOf(partyOf(q))}</div>
                        )}
                      </td>
                      {/* Plan — wraps to a second line rather than truncating with "…". */}
                      <td className="px-3 py-2.5 text-sm text-ink-2 align-top">
                        <div className="leading-snug break-words max-w-[240px]">{q.plan ?? "—"}</div>
                        {q.seats != null && (
                          <div className="text-3xs text-ink-3 mt-0.5"><span className="font-semibold text-ink-2 tabular-nums">{q.seats}</span> seats</div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right align-top">
                        <div className="flex flex-col items-end gap-0.5">
                          <span className="tabular-nums text-sm font-medium text-ink">
                            {quoteMoney(q)}
                            <span className="text-3xs font-normal text-ink-3">{cycleSuffix(q.billing_cycle)}</span>
                          </span>
                          {/* Foreign quote: show the ₹ base underneath so the amount
                              reconciles with the (all-INR) pipeline totals. */}
                          {isForeignCurrency(q.currency) && q.amount ? (
                            <span className="text-3xs text-ink-3 tabular-nums">≈ {rupee(q.amount)}</span>
                          ) : null}
                        </div>
                      </td>
                      {/* Margin — colour-coded badge: green = healthy, amber =
                          thin, rose = risky. ₹ amount below for reference. */}
                      <td className="px-3 py-2.5 text-right align-top">
                        {!q.amount ? (
                          <span className="text-ink-3">—</span>
                        ) : !margin.known ? (
                          /* "Unknown" rather than the 100% a ₹0 cost arithmetically
                              produces — a green 100% badge is the most misleading
                              thing this column could show. */
                          <Badge kind="warning" size="sm" title="A line on this quote has no vendor cost.">
                            Unknown
                          </Badge>
                        ) : (
                          <div className="flex flex-col items-end gap-0.5">
                            <Badge
                              kind={margin.marginPct >= 18 ? "success" : margin.marginPct >= 14 ? "warning" : "danger"}
                              size="sm"
                            >
                              {margin.marginPct}%
                            </Badge>
                            <span className="text-3xs text-ink-3 tabular-nums">{rupee(margin.margin)}</span>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        {(() => {
                          /* One call, not three. dueHint(q) was invoked three times per
                             row — once to test, once to compare, once to print — and the
                             comparison was against the literal "Awaiting payment", so
                             rewording that string would silently have turned every
                             outstanding balance the wrong colour. */
                          const note = cashNote(q);
                          return (
                            <div className="flex flex-col items-start gap-0.5">
                              <Badge kind={uStatus.kind} dot>{uStatus.label}</Badge>
                              {/* Did this quote actually become a service? "Accepted"
                                  alone never said.

                                  Deliberately ONLY that — no payment due date here
                                  (Abhishek, 11 Sep 2026). This cell already carries the
                                  quote status and "Awaiting payment"; a third money line
                                  made four stacked lines per row and pushed the table
                                  taller than the information justified. The credit clock
                                  lives on /subscriptions and /payments, where chasing
                                  actually happens. */}
                              {(() => {
                                const sub = subByQuoteId.get(q.id);
                                if (!sub) return null;
                                return (
                                  <Badge
                                    kind={sub.status === "active" ? "success" : "muted"}
                                    size="sm"
                                    title={`${sub.plan} · ${sub.seats} seats · renews ${sub.renewal_date ? formatDate(sub.renewal_date) : "—"}`}
                                  >
                                    {sub.status === "active" ? "Subscription live" : `Subscription ${sub.status}`}
                                  </Badge>
                                );
                              })()}
                              {note && (
                                <span className={cn(
                                  "text-3xs font-medium tabular-nums",
                                  note.tone === "owed" ? "text-rose" : "text-amber-ink",
                                )}>
                                  {note.text}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2.5 text-sm align-top">
                        {q.status === "accepted" || q.status === "rejected" ? (
                          <span className="text-ink-3">—</span>
                        ) : dl === null ? (
                          <span className="text-ink-3">—</span>
                        ) : dl < 0 ? (
                          <Badge kind="danger" dot>Expired {Math.abs(dl)}d</Badge>
                        ) : expiringSoon ? (
                          <Badge kind="warning" dot>{dl}d left</Badge>
                        ) : (
                          <span className="text-xs text-ink-3 tabular-nums">{dl}d left</span>
                        )}
                      </td>
                      <td className="px-2 py-2.5 text-right align-top" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5">
                          {q.status === "draft" && (
                            <Button asChild size="sm" variant="primary" icon="send">
                              <Link href={`/quotes/${q.id}` as any}>Send</Link>
                            </Button>
                          )}
                          {(q.status === "sent" || q.status === "viewed") && (
                            <div className="flex gap-1">
                              <Button
                                size="sm"
                                variant="primary"
                                icon="whatsapp"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const msg = encodeURIComponent(`Namaste ${partyOf(q)},\n\nQuick follow up regarding Quote #${q.id} (${q.plan || "Google Workspace"}) for ₹${(q.amount ?? 0).toLocaleString("en-IN")}.\n\nPlease let us know if you need any clarification.\n\nDhanyavaad`);
                                  window.open(`https://web.whatsapp.com/send?text=${msg}`, "_blank");
                                }}
                              >
                                WhatsApp
                              </Button>
                              <Button asChild size="sm" icon="external">
                                <Link href={`/quotes/${q.id}` as any}>Open</Link>
                              </Button>
                            </div>
                          )}
                          {q.status === "accepted" && (() => {
                            // What happens NEXT on an accepted quote depends on
                            // how far the money flow has progressed. The button
                            // tells the operator exactly which step is pending.
                            const ps = q.payment_status;
                            if (ps === "invoiced") {
                              // Terminal — money flow complete, jump to the
                              // actual invoice's own page (R-218: invoiceHref)
                              return (
                                <Button asChild size="sm" icon="receipt">
                                  <Link
                                    href={
                                      q.invoice_id
                                        ? (invoiceHref(q.invoice_id) as any)
                                        : (`/quotes/${q.id}` as any)
                                    }
                                  >
                                    Invoiced
                                  </Link>
                                </Button>
                              );
                            }
                            if (ps === "received") {
                              return (
                                <Button asChild size="sm" variant="primary" icon="receipt">
                                  <Link href={`/quotes/${q.id}` as any}>Generate invoice</Link>
                                </Button>
                              );
                            }
                            if (ps === "partial") {
                              return (
                                <Button asChild size="sm" icon="rupee">
                                  <Link href={`/quotes/${q.id}` as any}>Continue billing</Link>
                                </Button>
                              );
                            }
                            // 'none' or 'awaiting' — money hasn't started flowing yet
                            return (
                              <Button asChild size="sm" variant="primary" icon="rupee">
                                <Link href={`/quotes/${q.id}` as any}>Record payment</Link>
                              </Button>
                            );
                          })()}
                          {(q.status === "expired" || q.status === "rejected") && (
                            <Button asChild size="sm" icon="copy">
                              <Link href={`/quotes/new` as any}>Re-quote</Link>
                            </Button>
                          )}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <IconButton
                                icon="more_h"
                                size="sm"
                                variant="ghost"
                                aria-label={`Actions for quote ${q.id}`}
                              />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-[13rem]">
                              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setPreviewing(q)}>
                                <Icon name="file" size={15} /> View PDF preview
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="gap-2.5 py-2 cursor-pointer"
                                onClick={() => {
                                  const url = `${window.location.origin}/quotes/${q.id}`;
                                  navigator.clipboard.writeText(url);
                                  toast.success("Quote link copied to clipboard!");
                                }}
                              >
                                <Icon name="link" size={15} /> Copy quote link
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="gap-2.5 py-2 cursor-pointer text-emerald font-medium"
                                onClick={() => {
                                  const msg = encodeURIComponent(`Namaste ${partyOf(q)},\n\nQuick follow up regarding Quote #${q.id} (${q.plan || "Google Workspace"}) for ₹${(q.amount ?? 0).toLocaleString("en-IN")}.\n\nPlease let us know if you need any clarification.\n\nDhanyavaad`);
                                  window.open(`https://web.whatsapp.com/send?text=${msg}`, "_blank");
                                }}
                              >
                                <Icon name="whatsapp" size={15} /> Send / nudge on WhatsApp
                              </DropdownMenuItem>
                              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => router.push(`/quotes/${q.id}` as any)}>
                                <Icon name="edit" size={15} /> Open / edit
                              </DropdownMenuItem>
                              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => router.push(`/quotes/${q.id}?send=1` as any)}>
                                <Icon name="send" size={15} /> Send / nudge
                              </DropdownMenuItem>
                              {(q.status === "accepted" || q.payment_status === "received") && q.payment_status !== "invoiced" && (
                                <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => router.push(`/quotes/${q.id}` as any)}>
                                  <Icon name="receipt" size={15} /> Convert to invoice
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => handleDuplicate(q)}>
                                <Icon name="copy" size={15} /> Duplicate &amp; revise
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem destructive className="gap-2.5 py-2 cursor-pointer" onClick={() => handleDelete(q)}>
                                <Icon name="trash" size={15} /> Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {/* Table footer: closes the empty space visually + summary */}
            <div className="flex items-center justify-between gap-3 flex-wrap border-t border-hairline px-4 py-3 bg-paper-2/30 text-xs text-ink-3">
              <div className="flex items-center gap-2">
                <Icon name="check_circle" size={12} className="text-emerald" />
                <span>
                  {paged.hidden > 0
                    ? <>Showing {paged.shown.length} of {filtered.length} quotes · {paged.hidden} more below</>
                    : <>End of list · Showing {filtered.length} of {counts.all ?? 0} quotes</>}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span>
                  Total value:{" "}
                  <b className="text-ink tabular-nums">
                    {rupee(filtered.reduce((s, q) => s + (q.amount ?? 0), 0), { compact: true })}
                  </b>
                </span>
                <span className="hidden sm:inline">·</span>
                <span className="hidden sm:inline">
                  Renewals:{" "}
                  <b className="text-ink tabular-nums">
                    {filtered.filter((q) => q.is_renewal && !q.is_extension).length}
                  </b>
                </span>
                {filtered.some((q) => q.is_extension) && (
                  <>
                    <span className="hidden sm:inline">·</span>
                    <span className="hidden sm:inline">
                      Extensions:{" "}
                      <b className="text-ink tabular-nums">
                        {filtered.filter((q) => q.is_extension).length}
                      </b>
                    </span>
                  </>
                )}
              </div>
            </div>
          </Card>

          <LoadMore hidden={paged.hidden} pageSize={QUOTES_PAGE_SIZE} noun="quotes" onLoadMore={paged.loadMore} />

          {/* Help text — pushed to bottom via mt-auto when content is short */}
          <div className="flex items-center gap-1.5 text-xs text-ink-3 mt-3">
            <Icon name="info" size={11} />
            Click any row to open the quote. Hit the file icon for a quick PDF preview.
          </div>
          {/* Spacer that pushes everything else up when the page is short */}
          <div className="mt-auto" aria-hidden />
        </div>
      )}

      </>)}

      {/* Quick preview dialog (driven by the row's eye/file icon button).
          Rendered via a small fetching container so it can load the customer's
          state_code and derive the GST head (IGST vs CGST+SGST) accurately —
          the lean list query doesn't carry state_code. (audit #18-20) */}
      {previewing && (
        <QuotePreviewContainer
          quote={previewing}
          onClose={() => setPreviewing(null)}
        />
      )}

      {/* Mobile FAB — primary action in the thumb zone (view-aware) */}
      {view === "project" ? (
        <FAB icon="plus" label="New quote" onClick={() => setProjectQuoteOpen(true)} />
      ) : (
        <FAB icon="plus" label="New quote" href="/quotes/new" />
      )}

      <CreateProjectQuoteDialog open={projectQuoteOpen} onOpenChange={setProjectQuoteOpen} />
      <CreateProjectQuoteDialog
        open={editProject !== null}
        onOpenChange={(o) => { if (!o) setEditProject(null); }}
        editProject={editProject}
      />

      {/* Appears only once a key has actually been pressed. A permanent bar across the
          bottom of every list is chrome an operator stops seeing within a day, and it
          costs 40px of a phone screen for ever. */}
      <KeyHintBar visible={keys.index >= 0} onShowHelp={() => setHelpOpen(true)} />
      <ShortcutsSheet open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

/**
 * QuotePreviewContainer — renders the quick quote preview. Lives in its own
 * component (not an inline IIFE) so it can use hooks: it fetches the quote's
 * customer to read `state_code` and derive the GST head (IGST vs CGST+SGST)
 * via the shared helper, matching the authoritative quote-detail / tax-invoice
 * surfaces. The quotes list query is lean and omits customer state, so the
 * lookup happens here, on demand, only when a preview is open. (audit #18-20)
 */
function QuotePreviewContainer({ quote, onClose }: { quote: Quote; onClose: () => void }) {
  const { data: currentUser } = useCurrentUser();
  const { data: customer }    = useCustomer(quote.customer_id ?? undefined);

  const items: QuoteLineItem[] = Array.isArray(quote.line_items) ? (quote.line_items as QuoteLineItem[]) : [];
  const discount = Math.round(quote.subtotal * (quote.discount_pct / 100));
  const taxable  = quote.subtotal - discount;
  const tax      = Math.round(taxable * (quote.tax_rate / 100));
  const total    = quote.amount ?? taxable + tax;
  const validity = quote.expires_date
    ? Math.max(1, daysBetween(new Date(quote.created_at), quote.expires_date))
    : 30;
  /* R-376 (f): customer → lead → typed prospect; names the state ("Haryana (06) · IGST"). */
  const { data: lead } = useLead(!quote.customer_id ? (quote.lead_id ?? undefined) : undefined);
  const pos = quotePlaceOfSupply({
    customer: customer ?? null,
    lead: lead ?? null,
    quote,
    seller: { state_code: currentUser?.tenantStateCode, gstin: currentUser?.tenantGstin },
  });
  const interState = pos.interState;

  return (
    <QuotePreviewDialog
      open
      onOpenChange={(o) => !o && onClose()}
      tenantName={currentUser?.tenantName    ?? "Workspace"}
      tenantGstin={currentUser?.tenantGstin}
      tenantEmail={currentUser?.tenantEmail}
      tenantPhone={currentUser?.tenantPhone}
      tenantAddress={currentUser?.tenantAddress}
      quoteId={quote.id}
      customerName={quote.customer_name}
      contactName={null}
      contactEmail={null}
      contactPhone={null}
      lineItems={items}
      subtotal={quote.subtotal}
      discountPct={quote.discount_pct}
      discount={discount}
      taxable={taxable}
      taxRate={quote.tax_rate}
      tax={tax}
      total={total}
      interState={interState}
      placeOfSupply={pos.label}
      isExport={pos.isExport}
      validityDays={validity}
      notes={quote.notes ?? ""}
      isProspect={!!quote.lead_id}
    />
  );
}
