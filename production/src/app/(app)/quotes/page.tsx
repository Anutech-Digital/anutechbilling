/**
 * Quotes — list matching prototype design.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useQuotes, useDeleteQuote, quoteDeleteBlockReason } from "@/lib/queries/quotes";
import { useProjectSales, useDeleteProjectSale, type ProjectSaleWithTotals } from "@/lib/queries/projects";
import { CreateProjectQuoteDialog } from "@/components/features/projects/create-project-quote-dialog";
import { useCustomer } from "@/lib/queries/customers";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { isInterStateSupply } from "@/lib/gst/place-of-supply";
import { GeminiCard } from "@/components/shared/gemini-card";
import { EmptyState } from "@/components/shared/empty-state";
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
import { rupee, daysBetween, cleanDisplayName, phoneSuffixOf } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/providers/confirm-provider";
import { isForeignCurrency, foreignEquivalent, formatForeign } from "@/lib/currency";
import type { Quote } from "@/lib/supabase/database.types";

/** A quote's total in ITS billing currency (foreign quotes show $/€…; books stay ₹). */
function quoteMoney(q: { amount: number | null; currency?: string | null; exchange_rate?: number | null }): string {
  if (!q.amount) return "—";
  if (isForeignCurrency(q.currency)) {
    return formatForeign(foreignEquivalent(q.amount, q.exchange_rate && q.exchange_rate > 0 ? q.exchange_rate : 1), q.currency ?? "");
  }
  return rupee(q.amount);
}

// Heuristic margin estimate per quote (until we have line items always populated)
function estimateMarginForQuote(q: Quote) {
  if (q.subtotal && q.total_cost) {
    const taxable = q.subtotal - Math.round(q.subtotal * (q.discount_pct / 100));
    return computeMargin(q.total_cost, taxable);
  }
  if (!q.amount || !q.seats) return computeMargin(0, 0);
  const cost = Math.round(q.amount * 0.83);
  return computeMargin(cost, q.amount);
}

type QuoteBadgeKind = "muted" | "success" | "warning" | "danger" | "info";

/**
 * ONE primary status per row (Stripe/Linear style) — folds quote.status +
 * payment_status into a single lifecycle stage, so a row never shows two
 * competing badges (the old "Accepted" + "Invoiced" overlap). The outstanding-
 * cash detail rides underneath as a muted hint via {@link dueHint}, not a badge.
 */
function unifiedStatus(q: Quote): { label: string; kind: QuoteBadgeKind } {
  if (q.payment_status === "invoiced") return { label: "Invoiced", kind: "info" };
  if (q.status === "accepted") {
    if (q.payment_status === "received") return { label: "Paid", kind: "success" };
    if (q.payment_status === "partial")  return { label: "Partially paid", kind: "warning" };
    return { label: "Accepted", kind: "success" };
  }
  switch (q.status) {
    case "draft":    return { label: "Draft", kind: "muted" };
    case "sent":     return { label: "Out for review", kind: "warning" };
    case "viewed":   return { label: "Viewed", kind: "info" };
    case "rejected": return { label: "Rejected", kind: "danger" };
    case "expired":  return { label: "Expired", kind: "danger" };
    default:         return { label: "Draft", kind: "muted" };
  }
}

/** Muted "cash still due" hint shown under the status badge (only when relevant). */
function dueHint(q: Quote): string | null {
  const due = (q.amount ?? 0) - (q.payment_amount ?? 0);
  if ((q.payment_status === "partial" || q.payment_status === "invoiced") && due > 0) {
    return `₹${due.toLocaleString("en-IN")} due`;
  }
  if (q.payment_status === "awaiting" || (q.status === "accepted" && (!q.payment_status || q.payment_status === "none"))) {
    return "Awaiting payment";
  }
  return null;
}

export default function QuotesPage() {
  const router = useRouter();
  const { data: quotes, isLoading, error, refetch } = useQuotes();
  const { data: projectQuotes } = useProjectSales();
  const deleteQuote = useDeleteQuote();
  const [tab, setTab] = React.useState("all");
  const [search, setSearch] = React.useState("");
  // Clean split — Subscription is the default (most quotes live here); Project
  // is one tab away. No mixed "All" view, no empty default.
  const [view, setView] = React.useState<"subscription" | "project">("subscription");
  const [projectQuoteOpen, setProjectQuoteOpen] = React.useState(false);
  const [editProject, setEditProject] = React.useState<ProjectSaleWithTotals | null>(null);
  const deleteProject = useDeleteProjectSale();
  const [previewing, setPreviewing] = React.useState<Quote | null>(null);
  const [kpiOpen, setKpiOpen] = React.useState(true);
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

  // Counts per status — adds an "invoiced" bucket on top of the quote.status
  // enum, derived from payment_status. Truly-done deals (accepted + paid +
  // GST invoice issued) get their own tab; the Accepted tab then surfaces
  // only the still-in-flight ones (accepted but money flow incomplete).
  const counts = React.useMemo(() => {
    const map: Record<string, number> = { all: quotes?.length ?? 0, invoiced: 0 };
    for (const q of quotes ?? []) {
      if (q.payment_status === "invoiced") {
        map.invoiced += 1;
        // also count under the underlying status (usually 'accepted') for
        // tracking, but the Accepted tab excludes invoiced ones below
        map[q.status] = (map[q.status] ?? 0) + 1;
      } else {
        map[q.status] = (map[q.status] ?? 0) + 1;
      }
    }
    return map;
  }, [quotes]);

  // Accepted-but-not-yet-invoiced count for the tab badge
  const acceptedActive = (counts.accepted ?? 0) - (counts.invoiced ?? 0);

  // Awaiting payment = money expected but not yet fully received. Includes an
  // INVOICED quote that still has a balance due — else real outstanding cash
  // (invoiced-but-part-paid) would hide from the "chase the cash" worklist.
  const isAwaitingCash = (q: Quote) =>
    q.payment_status === "awaiting" ||
    q.payment_status === "partial" ||
    (q.payment_status === "invoiced" && (q.amount ?? 0) - (q.payment_amount ?? 0) > 0);
  const awaitingPayment = (quotes ?? []).filter(isAwaitingCash).length;

  const tabs: TabBarItem[] = [
    { id: "all",      label: "All",      count: counts.all ?? 0 },
    { id: "draft",    label: "Draft",    count: counts.draft ?? 0, dot: "slate" },
    { id: "sent",     label: "Sent",     count: counts.sent ?? 0, dot: "amber" },
    { id: "viewed",   label: "Viewed",   count: counts.viewed ?? 0, dot: "indigo" },
    { id: "accepted", label: "Accepted", count: acceptedActive,        dot: "emerald" },
    { id: "awaiting", label: "Awaiting payment", count: awaitingPayment, dot: "amber" },
    { id: "invoiced", label: "Invoiced", count: counts.invoiced ?? 0,  dot: "emerald" },
    { id: "expired",  label: "Expired",  count: (counts.expired ?? 0) + (counts.rejected ?? 0), dot: "rose" },
  ];

  // Filter
  const filtered = (quotes ?? []).filter((q) => {
    if (tab === "expired") {
      if (q.status !== "expired" && q.status !== "rejected") return false;
    } else if (tab === "awaiting") {
      // Awaiting-payment bucket: money expected but not fully received.
      if (!isAwaitingCash(q)) return false;
    } else if (tab === "invoiced") {
      // Invoiced bucket is defined by payment_status, not quote.status
      if (q.payment_status !== "invoiced") return false;
    } else if (tab === "accepted") {
      // Accepted tab excludes those that have already graduated to invoiced
      if (q.status !== "accepted" || q.payment_status === "invoiced") return false;
    } else if (tab !== "all" && q.status !== tab) return false;
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return (
      q.id.toLowerCase().includes(s) ||
      q.customer_name.toLowerCase().includes(s) ||
      (q.plan?.toLowerCase().includes(s) ?? false)
    );
  });

  // KPIs
  const totalValue = (quotes ?? []).reduce((s, q) => s + (q.amount ?? 0), 0);
  const acceptedValue = (quotes ?? [])
    .filter((q) => q.status === "accepted")
    .reduce((s, q) => s + (q.amount ?? 0), 0);
  const sentValue = (quotes ?? [])
    .filter((q) => q.status === "sent" || q.status === "viewed")
    .reduce((s, q) => s + (q.amount ?? 0), 0);
  const pipelineMargin = (quotes ?? [])
    .filter((q) => q.status === "sent" || q.status === "viewed")
    .reduce((s, q) => s + estimateMarginForQuote(q).margin, 0);
  const acceptedCount = counts.accepted ?? 0;
  const sentishCount = (counts.sent ?? 0) + (counts.viewed ?? 0);
  const expiringCount = sentishCount;
  const winRate = (quotes ?? []).length > 0
    ? Math.round((acceptedCount / Math.max(1, (quotes?.length ?? 1) - (counts.draft ?? 0))) * 100)
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
              New Quote
            </Button>
          ) : (
            <Button asChild variant="primary" icon="plus">
              <Link href={"/quotes/new" as any}>New Quote</Link>
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
                      <Link href={`/projects/${p.id}` as never} className="text-[11px] text-ink-2 hover:text-amber-ink hover:underline block truncate">{p.title}</Link>
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
                        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => window.open(`/project-quote/${p.id}`, "_blank", "noopener")}>
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
                      {p.receivable > 0 && <span className="block text-[10px] text-rose">{rupee(p.receivable)} due</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            <div className="hidden md:block overflow-auto max-h-[calc(100vh-15rem)]">
              <table className="w-full text-sm min-w-[620px]">
                <thead className="sticky top-0 z-10 bg-paper-2 border-b border-hairline text-[10px] uppercase tracking-wider text-ink-3">
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
                            <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => window.open(`/project-quote/${p.id}`, "_blank", "noopener")}>
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
          <EmptyState icon="package" title="No project quotations yet"
            body="One-time / custom-software project quotes show here. Create one from Project Sales → New quotation."
            action={<Button variant="primary" icon="file" onClick={() => router.push("/projects" as never)}>Project Sales</Button>} />
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
                      onClick={() => setTab("all")}
                      className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left hover:border-amber/60 transition-all cursor-pointer"
                    >
                      <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Pipeline</p>
                      <p className="font-serif text-lg font-bold text-amber-ink tabular-nums mt-0.5">{rupee(totalValue, { compact: true })}</p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setTab("sent")}
                      className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left hover:border-amber/60 transition-all cursor-pointer"
                    >
                      <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Out for review</p>
                      <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{rupee(sentValue, { compact: true })}</p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setTab("accepted")}
                      className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left hover:border-emerald/60 transition-all cursor-pointer"
                    >
                      <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Accepted</p>
                      <p className="font-serif text-lg font-bold text-emerald tabular-nums mt-0.5">{rupee(acceptedValue, { compact: true })}</p>
                    </button>
                    <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                      <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Pipeline Margin</p>
                      <p className="font-serif text-lg font-bold text-emerald tabular-nums mt-0.5">{rupee(pipelineMargin, { compact: true })}</p>
                    </div>
                    <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                      <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Win Rate</p>
                      <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{winRate}%</p>
                    </div>
                    <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                      <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Total Quotes</p>
                      <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{quotes.length}</p>
                    </div>
                  </div>

                  {/* Quote Intelligence */}
                  {expiringCount > 0 && (
                    <GeminiCard
                      title="Quote intelligence"
                      actions={
                        <Button
                          size="sm"
                          variant="primary"
                          icon="mail"
                          onClick={() => {
                            toast.success(`Nudge sent for ${expiringCount} expiring quotes`);
                          }}
                        >
                          Nudge expiring quotes
                        </Button>
                      }
                      compact
                    >
                      <b>{expiringCount} quote{expiringCount === 1 ? "" : "s"} out for review.</b> Expiring within 7 days are highest priority — send a nudge to those customers.
                    </GeminiCard>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Sticky Horizontal TabBar + Date Range + Search */}
          {!isLoading && quotes && quotes.length > 0 && (
            <div className="sticky top-[56px] z-20 bg-paper/95 backdrop-blur-md py-3 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 mb-4 border-b border-hairline transition-all space-y-3">
              <TabBar className="overflow-y-hidden" value={tab} onChange={setTab} items={tabs} />
              <div className="flex justify-between items-center gap-3 flex-wrap">
                <div className="text-xs text-ink-3">
                  Showing {filtered.length} of {counts.all ?? 0} quote{counts.all === 1 ? "" : "s"}
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <div className="w-full sm:w-64">
                    <Input
                      prefix={<Icon name="search" size={14} />}
                      placeholder="Quote ID, customer, product…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
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
      {!isLoading && !error && quotes && quotes.length === 0 && (
        <EmptyState
          icon="file"
          title="No quotes yet"
          body="Quotes will appear here once you create your first quote for a customer."
          action={
            <Button asChild variant="primary" icon="plus">
              <Link href={"/quotes/new" as any}>Create your first quote</Link>
            </Button>
          }
        />
      )}

      {/* Filtered empty */}
      {!isLoading && !error && quotes && quotes.length > 0 && filtered.length === 0 && (
        <div className="mt-6">
          <EmptyState
            icon="search"
            title="No quotes match"
            body={search ? `No results for "${search}".` : `No quotes in "${tab}" status.`}
            action={<Button icon="x" onClick={() => { setTab("all"); setSearch(""); }}>Clear filters</Button>}
            compact
          />
        </div>
      )}

      {/* Adaptive card list — phones, tablets, and medium viewports (< 1280px) */}
      {!isLoading && !error && filtered.length > 0 && (
        <ul className="xl:hidden space-y-2 mb-3">
          {filtered.map((q) => {
            const uStatus = unifiedStatus(q);
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
                          <Badge kind="warning" className="font-sans text-[10px]">
                            Extension · {Math.round((q.extension_months ?? 12) / 12)}yr
                          </Badge>
                        ) : q.is_renewal ? (
                          <Badge kind="info" className="font-sans text-[10px]">Renewal</Badge>
                        ) : q.is_add_seats ? (
                          <Badge kind="info" className="font-sans text-[10px]">Prorata</Badge>
                        ) : q.is_one_off ? (
                          <Badge kind="muted" className="font-sans text-[10px]">Direct invoice</Badge>
                        ) : null}
                      </div>
                      <p className="text-sm font-semibold text-ink mt-1 truncate">
                        {cleanDisplayName(q.customer_name)}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-serif text-base font-bold tabular-nums text-ink">
                        {quoteMoney(q)}
                      </p>
                      <p className="text-[11px] text-ink-3 tabular-nums">
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
                      <Badge kind={uStatus.kind} size="sm" dot>{uStatus.label}</Badge>
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
          <li className="pt-2 text-center text-[11px] text-ink-3">
            Showing {filtered.length} of {counts.all ?? 0} · Total {rupee(filtered.reduce((s, q) => s + (q.amount ?? 0), 0), { compact: true })}
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
                  <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Quote</th>
                  <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Customer</th>
                  <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Plan</th>
                  <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Amount</th>
                  <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider" title="Annual margin">Margin</th>
                  <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                  <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Validity</th>
                  <th className="px-2 py-2.5 text-right"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((q) => {
                  const margin = estimateMarginForQuote(q);
                  const uStatus = unifiedStatus(q);
                  const dl = q.expires_date ? daysBetween(new Date(), q.expires_date) : null;
                  const expiringSoon = dl !== null && dl >= 0 && dl <= 7;
                  return (
                    <tr
                      key={q.id}
                      onClick={() => router.push(`/quotes/${q.id}` as any)}
                      className="group border-b border-hairline last:border-0 hover:bg-paper-2/50 cursor-pointer transition-colors"
                    >
                      {/* Compact ID — the tail number as a chip; full ID on hover. */}
                      <td className="px-3 py-2.5 align-top" title={q.id}>
                        <div className="flex items-center gap-1.5">
                          <span className="inline-flex items-center rounded-md bg-paper-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink">
                            #{q.id.split("-").pop()}
                          </span>
                          {q.is_extension ? (
                            <Badge kind="warning" className="font-sans text-[10px]">
                              Ext · {Math.round((q.extension_months ?? 12) / 12)}yr
                            </Badge>
                          ) : q.is_renewal ? (
                            <Badge kind="info" className="font-sans text-[10px]">Renewal</Badge>
                          ) : q.is_add_seats ? (
                            <Badge kind="info" className="font-sans text-[10px]">Prorata</Badge>
                          ) : q.is_one_off ? (
                            <Badge kind="muted" className="font-sans text-[10px]">Direct invoice</Badge>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <div className="font-medium text-ink leading-snug break-words max-w-[220px]" title={cleanDisplayName(q.customer_name)}>{cleanDisplayName(q.customer_name)}</div>
                        {phoneSuffixOf(q.customer_name) && (
                          <div className="text-[10px] text-ink-3 tabular-nums mt-0.5">{phoneSuffixOf(q.customer_name)}</div>
                        )}
                      </td>
                      {/* Plan — wraps to a second line rather than truncating with "…". */}
                      <td className="px-3 py-2.5 text-sm text-ink-2 align-top">
                        <div className="leading-snug break-words max-w-[240px]">{q.plan ?? "—"}</div>
                        {q.seats != null && (
                          <div className="text-[10px] text-ink-3 mt-0.5"><span className="font-semibold text-ink-2 tabular-nums">{q.seats}</span> seats</div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right align-top">
                        <div className="flex flex-col items-end gap-0.5">
                          <span className="tabular-nums text-sm font-medium text-ink">
                            {quoteMoney(q)}
                          </span>
                          {/* Foreign quote: show the ₹ base underneath so the amount
                              reconciles with the (all-INR) pipeline totals. */}
                          {isForeignCurrency(q.currency) && q.amount ? (
                            <span className="text-[10px] text-ink-3 tabular-nums">≈ {rupee(q.amount)}</span>
                          ) : null}
                        </div>
                      </td>
                      {/* Margin — colour-coded badge: green = healthy, amber =
                          thin, rose = risky. ₹ amount below for reference. */}
                      <td className="px-3 py-2.5 text-right align-top">
                        {q.amount ? (
                          <div className="flex flex-col items-end gap-0.5">
                            <Badge
                              kind={margin.marginPct >= 18 ? "success" : margin.marginPct >= 14 ? "warning" : "danger"}
                              size="sm"
                            >
                              {margin.marginPct}%
                            </Badge>
                            <span className="text-[10px] text-ink-3 tabular-nums">{rupee(margin.margin)}</span>
                          </div>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <div className="flex flex-col items-start gap-0.5">
                          <Badge kind={uStatus.kind} dot>{uStatus.label}</Badge>
                          {dueHint(q) && (
                            <span className={cn("text-[10px] font-medium tabular-nums", dueHint(q) === "Awaiting payment" ? "text-amber-ink" : "text-rose")}>
                              {dueHint(q)}
                            </span>
                          )}
                        </div>
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
                                  const msg = encodeURIComponent(`Namaste ${q.customer_name},\n\nQuick follow up regarding Quote #${q.id} (${q.plan || "Google Workspace"}) for ₹${(q.amount ?? 0).toLocaleString("en-IN")}.\n\nPlease let us know if you need any clarification.\n\nDhanyavaad`);
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
                              // actual invoice (auto-opens that dialog via
                              // ?open=INV-XX deep link on /invoices)
                              return (
                                <Button asChild size="sm" icon="receipt">
                                  <Link
                                    href={
                                      q.invoice_id
                                        ? (`/invoices?open=${q.invoice_id}` as any)
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
                                  const msg = encodeURIComponent(`Namaste ${q.customer_name},\n\nQuick follow up regarding Quote #${q.id} (${q.plan || "Google Workspace"}) for ₹${(q.amount ?? 0).toLocaleString("en-IN")}.\n\nPlease let us know if you need any clarification.\n\nDhanyavaad`);
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
                <span>End of list · Showing {filtered.length} of {counts.all ?? 0} quotes</span>
              </div>
              <div className="flex items-center gap-3">
                <span>
                  Pipeline value:{" "}
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
  const interState = isInterStateSupply(customer?.state_code, currentUser?.tenantStateCode);

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
      validityDays={validity}
      notes={quote.notes ?? ""}
      isProspect={!!quote.lead_id}
    />
  );
}
