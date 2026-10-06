/**
 * Invoices — list matching prototype design.
 *
 * Layout:
 *   - Header: eyebrow "Revenue" + title + subtitle
 *   - Actions: Export GSTR-1 + Push to Zoho + New invoice
 *   - 5 KPIs: Outstanding / Overdue / Paid this month / Margin MTD / Avg collection
 *   - Status tabs (All/Paid/Partial/Pending/Overdue/Draft/Void) with counts — they add up to All
 *   - Table: checkbox / Invoice # / Customer / Date / Due / Amount / Status / Action
 *   - Auto-Sync Status card at bottom
 */
"use client";

import * as React from "react";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { INVOICE_TABS } from "@/lib/navigation/drilldown";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useInvoices, useQuotesAwaitingInvoice, useGenerateInvoice, useDeleteProjectInvoice, useDeleteSubscriptionInvoice, useDocumentSeries } from "@/lib/queries/invoices";
import { useQuoteByInvoiceId } from "@/lib/queries/quotes";
import { usePaymentsByQuote, totalReceived } from "@/lib/queries/payments";
import { RecordPaymentDialog } from "@/components/features/quotes/record-payment-dialog";
import { useProjectPaymentsByInvoice, useProjectInvoiceIds, useMilestoneByInvoice } from "@/lib/queries/projects";
import { RecordProjectPaymentDialog } from "@/components/features/projects/record-project-payment-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { IssueCreditNoteDialog } from "@/components/features/invoices/issue-credit-note-dialog";
import { useInvoiceNoteTotals } from "@/lib/queries/invoice-note-totals";
import { netAfterNotes, type NoteTotals } from "@/lib/invoices/note-totals";
/* R-060. `status = 'overdue'` has no writer anywhere in the product, so the Overdue tab
   and its KPI were permanently empty while invoices ran months late. Derived from
   due_date instead — see the header of lib/invoices/overdue.ts for why not a cron. */
import { invoiceBucket } from "@/lib/invoices/overdue";
import { invoiceStatusBadge } from "./invoice-status";
import {
  invoiceChip, invoiceChipCounts, invoiceKpis, invoiceInFocus, INVOICE_FOCI, INVOICE_FOCUS_LABEL, type InvoiceFocus,
} from "@/lib/invoices/kpis";
import { FocusBanner } from "@/components/shared/focus-banner";
import { Icon } from "@/components/ui/icon";
import { toast } from "sonner";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { FAB } from "@/components/ui/fab";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DataTable, type DataTableColumn, type RowCtx } from "@/components/ui/data-table";
import { BulkActionBar, BulkBarButton } from "@/components/ui/bulk-action-bar";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { ConfirmIssueDialog } from "@/components/features/invoices/confirm-issue-dialog";
import { issueConsequences, bulkIssueConsequences } from "@/lib/invoices/issue-consequences";
import { rupee, formatDate, daysBetween, cleanDisplayName } from "@/lib/utils";
import { getInvoiceWhatsAppUrl } from "@/lib/whatsapp";
import { useWhatsAppSender } from "@/lib/hooks/useWhatsAppSender";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canOpenQuotes } from "@/lib/quotes/access";
import type { Invoice } from "@/lib/supabase/database.types";
import { InvoiceNotesList, InvoicePaymentsAccordion } from "./invoice-detail";
import { invoiceHref, legacyOpenRedirect } from "./invoice-href";

/* R-085: on the shared DataTable. Widths are fluid percentages (with the 3% checkbox
   column they sum to 100) so the table always fits — no horizontal scroll. Clicking a
   header with a sortValue sorts by it; status sorts by the same bucket the tabs use. */
const BUCKET_ORDER: Record<string, number> = { overdue: 0, pending: 1, draft: 2, paid: 3, void: 4 };
const INVOICE_COLUMNS: DataTableColumn<Invoice>[] = [
  { id: "invoice",  header: "Invoice #", width: "15%", sortValue: (i) => i.id },
  { id: "customer", header: "Customer",  width: "19%", sortValue: (i) => cleanDisplayName(i.customer_name) },
  { id: "date",     header: "Date",      width: "10%", sortValue: (i) => i.invoice_date },
  { id: "due",      header: "Due date",  width: "10%", sortValue: (i) => i.due_date },
  { id: "amount",   header: "Amount",    width: "13%", align: "right", sortValue: (i) => i.amount },
  { id: "status",   header: "Status",    width: "11%", sortValue: (i) => BUCKET_ORDER[invoiceBucket(i)] ?? 9 },
  { id: "action",   header: "Action",    width: "19%", align: "right" },
];

function InvoicesPageInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  /* R-237: billing (whose home this page is) cannot open /quotes — no quote links for it. */
  const { data: me } = useCurrentUser();
  const canQuotes    = canOpenQuotes(me?.role);
  /** Who the outbound WhatsApp reminders are from — see lib/hooks/useWhatsAppSender. */
  const waSender     = useWhatsAppSender();

  const { data: invoices, isLoading, error, refetch } = useInvoices();
  const { data: projectInvoiceIds } = useProjectInvoiceIds();
  // R-009: credit / debit note totals for every invoice — one query for the whole list.
  const { data: noteTotals } = useInvoiceNoteTotals();
  const { data: pending } = useQuotesAwaitingInvoice();
  const generateInvoice = useGenerateInvoice();
  // Combined by default — Subscription & Project invoices live in one list
  // (each row carries a Type badge). The tabs below are just an optional filter.
  const [view, setView] = React.useState<"all" | "subscription" | "project">("all");
  const [tab, setTab]           = useUrlChoice<string>("tab", INVOICE_TABS, "all"); // R-118
  /* R-118: a money tile's exact set (lib/invoices/kpis.ts#invoiceInFocus) — "" = none. */
  const [focus, setFocus]       = useUrlChoice<InvoiceFocus>("focus", INVOICE_FOCI, "");
  /* ?q= pre-fills the search (AI Entry → "Find the invoice" for a payment someone sent). */
  const [search, setSearch]     = React.useState<string>(() => searchParams.get("q") ?? "");
  const [dateRange, setDateRange] = React.useState<"all" | "this_month" | "last_30" | "this_quarter">("all");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [pendingOpen, setPendingOpen] = React.useState<boolean>(false);

  const isProjectInv = React.useCallback((id: string) => projectInvoiceIds?.has(id) ?? false, [projectInvoiceIds]);

  // Workspace keyword filter removed 2026-08-13 — RLS already scopes to tenant,
  // so this only ever hid the tenant's own invoices.
  const workspaceInvoices = React.useMemo(() => invoices ?? [], [invoices]);

  const viewInvoices = React.useMemo(
    () => workspaceInvoices.filter((inv) => view === "all" || (view === "project" ? isProjectInv(inv.id) : !isProjectInv(inv.id))),
    [workspaceInvoices, view, isProjectInv]
  );

  const dateFilteredInvoices = React.useMemo(() => {
    if (dateRange === "all") return viewInvoices;
    const now = new Date();
    return viewInvoices.filter((inv) => {
      if (!inv.created_at) return true;
      const invDate = new Date(inv.created_at);
      if (dateRange === "this_month") {
        return invDate.getMonth() === now.getMonth() && invDate.getFullYear() === now.getFullYear();
      }
      if (dateRange === "last_30") {
        return (now.getTime() - invDate.getTime()) <= 30 * 86400000;
      }
      if (dateRange === "this_quarter") {
        const currentQuarter = Math.floor(now.getMonth() / 3);
        const invQuarter = Math.floor(invDate.getMonth() / 3);
        return currentQuarter === invQuarter && invDate.getFullYear() === now.getFullYear();
      }
      return true;
    });
  }, [viewInvoices, dateRange]);

  const subCount  = React.useMemo(() => (invoices ?? []).filter((i) => !isProjectInv(i.id)).length, [invoices, isProjectInv]);
  const projCount = React.useMemo(() => (invoices ?? []).filter((i) =>  isProjectInv(i.id)).length, [invoices, isProjectInv]);
  const [pendingSelected, setPendingSelected] = React.useState<Set<string>>(new Set());

  /* Issuing an invoice consumes a GST serial and creates a document that cannot be
     edited (migration 20260823090000). Both used to happen on a bare click — the
     single "Generate" button and a bulk loop over every selected quote. These hold the
     quote(s) awaiting confirmation; the dialog states what the click will do. */
  const [confirmSingle, setConfirmSingle] = React.useState<string | null>(null);
  const [confirmBulk, setConfirmBulk] = React.useState<boolean>(false);
  const { data: series } = useDocumentSeries();
  const invoiceSeries = series?.invoice ?? null;

  /** A pending quote in the shape `issueConsequences` needs. */
  const toIssuable = React.useCallback(
    (q: {
      id: string; customer_name?: string | null; amount?: number | null;
      payment_terms_days?: number | null;
      /* Decorated by useQuotesAwaitingInvoice. Absent (undefined) means "not asked", and
         issue-consequences then says nothing rather than warning about a GSTIN nobody
         looked for. */
      customer_gstin?: string | null;
    }) => ({
      id: q.id,
      customerName: q.customer_name ?? null,
      amount: q.amount ?? null,
      paymentTermsDays: q.payment_terms_days ?? null,
      customerGstin: q.customer_gstin ?? null,
    }),
    [],
  );

  const singleQuote = React.useMemo(
    () => (confirmSingle ? pending?.find((q) => q.id === confirmSingle) ?? null : null),
    [confirmSingle, pending],
  );
  const singleConsequences = React.useMemo(
    () => (singleQuote ? issueConsequences({ quote: toIssuable(singleQuote), series: invoiceSeries }) : null),
    [singleQuote, invoiceSeries, toIssuable],
  );
  const bulkConsequences = React.useMemo(() => {
    if (!confirmBulk || !pending) return null;
    const selected = pending.filter((q) => pendingSelected.has(q.id));
    if (selected.length === 0) return null;
    return bulkIssueConsequences({ quotes: selected.map(toIssuable), series: invoiceSeries });
  }, [confirmBulk, pending, pendingSelected, invoiceSeries, toIssuable]);

  /* Lifted out of the pending-card IIFE so the confirmation can call it. Unchanged
     otherwise — including that it issues one at a time and counts failures, which is
     exactly why the dialog warns that a partial failure leaves numbers already used. */
  const issueSelected = React.useCallback(async () => {
    if (pendingSelected.size === 0) {
      toast.error("Select at least one quote");
      return;
    }
    setGenerating(true);
    let ok = 0, fail = 0;
    for (const id of pendingSelected) {
      try {
        await generateInvoice.mutateAsync(id);
        ok++;
      } catch {
        fail++;
      }
    }
    setGenerating(false);
    setPendingSelected(new Set());
    setConfirmBulk(false);
    if (ok > 0) toast.success(`Generated ${ok} invoice${ok === 1 ? "" : "s"}` + (fail ? ` · ${fail} failed` : ""));
    if (fail > 0 && ok === 0) toast.error(`${fail} invoice${fail === 1 ? "" : "s"} failed`);
  }, [pendingSelected, generateInvoice]);
  const [generating, setGenerating] = React.useState(false);


  // Counts — split pending into bare-pending vs partial (advances applied).
  // "Partial" is derived (not a DB enum value): status='pending' AND
  // adjusted_advances non-empty. Useful for "how many invoices have SOME
  // money in, balance still owed" — a different operational signal from
  // "absolutely nothing received yet".
  /* R-060: bucket, not raw status (an unpaid invoice past due is Overdue). R-063: one
     invoice, one chip — invoiceChip — so the chips add up to All, Void included. */
  const counts = React.useMemo(() => invoiceChipCounts(viewInvoices), [viewInvoices]);

  const tabs: TabBarItem[] = [
    { id: "all",     label: "All",     count: counts.all ?? 0 },
    { id: "paid",    label: "Paid",    count: counts.paid ?? 0, dot: "emerald" },
    { id: "partial", label: "Partial", count: counts.partial ?? 0, dot: "amber" },
    { id: "pending", label: "Pending", count: counts.pending ?? 0, dot: "amber" },
    { id: "overdue", label: "Overdue", count: counts.overdue ?? 0, dot: "rose" },
    { id: "draft",   label: "Draft",   count: counts.draft ?? 0 },
    /* R-063: void invoices were in All but in no chip, so the chips never added up. */
    { id: "void",    label: "Void",    count: counts.void ?? 0 },
  ];

  // Filter — status tab (Partial/Pending both derive from status='pending',
  // split by whether advances were applied) + free-text search on invoice #,
  // customer, or status.
  const rows = dateFilteredInvoices.filter((i) => {
    // Tile focus (R-118) — the same predicate the tile summed
    if (focus && !invoiceInFocus(i, focus)) return false;
    // Status tab
    if (tab !== "all" && invoiceChip(i) !== tab) return false;   // same function the counts use
    // Search
    if (search.trim()) {
      const s = search.toLowerCase();
      const hit =
        i.id.toLowerCase().includes(s) ||
        (i.customer_name?.toLowerCase().includes(s) ?? false) ||
        // The bucket, so typing "overdue" finds the invoices the tab shows (R-060).
        invoiceBucket(i).toLowerCase().includes(s);
      if (!hit) return false;
    }
    return true;
  });

  /* KPIs (R-062): lib/invoices/kpis.ts. Outstanding = what is still owed on pending /
     overdue invoices (net of advances and receipts) — void and draft owe nothing.
     "Paid this month" = invoices fully paid in this IST month, by paid date; the
     /payments page's "Collected MTD" is money RECEIVED (incl. part payments and TDS). */
  const { outstanding, overdueTotal, paidThisMonth: collectedMTD, paidThisMonthCount, outstandingCount } = invoiceKpis(invoices ?? []);
  /* A tile opens its exact set over EVERY invoice, as the tile counted it: no tab, date or
     type narrowing left over from before the click. */
  const focusOn = (f: InvoiceFocus) => { setView("all"); setDateRange("all"); setTab("all"); setFocus(f); };
  const tabOn = (t: string) => { setFocus(""); setTab(t); };
  const overdueCount = counts.overdue ?? 0;
  const marginMTD = Math.round(collectedMTD * 0.17); // 17% avg estimate
  const paidInvoices = (invoices ?? []).filter((i) => i.status === "paid" && i.paid_date);
  const avgCollection = paidInvoices.length > 0
    ? Math.round(paidInvoices.reduce((s, i) => s + daysBetween(i.invoice_date, i.paid_date!), 0) / paidInvoices.length)
    : 0;

  /* Saved views (R-085): the filters this page owns, as plain JSON. */
  const viewState = { view, tab, dateRange, search };
  const applyView = (v: Record<string, unknown>) => {
    if (v.view === "all" || v.view === "subscription" || v.view === "project") setView(v.view);
    if (typeof v.tab === "string") setTab(v.tab);
    if (v.dateRange === "all" || v.dateRange === "this_month" || v.dateRange === "last_30" || v.dateRange === "this_quarter") setDateRange(v.dateRange);
    setSearch(typeof v.search === "string" ? v.search : "");
    setSelected(new Set());
  };

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Revenue</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Invoices</h1>
          <p className="text-sm text-ink-3 mt-1">All GST invoices · sorted by most recent</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button icon="upload" onClick={() => router.push("/accounting/gst" as any)}>Export GSTR-1</Button>
          {canQuotes && (
            <Button variant="primary" icon="plus" onClick={() => router.push("/quotes" as any)}>
              New invoice
            </Button>
          )}
        </div>
      </div>

      {/* Subscription vs Project invoices toggle */}
      <div className="mb-4">
        <TabBar
          className="overflow-y-hidden"
          value={view}
          onChange={(v) => setView(v as "all" | "subscription" | "project")}
          items={[
            { id: "all",          label: "All invoices", count: (invoices?.length ?? 0) || undefined },
            { id: "subscription", label: "Subscription", count: subCount || undefined },
            { id: "project",      label: "Project",      count: projCount || undefined },
          ]}
        />
      </div>

      {/* ── Pending generation — partial OR fully-paid quotes awaiting GST invoice ──
           Legal context: CGST Section 13(2) + Rule 47 — supply trigger for services
           = earlier of invoice OR payment. So aging clock starts from FIRST advance
           receipt, not last payment. 30-day deadline drives bucket thresholds:
             0-15d   = fresh
             16-30d  = approaching deadline (issue soon)
             31-60d  = OVERDUE — legal violation, audit risk
             60+d    = critical — penalty likely
      */}
      {view !== "project" && pending && pending.length > 0 && (() => {
        const now = Date.now();
        const buckets = {
          fresh:   pending.filter((q: any) => { const a = q.first_advance_at ?? q.payment_received_at; return a && (now - new Date(a).getTime()) <= 15 * 86400000; }),
          warn:    pending.filter((q: any) => { const a = q.first_advance_at ?? q.payment_received_at; const d = a ? (now - new Date(a).getTime()) / 86400000 : 0; return d > 15 && d <= 30; }),
          urgent:  pending.filter((q: any) => { const a = q.first_advance_at ?? q.payment_received_at; const d = a ? (now - new Date(a).getTime()) / 86400000 : 0; return d > 30 && d <= 60; }),
          overdue: pending.filter((q: any) => { const a = q.first_advance_at ?? q.payment_received_at; return a && (now - new Date(a).getTime()) > 60 * 86400000; }),
        };
        const sumAmt = (arr: any[]) => arr.reduce((s, q) => s + Math.max(0, (q.amount ?? 0) - (q.paid_amount ?? 0)), 0);
        const totalAmt = sumAmt(pending);

        const togglePending = (id: string) => {
          const next = new Set(pendingSelected);
          if (next.has(id)) next.delete(id); else next.add(id);
          setPendingSelected(next);
        };
        const toggleAllPending = () => {
          if (pendingSelected.size === pending.length) setPendingSelected(new Set());
          else setPendingSelected(new Set(pending.map((q) => q.id)));
        };

        return (
          <Card className="mb-4 border-amber/40 bg-amber-soft/20 p-3 overflow-hidden transition-all">
            <div
              role="button"
              tabIndex={0}
              onClick={() => setPendingOpen((o) => !o)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPendingOpen((o) => !o); } }}
              className="flex items-center justify-between gap-3 cursor-pointer select-none"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <Icon name="receipt" size={16} className="text-amber-ink shrink-0" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="font-semibold text-xs text-ink truncate">Pending GST invoice generation</h2>
                    <Badge kind="warning" size="sm" dot>
                      {pending.length} quote{pending.length === 1 ? "" : "s"} ({rupee(totalAmt)})
                    </Badge>
                  </div>
                  <p className="text-2xs text-ink-3 truncate hidden sm:block">
                    Invoice mandatory within 30 days of first advance (CGST §13, Rule 47)
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {pendingSelected.size > 0 && (
                  <Button
                    size="sm"
                    variant="primary"
                    icon="receipt"
                    loading={generating}
                    onClick={(e) => {
                      e.stopPropagation();
                      /* The dangerous one: this used to loop generateInvoice over every
                         selected quote with no confirmation, so one click could consume a
                         run of serial numbers. */
                      setConfirmBulk(true);
                    }}
                  >
                    Generate {pendingSelected.size}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-amber-ink gap-1 text-xs px-2 h-7"
                >
                  <span>{pendingOpen ? "Collapse" : "Expand"}</span>
                  <Icon name={pendingOpen ? "chevron_up" : "chevron_down"} size={14} />
                </Button>
              </div>
            </div>

            {pendingOpen && (
              <div className="mt-3 pt-3 border-t border-hairline/60">
                {/* Aging buckets — 30-day GST clock (Rule 47) */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
                  <BucketTile label="0–15 days · fresh"      count={buckets.fresh.length}   amount={sumAmt(buckets.fresh)}   tone="emerald" />
                  <BucketTile label="16–30 days · issue soon" count={buckets.warn.length}    amount={sumAmt(buckets.warn)}    tone="amber" />
                  <BucketTile label="31–60 days · overdue"   count={buckets.urgent.length}  amount={sumAmt(buckets.urgent)}  tone="rose-soft" />
                  <BucketTile label="60+ days · audit risk"  count={buckets.overdue.length} amount={sumAmt(buckets.overdue)} tone="rose" />
                </div>

                {/* Mobile card list */}
                <ul className="md:hidden space-y-2">
                  {pending.map((q: any) => {
                    const anchor = q.first_advance_at ?? q.payment_received_at;
                    const days = anchor ? Math.floor((now - new Date(anchor).getTime()) / 86400000) : 0;
                    const ageKind: "emerald" | "amber" | "rose" = days <= 15 ? "emerald" : days <= 30 ? "amber" : "rose";
                    const isPartial = q.payment_status === "partial";
                    return (
                      <li key={q.id} className="rounded-lg border border-hairline bg-paper p-3">
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div className="min-w-0 flex-1">
                            {canQuotes ? (
                              <Link href={`/quotes/${q.id}` as any} className="font-mono text-xs font-semibold text-ink hover:text-amber-ink hover:underline block truncate">{q.id}</Link>
                            ) : (
                              <span className="font-mono text-xs font-semibold text-ink block truncate">{q.id}</span>
                            )}
                            <p className="text-sm text-ink truncate mt-0.5">{q.customer_name}</p>
                            <p className="text-2xs text-ink-3 mt-0.5">First advance {anchor ? formatDate(anchor) : "—"}</p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="font-serif text-base tabular-nums text-ink">{rupee(q.amount ?? 0)}</p>
                            {isPartial && q.payment_amount != null && (
                              <p className="text-3xs text-amber-ink mt-0.5">{rupee(q.payment_amount)} received</p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center justify-between gap-2 pt-2 border-t border-hairline/60">
                          <div className="flex items-center gap-1.5">
                            {isPartial ? <Badge kind="info" size="sm" dot>Partial</Badge> : <Badge kind="success" size="sm" dot>Fully paid</Badge>}
                            <Badge kind={ageKind === "rose" ? "danger" : ageKind === "amber" ? "warning" : "success"} size="sm" dot>{days}d ago</Badge>
                          </div>
                          {/* Opens the confirmation rather than issuing. The number this
                              will take, the amount, and the fact that it cannot be edited
                              afterwards are all things the operator could not see before. */}
                          <Button size="sm" variant="primary" icon="receipt" loading={generateInvoice.isPending} onClick={() => setConfirmSingle(q.id)}>
                            Generate
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>

                {/* Table of pending quotes */}
                <div className="hidden md:block rounded-md border border-hairline bg-paper overflow-auto max-h-[calc(100vh-15rem)]">
                  <table className="w-full">
                    <thead className="sticky top-0 z-10 bg-paper-2 border-b border-hairline">
                      <tr>
                        <th className="p-2 w-10">
                          <input
                            type="checkbox"
                            checked={pendingSelected.size === pending.length && pending.length > 0}
                            onChange={toggleAllPending}
                            className="w-3.5 h-3.5 accent-amber cursor-pointer"
                            aria-label="Select all pending"
                          />
                        </th>
                        <th className="text-left p-2 text-3xs uppercase tracking-wider font-semibold text-ink-3 whitespace-nowrap">Quote</th>
                        <th className="text-left p-2 text-3xs uppercase tracking-wider font-semibold text-ink-3">Customer</th>
                        <th className="text-right p-2 text-3xs uppercase tracking-wider font-semibold text-ink-3">Amount</th>
                        <th className="text-left p-2 text-3xs uppercase tracking-wider font-semibold text-ink-3">Payment</th>
                        <th className="text-left p-2 text-3xs uppercase tracking-wider font-semibold text-ink-3">First advance</th>
                        <th className="text-left p-2 text-3xs uppercase tracking-wider font-semibold text-ink-3">Aging</th>
                        <th className="w-32"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {pending.map((q: any) => {
                        const anchor = q.first_advance_at ?? q.payment_received_at;
                        const days = anchor
                          ? Math.floor((now - new Date(anchor).getTime()) / 86400000)
                          : 0;
                        const ageKind: "emerald" | "amber" | "rose" =
                          days <= 15 ? "emerald" : days <= 30 ? "amber" : "rose";
                        const isSel = pendingSelected.has(q.id);
                        const isPartial = q.payment_status === "partial";
                        return (
                          <tr
                            key={q.id}
                            className={`border-b border-hairline last:border-0 hover:bg-paper-2/30 ${
                              isSel ? "bg-amber-soft/30" : ""
                            }`}
                          >
                            <td className="p-2">
                              <input
                                type="checkbox"
                                checked={isSel}
                                onChange={() => togglePending(q.id)}
                                className="w-3.5 h-3.5 accent-amber cursor-pointer"
                                aria-label={`Select ${q.id}`}
                              />
                            </td>
                            {/* R-177: the quote no. ("Q-DEMO-27-0001") wrapped onto four lines. */}
                            <td className="p-2 whitespace-nowrap">
                              {canQuotes ? (
                                <Link
                                  href={`/quotes/${q.id}` as any}
                                  className="font-mono text-xs font-semibold text-ink hover:text-amber-ink hover:underline"
                                >
                                  {q.id}
                                </Link>
                              ) : (
                                <span className="font-mono text-xs font-semibold text-ink">{q.id}</span>
                              )}
                            </td>
                            <td className="p-2 text-sm">{q.customer_name}</td>
                            <td className="p-2 text-right tabular-nums text-sm font-medium">
                              {rupee(q.amount ?? 0)}
                              {isPartial && q.payment_amount != null && (
                                <div className="text-3xs text-amber-ink mt-0.5">
                                  {rupee(q.payment_amount)} received
                                </div>
                              )}
                            </td>
                            <td className="p-2">
                              {isPartial ? (
                                <Badge kind="info" dot>Partial</Badge>
                              ) : (
                                <Badge kind="success" dot>Fully paid</Badge>
                              )}
                            </td>
                            <td className="p-2 text-xs text-ink-2">
                              {anchor ? formatDate(anchor) : "—"}
                            </td>
                            <td className="p-2">
                              <Badge kind={ageKind === "rose" ? "danger" : ageKind === "amber" ? "warning" : "success"} dot>
                                {days}d ago
                              </Badge>
                            </td>
                            <td className="p-2 text-right">
                              <Button
                                size="sm"
                                variant="primary"
                                icon="receipt"
                                loading={generateInvoice.isPending}
                                /* Same confirmation as the phone button and the bulk issue (R-082 jaanch,
                                   1 Oct): this one issued a GST invoice on a bare click. */
                                onClick={() => setConfirmSingle(q.id)}
                              >
                                Generate
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Card>
        );
      })()}

      {/* Interactive KPI Stat Grid */}
      {!isLoading && invoices && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 mb-5">
          <button
            type="button"
            onClick={() => focusOn("unpaid")}
            aria-pressed={focus === "unpaid"}
            className="bg-paper border border-hairline rounded-lg p-3 text-left hover:border-amber/60 transition-all cursor-pointer"
          >
            <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Outstanding</p>
            <p className="font-serif text-lg font-bold text-rose-ink tabular-nums mt-0.5">{rupee(outstanding, { compact: true })}</p>
            <p className="text-3xs text-ink-3 mt-0.5">{outstandingCount} invoice{outstandingCount === 1 ? "" : "s"} owed</p>
          </button>
          <button
            type="button"
            onClick={() => { setView("all"); setDateRange("all"); tabOn("overdue"); }}
            className="bg-paper border border-hairline rounded-lg p-3 text-left hover:border-rose/60 transition-all cursor-pointer"
          >
            <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Overdue ({overdueCount})</p>
            <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{rupee(overdueTotal, { compact: true })}</p>
          </button>
          <button
            type="button"
            onClick={() => focusOn("paid-month")}
            aria-pressed={focus === "paid-month"}
            className="bg-paper border border-hairline rounded-lg p-3 text-left hover:border-emerald/60 transition-all cursor-pointer"
          >
            <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Paid this month</p>
            <p className="font-serif text-lg font-bold text-emerald tabular-nums mt-0.5">{rupee(collectedMTD, { compact: true })}</p>
            <p className="text-3xs text-ink-3 mt-0.5">{paidThisMonthCount} invoice{paidThisMonthCount === 1 ? "" : "s"} fully paid</p>
          </button>
          <div className="bg-paper border border-hairline rounded-lg p-3 text-left">
            <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Margin MTD</p>
            <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{rupee(marginMTD, { compact: true })}</p>
          </div>
          {/* Averaged over every paid invoice — the Paid tab is that set. */}
          <button
            type="button"
            onClick={() => { setView("all"); setDateRange("all"); tabOn("paid"); }}
            className="bg-paper border border-hairline rounded-lg p-3 text-left hover:border-amber/60 transition-all cursor-pointer"
          >
            <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Avg collection</p>
            <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{avgCollection}d</p>
          </button>
        </div>
      )}

      {/* Tabs, Date Range Filter & Search */}
      {!isLoading && invoices && invoices.length > 0 && (
        <div className="mb-4">
          {focus && (
            <FocusBanner label={INVOICE_FOCUS_LABEL[focus]} count={rows.length} onClear={() => setFocus("")} />
          )}
          <TabBar className="overflow-y-hidden" value={tab} onChange={tabOn} items={tabs} />
        </div>
      )}

      {/* Floating batch operations bar.
          Moved onto the shared <BulkActionBar> (components/ui/bulk-action-bar.tsx) — this page
          and the leads table had grown two bars with the same intent and different padding,
          button styling and dismiss wording. No action's behaviour changed here except the
          WhatsApp one, which was mislabelled; see below. */}
      <BulkActionBar count={selected.size} noun="invoice" onClear={() => setSelected(new Set())}>
        <BulkBarButton
          icon="whatsapp"
          onClick={() => {
            const selectedInvoices = rows.filter((r) => selected.has(r.id));
            const first = selectedInvoices[0];
            if (!first) return;
            window.open(getInvoiceWhatsAppUrl(first, null, waSender), "_blank");
            /* ── THE BUTTON USED TO SAY "Bulk WhatsApp" AND SEND ONE ─────────
               It opened `selectedInvoices[0]` and nothing else, so selecting twelve invoices
               and clicking it messaged one customer while the label said it had done all
               twelve. Nothing in the UI contradicted that.

               Not "fixed" by looping: wa.me opens a browser tab per chat, and a loop of
               window.open past the first is swallowed by every popup blocker — which would
               turn a visible wrong into an invisible one. So the label now says what it does,
               and the toast says what was NOT done, with the count. */
            if (selectedInvoices.length > 1) {
              toast.info(
                `Opened WhatsApp for ${first.id} only`,
                { description: `WhatsApp opens one chat at a time — the other ${selectedInvoices.length - 1} are still selected.` },
              );
            }
          }}
        >
          {selected.size > 1 ? "WhatsApp first" : "WhatsApp"}
        </BulkBarButton>

        <BulkBarButton
          icon="download"
          onClick={() => {
            const selectedInvoices = rows.filter((r) => selected.has(r.id));
            const csv = "Invoice ID,Customer,Amount,Status,Date\n" + selectedInvoices.map(i => `${i.id},"${i.customer_name}",${i.amount},${i.status},${i.created_at || ""}`).join("\n");
            const blob = new Blob([csv], { type: "text/csv" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `selected-invoices-${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            /* Toast AFTER the download is triggered, not before. It used to fire first and
               say "Exporting…" whether or not anything followed. */
            toast.success(`Exported ${selectedInvoices.length} invoice${selectedInvoices.length === 1 ? "" : "s"} to CSV`);
          }}
        >
          Export CSV
        </BulkBarButton>
      </BulkActionBar>

      {/* Error */}
      {error && (
        <EmptyState
          icon="alert"
          title="Could not load invoices"
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
                  {[1, 2, 3, 4, 5].map((j) => (
                    <td key={j} className="p-3"><Skeleton className="h-3 w-full" /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Empty */}
      {!isLoading && !error && invoices && invoices.length === 0 && (
        <EmptyState
          icon="receipt"
          title="No invoices yet"
          body={canQuotes
            ? "Invoices are generated when a quote is accepted and payment is recorded. Start by creating a quote."
            : "Invoices are generated when a quote is accepted and payment is recorded. Your owner or sales team creates the quotes."}
          action={canQuotes ? (
            <Button asChild variant="primary" icon="file">
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- pre-existing plain <a> (full navigation), kept as-is by the Next 15 upgrade; eslint-plugin-next 15 now also scans app/ */}
              <a href="/quotes/new">Create a quote</a>
            </Button>
          ) : undefined}
        />
      )}

      {/* The list — shared DataTable (R-085): header sort, saved views, select on phone too.
          Cards below 1280px (the row has eight columns), table above. */}
      {!isLoading && !error && invoices && invoices.length > 0 && (
        <DataTable
          rows={rows}
          columns={INVOICE_COLUMNS}
          getRowId={(i) => i.id}
          totalCount={viewInvoices.length}
          noun="invoice"
          selected={selected}
          onSelectedChange={setSelected}
          cardsBelow="xl"
          /* R-024: paint 50 at a time; counts, tabs and KPIs above still use every invoice. */
          pageSize={50}
          views={{ storageKey: "invoices", current: viewState, apply: applyView }}
          toolbar={
            <>
              <select
                value={dateRange}
                onChange={(e) => setDateRange(e.target.value as typeof dateRange)}
                aria-label="Date range"
                className="bg-paper border border-hairline rounded-md text-xs px-2.5 py-1.5 font-medium text-ink focus:outline-none focus:border-amber cursor-pointer"
              >
                <option value="all">All time</option>
                <option value="this_month">This month</option>
                <option value="last_30">Last 30 days</option>
                <option value="this_quarter">This quarter</option>
              </select>
              <div className="w-full sm:w-64">
                <Input
                  prefix={<Icon name="search" size={14} />}
                  aria-label="Search invoices"
                  placeholder="Invoice #, customer, status…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </>
          }
          mobileCard={(inv) => (
            <MobileInvoiceCard inv={inv} notes={noteTotals?.get(inv.id)} />
          )}
          renderRow={(inv, ctx) => (
            <InvoiceRow
              inv={inv}
              ctx={ctx}
              notes={noteTotals?.get(inv.id)}
              isProject={projectInvoiceIds?.has(inv.id) ?? false}
            />
          )}
          empty={
            search.trim() ? (
              <EmptyState
                icon="search"
                title="No invoices match"
                body={`No results for "${search}". Try a different term.`}
                action={<Button icon="x" onClick={() => setSearch("")}>Clear search</Button>}
                compact
              />
            ) : (
              <EmptyState
                icon="receipt"
                title={`No ${tab} invoices`}
                body={tab === "overdue" ? "🎉 All clear! No overdue invoices." : `No invoices in "${tab}" status right now.`}
                action={tab !== "all" ? <Button icon="x" onClick={() => setTab("all")}>Show all</Button> : undefined}
                compact
              />
            )
          }
        />
      )}

      {/* Mobile primary — the header "New invoice" scrolls away on a phone. */}
      {canQuotes && <FAB icon="plus" label="New invoice" onClick={() => router.push("/quotes" as any)} />}

      {/* ── The two taps that issue a GST invoice ────────────────────────────
          Both used to fire on a bare click. Each states the number it will take,
          the amount, whose it is, which due date applies, and that the document
          cannot be edited afterwards — true since migration 20260823090000. */}
      <ConfirmIssueDialog
        open={confirmSingle !== null}
        onOpenChange={(v) => { if (!v) setConfirmSingle(null); }}
        consequences={singleConsequences}
        confirmLabel="Issue invoice"
        busy={generateInvoice.isPending}
        onConfirm={() => {
          const id = confirmSingle;
          if (!id) return;
          setConfirmSingle(null);
          generateInvoice.mutate(id);
        }}
      />

      <ConfirmIssueDialog
        open={confirmBulk && bulkConsequences !== null}
        onOpenChange={(v) => { if (!v) setConfirmBulk(false); }}
        consequences={bulkConsequences}
        confirmLabel={`Issue ${pendingSelected.size} invoice${pendingSelected.size === 1 ? "" : "s"}`}
        busy={generating}
        onConfirm={() => { void issueSelected(); }}
      />
    </div>
  );
}

// ============================================================
// R-009 — credit / debit notes under the amount (row + phone card)
// ============================================================
/** "CN −₹1,180 · DN +₹500" and "Net ₹10,620" — only when the invoice has notes. */
function InvoiceNoteLines({ notes, net }: { notes?: NoteTotals; net: number }) {
  if (!notes || (notes.credit === 0 && notes.debit === 0)) return null;
  return (
    <>
      <span className="block text-3xs font-medium tabular-nums leading-tight" title="Credit and debit notes on this invoice">
        {notes.credit > 0 && <span className="text-rose">CN −{rupee(notes.credit)}</span>}
        {notes.credit > 0 && notes.debit > 0 && <span className="text-ink-3"> · </span>}
        {notes.debit > 0 && <span className="text-indigo-ink">DN +{rupee(notes.debit)}</span>}
      </span>
      <span className="block text-3xs font-medium tabular-nums leading-tight text-ink-3" title="Invoice amount after credit and debit notes">
        Net <span className="text-ink-2">{rupee(net)}</span>
      </span>
    </>
  );
}

// ============================================================
// Mobile Invoice Card — phones only
// ============================================================
function MobileInvoiceCard({ inv, notes }: { inv: Invoice; notes?: NoteTotals }) {
  const net = netAfterNotes(inv.amount, notes);

  /* R-086: a real link to the invoice's own page (was a sheet over the list). */
  return (
      <Link
        href={invoiceHref(inv.id) as never}
        aria-label={`Open invoice ${inv.id}`}
        className="block bg-paper border border-hairline rounded-lg p-3 active:bg-paper-2/50 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
      >
        <div className="flex items-start justify-between gap-3 mb-1.5">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs font-semibold text-ink">{inv.id}</p>
            <p className="text-sm font-medium text-ink mt-0.5 truncate">{cleanDisplayName(inv.customer_name)}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="font-serif text-base tabular-nums text-ink">{rupee(inv.amount)}</p>
            <InvoiceNoteLines notes={notes} net={net} />
            {/* Same rule as the desktop row. `net_payable && …` printed a bare "0" when
                advances covered the whole invoice (net 0). Compared with the value AFTER
                notes, so a credit note alone does not also print a second "Net due". */}
            {inv.net_payable !== null && inv.net_payable < net && inv.status !== "paid" && (
              <p className="text-3xs text-ink-3 tabular-nums">Net due {rupee(inv.net_payable)}</p>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-hairline/60 text-xs">
          <span className="text-ink-3">
            {/* The invoice's own date (what the desktop row and the PDF show), not the
                row's insert time. */}
            {formatDate(inv.invoice_date)}
          </span>
          <div className="flex items-center gap-1.5">
            {/* Mobile card. Same derived bucket as the desktop row, or the phone and the
                laptop would name the same invoice differently (R-060). */}
            {(() => {
              /* R-238: same label as the desktop row and the invoice page. */
              const sb = invoiceStatusBadge(inv);
              return (
                <Badge kind={sb?.kind ?? "muted"} size="sm" dot>
                  {sb?.label ?? invoiceBucket(inv)}
                </Badge>
              );
            })()}
          </div>
        </div>
      </Link>
  );
}

// ============================================================
// Invoice row
// ============================================================
function InvoiceRow({
  inv,
  ctx,
  notes,
  isProject = false,
}: {
  inv: Invoice;
  /** From DataTable — carries the selection checkbox cell. */
  ctx: RowCtx;
  /** R-009: credit / debit note totals for this invoice (absent = none). */
  notes?: NoteTotals;
  /** Invoice came from a project milestone (vs a subscription quote). */
  isProject?: boolean;
}) {
  const router = useRouter();
  const waSender = useWhatsAppSender();
  const { data: me } = useCurrentUser();
  const canQuotes = canOpenQuotes(me?.role);
  const [delOpen, setDelOpen] = React.useState(false);
  const [payOpen, setPayOpen] = React.useState(false);
  const [subPayOpen, setSubPayOpen] = React.useState(false);
  const [cnOpen, setCnOpen] = React.useState(false);
  const [dnOpen, setDnOpen] = React.useState(false);
  const delProjectInvoice = useDeleteProjectInvoice();
  const delSubscriptionInvoice = useDeleteSubscriptionInvoice();
  // Milestone behind this project invoice — lazily loaded when recording payment.
  const { data: payMilestone } = useMilestoneByInvoice(payOpen && isProject ? inv.id : null);
  const [expanded, setExpanded] = React.useState(false);
  const net = netAfterNotes(inv.amount, notes);
  /* R-086: the invoice opens on its own page, /invoices/<id>, instead of a sheet. */
  const openInvoice = () => router.push(invoiceHref(inv.id) as never);

  return (
    <>
    <tr
      className="group border-b border-hairline last:border-0 hover:bg-paper-2/50 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset"
      role="button"
      tabIndex={0}
      aria-label={`Open invoice ${inv.id}`}
      onClick={openInvoice}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openInvoice(); } }}
    >
      {ctx.checkboxCell}
      {/* Full invoice number (mono) + type badge — never truncated. */}
      <td className="px-3 py-2.5 align-top">
        <div className="font-mono text-[12px] font-semibold text-ink break-all leading-snug">{inv.id}</div>
        <Badge kind={isProject ? "info" : "muted"} size="sm" className="mt-1">{isProject ? "Project" : "Subscription"}</Badge>
      </td>
      <td className="px-3 py-2.5 text-sm font-medium align-top" onClick={(e) => e.stopPropagation()}>
        {inv.customer_id ? (
          <Link href={`/customers/${inv.customer_id}` as never} className="text-ink hover:text-amber-ink hover:underline break-words leading-snug">
            {cleanDisplayName(inv.customer_name)}
          </Link>
        ) : (
          <span className="text-ink break-words leading-snug">{cleanDisplayName(inv.customer_name)}</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-sm text-ink-2 whitespace-nowrap align-top">{formatDate(inv.invoice_date)}</td>
      <td className="px-3 py-2.5 text-sm text-ink-2 whitespace-nowrap align-top">{inv.due_date ? formatDate(inv.due_date) : "—"}</td>
      <td className="px-3 py-2.5 text-right align-top">
        <div className="flex flex-col items-end gap-0.5">
          <span className="font-serif text-[15px] font-semibold text-ink tabular-nums">{rupee(inv.amount)}</span>
          <InvoiceNoteLines notes={notes} net={net} />
          {/* Net payable when advances were adjusted at issue (CGST Rule 53).
              Clean single line; the advance breakdown rides in the tooltip. Measured
              from the value after notes — a credit note also lowers net_payable, and
              that gap is the note, not an advance. */}
          {inv.net_payable !== null && inv.net_payable < net && inv.status !== "paid" && (
            <span
              className="text-3xs font-medium tabular-nums leading-tight text-ink-3 cursor-help"
              title={`Net payable ${rupee(inv.net_payable)} · advance adjusted ${rupee(net - inv.net_payable)}`}
            >
              Net due <span className="text-ink-2">{rupee(inv.net_payable)}</span>
            </span>
          )}
          {/* Part-received (project milestone receipts) — show what's still due. */}
          {(inv.paid_amount ?? 0) > 0 && inv.status !== "paid" && (
            <span className="text-3xs font-medium tabular-nums leading-tight text-emerald">
              {rupee(inv.paid_amount)} paid · <span className="text-amber-ink">{rupee(Math.max(0, net - inv.paid_amount))} due</span>
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 align-top" onClick={(e) => e.stopPropagation()}>
        {(() => {
          // "Partial" is a derived display state, not a separate DB enum value.
          // An invoice with status='pending' but adjusted_advances applied has
          // already collected some money (the advance receipts), so showing
          // bare "Pending" misleads the user into thinking nothing's been
          // received. Same for status='overdue' with advances applied —
          // "Overdue · Partial" reflects reality.
          // Partial when advances were adjusted OR some money is already in
          // (paid_amount — project invoices' milestone receipts, migration 0184).
          /* R-060. Both the state and the day count are derived. `inv.overdue_days` is a
             column with `default 0` and no writer anywhere, so the old branch could only
             ever have rendered "Overdue 0d" — and never did, because nothing set the
             status that reached it either.
             R-238: the label lives in ./invoice-status.ts so /invoices/<id> shows the same word. */
          const sb = invoiceStatusBadge(inv);
          const badge = sb ? <Badge kind={sb.kind} dot={sb.kind !== "muted"}>{sb.label}</Badge> : null;
          // Draft/void have no receipts — badge stays static. Others toggle the
          // payment-receipts accordion on click.
          if (inv.status === "draft" || inv.status === "void") return badge;
          return (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="inline-flex items-center gap-1 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded"
              title="Show payment receipts"
              aria-expanded={expanded}
            >
              {badge}
              <Icon name={expanded ? "chevron_up" : "chevron_down"} size={12} className="text-ink-3" />
            </button>
          );
        })()}
      </td>
      <td className="px-3 py-2.5 align-top" onClick={(e) => e.stopPropagation()}>
        {(() => {
          /* Same bucket as the badge above. `|| status === "overdue"` used to sit here as
             a second condition that could never be true — every overdue invoice is stored
             as `pending` — so it read as coverage that was not there (L112). */
          const due = invoiceBucket(inv);
          const moneyDue = due === "pending" || due === "overdue";
          return (
        <div className="flex gap-1 items-center justify-end">
          {/* One contextual primary action keeps the column tight (no h-scroll).
              Money-due invoices lead with Record payment; everything else with View. */}
          {moneyDue ? (
            <Button
              size="sm"
              variant="primary"
              icon="rupee"
              onClick={() => (isProject ? setPayOpen(true) : setSubPayOpen(true))}
            >
              Record payment
            </Button>
          ) : inv.status !== "void" ? (
            <Button size="sm" icon="file" variant="ghost" onClick={openInvoice}>
              View
            </Button>
          ) : null}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" icon="more_h" aria-label="More actions" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[13rem]">
              {/* Uniform secondary actions for every invoice. */}
              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={openInvoice}>
                <Icon name="file" size={15} /> View / download PDF
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2.5 py-2 cursor-pointer"
                onClick={() => {
                  const url = `${window.location.origin}${invoiceHref(inv.id)}`;
                  navigator.clipboard.writeText(url);
                  toast.success("Invoice link copied to clipboard!");
                }}
              >
                <Icon name="link" size={15} /> Copy invoice link
              </DropdownMenuItem>
              {inv.quote_id && canQuotes && (
                <DropdownMenuItem
                  className="gap-2.5 py-2 cursor-pointer"
                  onClick={() => router.push(`/quotes/${inv.quote_id}` as any)}
                >
                  <Icon name="edit" size={15} /> Edit underlying quote
                </DropdownMenuItem>
              )}
              {moneyDue && (
                <>
                  <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => (isProject ? setPayOpen(true) : setSubPayOpen(true))}>
                    <Icon name="rupee" size={15} /> Record payment
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="gap-2.5 py-2 cursor-pointer font-medium text-emerald"
                    onClick={() => {
                      const url = getInvoiceWhatsAppUrl(inv, null, waSender);
                      window.open(url, "_blank");
                    }}
                  >
                    <Icon name="whatsapp" size={15} /> Send / remind on WhatsApp
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setCnOpen(true)}>
                <Icon name="receipt" size={15} /> Issue credit note
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setDnOpen(true)}>
                <Icon name="receipt" size={15} /> Issue debit note
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* R-014. Only a DRAFT can be deleted — the database refuses the rest, and
                  offering a control whose every press is a refusal teaches people to
                  distrust the menu. The credit-note item two rows up IS the route for an
                  issued invoice, so the §24 next step is already on screen; this says so
                  rather than disappearing silently. */}
              {inv.status === "draft" ? (
                <DropdownMenuItem destructive className="gap-2.5 py-2 cursor-pointer" onClick={() => setDelOpen(true)}>
                  <Icon name="trash" size={15} /> Delete draft
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem disabled className="gap-2.5 py-2">
                  <Icon name="trash" size={15} />
                  <span>
                    Delete invoice
                    <span className="block text-[11px] text-ink-3 font-normal">
                      Issued — use a credit note above
                    </span>
                  </span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
          );
        })()}

        <DeleteInvoiceDialog
          open={delOpen}
          onOpenChange={setDelOpen}
          invoiceId={inv.id}
          isProject={isProject}
          loading={delProjectInvoice.isPending || delSubscriptionInvoice.isPending}
          onConfirm={() => {
            (isProject ? delProjectInvoice : delSubscriptionInvoice).mutate(inv.id, {
              onSuccess: () => setDelOpen(false),
            });
          }}
        />
        {isProject && payMilestone && (
          <RecordProjectPaymentDialog
            open={payOpen}
            onOpenChange={setPayOpen}
            milestone={payMilestone}
            projectId={payMilestone.project_id}
          />
        )}
        {!isProject && subPayOpen && (
          <RecordSubscriptionPaymentContainer
            invoice={inv}
            open={subPayOpen}
            onOpenChange={setSubPayOpen}
          />
        )}
        <IssueCreditNoteDialog
          open={cnOpen}
          onOpenChange={setCnOpen}
          invoiceId={inv.id}
          customerName={inv.customer_name}
          netPayable={inv.net_payable ?? inv.amount}
          taxRate={inv.tax_rate}
          interState={inv.inter_state}
          isExport={(inv.tax_rate ?? 18) === 0}
        />
        <IssueCreditNoteDialog
          open={dnOpen}
          onOpenChange={setDnOpen}
          mode="debit"
          invoiceId={inv.id}
          customerName={inv.customer_name}
          netPayable={inv.net_payable ?? inv.amount}
          taxRate={inv.tax_rate}
          interState={inv.inter_state}
          isExport={(inv.tax_rate ?? 18) === 0}
        />
      </td>
    </tr>
    {expanded && (
      <tr className="bg-paper-2/30 border-b border-hairline">
        <td colSpan={8} className="px-5 py-3 space-y-3">
          <InvoicePaymentsAccordion inv={inv} />
          <InvoiceNotesList invoiceId={inv.id} />
        </td>
      </tr>
    )}
    </>
  );
}

/**
 * RecordSubscriptionPaymentContainer — lazily loads the invoice's parent quote +
 * its payments, then opens the SAME quote-keyed RecordPaymentDialog used on the
 * quote detail page. Subscription invoices have no invoice-keyed payment RPC —
 * record_payment runs on the parent quote and flips the invoice to paid when the
 * balance is covered. This is a shortcut surface, not a new money path.
 */
function RecordSubscriptionPaymentContainer({
  invoice,
  open,
  onOpenChange,
}: {
  invoice: Invoice;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: quote, isLoading } = useQuoteByInvoiceId(invoice.id);
  const { data: payments } = usePaymentsByQuote(quote?.id);

  // Quote is the money source of truth. Until it loads we can't open the dialog
  // safely (no expected amount / already-received), so hold with a tiny hint.
  if (isLoading || !quote) {
    return <div className="text-3xs text-ink-3 mt-1 italic">Loading payment…</div>;
  }

  return (
    <RecordPaymentDialog
      open={open}
      onOpenChange={onOpenChange}
      quoteId={quote.id}
      customerName={invoice.customer_name ?? quote.customer_name}
      expectedAmount={quote.amount ?? invoice.amount}
      alreadyReceived={totalReceived(payments ?? [])}
      isProspect={!!quote.lead_id && !quote.customer_id}
      invoiceId={invoice.id}
      customerId={invoice.customer_id ?? quote.customer_id}
      askDomain={!quote.is_one_off}
      defaultDomain={quote.domain ?? undefined}
    />
  );
}

/**
 * InvoicePaymentsAccordion — expands under an invoice row to list the payment
 * receipts (advance receipt vouchers) collected against it. Invoice → parent
 * quote → payments. Clicking a receipt opens the GST receipt-voucher dialog.
 */
/**
 * DeleteInvoiceDialog — explained confirmation before deleting an invoice.
 * Lists exactly what else gets removed + WHY, so it's never a blind delete.
 */
function DeleteInvoiceDialog({
  open, onOpenChange, invoiceId, isProject, loading, onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  invoiceId: string;
  isProject: boolean;
  loading: boolean;
  onConfirm: () => void;
}) {
  // The actual payment(s) that will be deleted (project invoices).
  const { data: projPays } = useProjectPaymentsByInvoice(open && isProject ? invoiceId : null);
  const paysTotal = (projPays ?? []).reduce((s, p) => s + p.amount, 0);

  /* R-014 rewrote this list, and the old version is worth remembering: it promised
     "N payments (₹X) will be deleted" and "the matched bank statement line will be
     un-reconciled". Both were true, and both were the defect — project_payments rows are
     money that actually arrived, reconciled to a real bank line. The RPC now refuses
     rather than doing either, so the copy has to say what really happens or it becomes a
     different kind of lie. */
  const items: { what: string; why: string; extra?: React.ReactNode }[] = isProject
    ? [
        {
          what: (projPays?.length ?? 0) > 0
            ? `This will be REFUSED — ${projPays!.length} payment${projPays!.length === 1 ? "" : "s"} (${rupee(paysTotal)}) are recorded against this invoice`
            : "Payments recorded against this invoice are never deleted",
          why:  "Those are real receipts, reconciled to your bank statement. They outlive the invoice. Refund or remove the payments first (Projects → the project → Payments) if the invoice genuinely has to go.",
          extra: (projPays?.length ?? 0) > 0 ? (
            <ul className="mt-1.5 space-y-1">
              {projPays!.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-2xs">
                  <span className="text-ink-2 capitalize">{(p.method ?? "payment").replace("_", " ")}{p.reference ? ` · ${p.reference}` : ""}{p.bank_txn_id ? " · bank-reconciled" : ""}</span>
                  <span className="tabular-nums font-medium text-ink">{rupee(p.amount)} · {formatDate(p.received_at)}</span>
                </li>
              ))}
            </ul>
          ) : null,
        },
        {
          what: "Your bank reconciliation is left alone",
          why:  "The bank credit stays matched to its payment. Nothing about the statement changes.",
        },
        {
          what: "The milestone re-opens as “unbilled”",
          why:  "The milestone was marked invoiced. Removing the draft returns it to unbilled so you can raise a correct invoice.",
        },
      ]
    : [
        {
          what: "The quote re-opens for re-invoicing",
          why:  "Removing the draft frees its source quote so a fresh, corrected invoice can be generated.",
        },
        {
          what: "Received payments & the subscription are NOT touched",
          why:  "That money and the active service are real. Only the draft document goes — your payment and subscription history stay intact.",
        },
      ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="trash" size={18} className="text-rose" />
            Delete draft {invoiceId}?
          </DialogTitle>
          <DialogDescription>
            {/* R-014: only a draft reaches this dialog now, and "safely removes the GST
                invoice" was never true of an issued one. */}
            {isProject
              ? "This invoice has not been issued. Here’s exactly what happens:"
              : "This invoice has not been issued, so nothing has gone to the customer. Here’s exactly what happens:"}
          </DialogDescription>
        </DialogHeader>

        <ol className="space-y-2.5">
          {items.map((it, i) => (
            <li key={i} className="flex gap-2.5">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-paper-2 text-2xs font-semibold text-ink-2">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink font-medium">{it.what}</p>
                {it.extra}
                <p className="text-[12px] text-ink-3 leading-relaxed mt-0.5"><b className="text-ink-2 font-medium">Why:</b> {it.why}</p>
              </div>
            </li>
          ))}
        </ol>

        <p className="text-[12px] text-rose mt-1">This cannot be undone.</p>
        <p className="text-[12px] text-ink-3 mt-1">
          If this draft already holds a number, that number is <b className="text-ink-2">retired, not reused</b> —
          GST rules forbid giving two different sales the same invoice number, so the next invoice
          takes a fresh one. An <b className="text-ink-2">issued</b> invoice cannot be deleted at all;
          correct it with a credit note.
        </p>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="danger" icon="trash" loading={loading} onClick={onConfirm}>
            Delete draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// BucketTile — aging bucket summary for pending invoice generation
// ============================================================
function BucketTile({ label, count, amount, tone }: {
  label:  string;
  count:  number;
  amount: number;
  tone:   "emerald" | "amber" | "rose-soft" | "rose";
}) {
  const styles =
    tone === "emerald"   ? "bg-emerald-soft border-emerald/30 text-emerald" :
    tone === "amber"     ? "bg-amber-soft border-amber/30 text-amber-ink" :
    tone === "rose-soft" ? "bg-rose-soft border-rose/30 text-amber-ink" :
                           "bg-rose-soft border-rose/40 text-rose-ink";
  return (
    <div className={`rounded-md border ${styles} p-3`}>
      <div className="text-3xs uppercase tracking-wider font-semibold opacity-80">{label}</div>
      <div className="font-serif text-xl mt-0.5 tabular-nums">{count}</div>
      <div className="text-2xs tabular-nums opacity-80 mt-0.5">{rupee(amount)}</div>
    </div>
  );
}

// InvoicesPageInner uses useSearchParams() — Next.js requires that to live
// under a Suspense boundary so static prerender can bail out gracefully.
export default function InvoicesPage() {
  return (
    <React.Suspense fallback={<div className="p-8 text-sm text-ink-3">Loading invoices…</div>}>
      <InvoicesRoute />
    </React.Suspense>
  );
}

/* R-086: `?open=<id>` is the OLD deep link — already sent on WhatsApp/email, and still built
   by the command palette, quotes, payments and deal timelines. It is forwarded to the
   invoice's own page with replace(), so Back skips the hop and lands where the user was,
   and the list is not rendered (or fetched) only to be thrown away. */
function InvoicesRoute() {
  const searchParams = useSearchParams();
  const target = legacyOpenRedirect(searchParams.get("open"));
  if (target) return <LegacyOpenRedirect to={target} />;
  return <InvoicesPageInner />;
}

function LegacyOpenRedirect({ to }: { to: string }) {
  const router = useRouter();
  React.useEffect(() => {
    router.replace(to as never);
  }, [to, router]);
  return (
    <div className="p-8 text-sm text-ink-3" role="status">
      Opening invoice…{" "}
      <Link href={to as never} className="underline hover:text-ink">Open it now</Link>
    </div>
  );
}
