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
import { SAAS_HSN } from "@/lib/gst/hsn";
import { useInvoices, useQuotesAwaitingInvoice, useGenerateInvoice, useDeleteProjectInvoice, useDeleteSubscriptionInvoice, useDocumentSeries } from "@/lib/queries/invoices";
import { useQuoteByInvoiceId } from "@/lib/queries/quotes";
import { usePaymentsByQuote, totalReceived } from "@/lib/queries/payments";
import { RecordPaymentDialog } from "@/components/features/quotes/record-payment-dialog";
import { useProjectPaymentsByInvoice, useProjectInvoiceIds, useMilestoneByInvoice } from "@/lib/queries/projects";
import { RecordProjectPaymentDialog } from "@/components/features/projects/record-project-payment-dialog";
import { useCustomer } from "@/lib/queries/customers";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { TaxInvoiceDialog } from "@/components/features/quotes/tax-invoice-dialog";
import { IssueCreditNoteDialog } from "@/components/features/invoices/issue-credit-note-dialog";
import { useCreditNotesByInvoice } from "@/lib/queries/credit-notes";
import { useDebitNotesByInvoice } from "@/lib/queries/debit-notes";
import { useInvoiceNoteTotals } from "@/lib/queries/invoice-note-totals";
import { netAfterNotes, type NoteTotals } from "@/lib/invoices/note-totals";
import { ReceiptVoucherDialog } from "@/components/features/quotes/receipt-voucher-dialog";
import { isInterStateSupply, placeOfSupplyLabel } from "@/lib/gst/place-of-supply";
import { supplierIdentity, supplierIdentityMessage } from "@/lib/invoices/supplier-identity";
/* R-060. `status = 'overdue'` has no writer anywhere in the product, so the Overdue tab
   and its KPI were permanently empty while invoices ran months late. Derived from
   due_date instead — see the header of lib/invoices/overdue.ts for why not a cron. */
import { invoiceOverdueDays, invoiceBucket } from "@/lib/invoices/overdue";
import {
  invoiceChip, invoiceChipCounts, invoiceKpis, invoiceInFocus, INVOICE_FOCI, INVOICE_FOCUS_LABEL, type InvoiceFocus,
} from "@/lib/invoices/kpis";
import { FocusBanner } from "@/components/shared/focus-banner";
/* R-066. The GST breakdown comes from one place, shared with the server PDF builder —
   see the header of lib/invoices/display-amounts.ts. */
import { invoiceDisplayAmounts } from "@/lib/invoices/display-amounts";
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { ConfirmIssueDialog } from "@/components/features/invoices/confirm-issue-dialog";
import { issueConsequences, bulkIssueConsequences } from "@/lib/invoices/issue-consequences";
import { rupee, formatDate, daysBetween, cleanDisplayName } from "@/lib/utils";
import { getInvoiceWhatsAppUrl } from "@/lib/whatsapp";
import { useWhatsAppSender } from "@/lib/hooks/useWhatsAppSender";
import type { Invoice, Payment } from "@/lib/supabase/database.types";

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
  /** Who the outbound WhatsApp reminders are from — see lib/hooks/useWhatsAppSender. */
  const waSender     = useWhatsAppSender();
  /** Deep-link target: `?open=INV-XXX` auto-opens that invoice's dialog (set by
   *  the "Invoiced" button on the Quotes list). Consumed once + URL cleaned. */
  const openInvoiceId = searchParams.get("open");

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

  // Strip the ?open param once the invoice list has loaded the target row,
  // so refreshing the page doesn't keep re-opening the dialog.
  React.useEffect(() => {
    if (!openInvoiceId || !invoices) return;
    if (!invoices.some((i) => i.id === openInvoiceId)) return;
    // Wait a tick so the InvoiceRow's autoOpen effect fires first
    const t = setTimeout(() => router.replace("/invoices" as any), 200);
    return () => clearTimeout(t);
  }, [openInvoiceId, invoices, router]);

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
          <Button variant="primary" icon="plus" onClick={() => router.push("/quotes" as any)}>
            New invoice
          </Button>
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
                            <Link href={`/quotes/${q.id}` as any} className="font-mono text-xs font-semibold text-ink hover:text-amber-ink hover:underline block truncate">{q.id}</Link>
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
                              <Link
                                href={`/quotes/${q.id}` as any}
                                className="font-mono text-xs font-semibold text-ink hover:text-amber-ink hover:underline"
                              >
                                {q.id}
                              </Link>
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
          body="Invoices are generated when a quote is accepted and payment is recorded. Start by creating a quote."
          action={
            <Button asChild variant="primary" icon="file">
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- pre-existing plain <a> (full navigation), kept as-is by the Next 15 upgrade; eslint-plugin-next 15 now also scans app/ */}
              <a href="/quotes/new">Create a quote</a>
            </Button>
          }
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
          revealId={openInvoiceId}
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
            <MobileInvoiceCard inv={inv} notes={noteTotals?.get(inv.id)} autoOpen={inv.id === openInvoiceId} />
          )}
          renderRow={(inv, ctx) => (
            <InvoiceRow
              inv={inv}
              ctx={ctx}
              notes={noteTotals?.get(inv.id)}
              autoOpen={inv.id === openInvoiceId}
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
      <FAB icon="plus" label="New invoice" onClick={() => router.push("/quotes" as any)} />

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
function MobileInvoiceCard({ inv, notes, autoOpen = false }: { inv: Invoice; notes?: NoteTotals; autoOpen?: boolean }) {
  const net = netAfterNotes(inv.amount, notes);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  /* R-085: `?open=INV-…` used to open the dialog only from the desktop row, so below
     1280px (most laptops, every phone) the shared link landed on the list and nothing
     opened. Same once-only guard as InvoiceRow. */
  const autoOpenFired = React.useRef(false);
  React.useEffect(() => {
    if (autoOpen && !autoOpenFired.current) {
      autoOpenFired.current = true;
      setPreviewOpen(true);
    }
  }, [autoOpen]);

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setPreviewOpen(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPreviewOpen(true); } }}
        className="block bg-paper border border-hairline rounded-lg p-3 active:bg-paper-2/50 cursor-pointer transition-colors"
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
            <Badge
              kind={
                invoiceBucket(inv) === "paid"    ? "success" :
                invoiceBucket(inv) === "overdue" ? "danger"  :
                invoiceBucket(inv) === "pending" ? "warning" :
                                                   "muted"
              }
              size="sm"
              dot
            >
              {invoiceBucket(inv)}
            </Badge>
          </div>
        </div>
      </div>

      {previewOpen && (
        <InvoicePreviewContainer
          invoice={inv}
          open={previewOpen}
          onOpenChange={setPreviewOpen}
        />
      )}
    </>
  );
}

// ============================================================
// Invoice row
// ============================================================
function InvoiceRow({
  inv,
  ctx,
  notes,
  autoOpen = false,
  isProject = false,
}: {
  inv: Invoice;
  /** From DataTable — carries the selection checkbox cell. */
  ctx: RowCtx;
  /** R-009: credit / debit note totals for this invoice (absent = none). */
  notes?: NoteTotals;
  /** When true (set by `?open=INV-XX` deep link), opens the preview dialog
   *  immediately. Fires once via a ref guard so re-renders don't re-open. */
  autoOpen?: boolean;
  /** Invoice came from a project milestone (vs a subscription quote). */
  isProject?: boolean;
}) {
  const router = useRouter();
  const waSender = useWhatsAppSender();
  const [previewOpen, setPreviewOpen] = React.useState(false);
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
  const autoOpenFired = React.useRef(false);
  const net = netAfterNotes(inv.amount, notes);

  React.useEffect(() => {
    if (autoOpen && !autoOpenFired.current) {
      autoOpenFired.current = true;
      setPreviewOpen(true);
    }
  }, [autoOpen]);

  return (
    <>
    <tr
      className="group border-b border-hairline last:border-0 hover:bg-paper-2/50 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset"
      role="button"
      tabIndex={0}
      aria-label={`Open invoice ${inv.id}`}
      onClick={() => setPreviewOpen(true)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPreviewOpen(true); } }}
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
          const hasAdvancesApplied = Array.isArray(inv.adjusted_advances) && inv.adjusted_advances.length > 0;
          const partial = (hasAdvancesApplied || (inv.paid_amount ?? 0) > 0) && inv.status !== "paid";
          /* R-060. Both the state and the day count are derived. `inv.overdue_days` is a
             column with `default 0` and no writer anywhere, so the old branch could only
             ever have rendered "Overdue 0d" — and never did, because nothing set the
             status that reached it either. */
          const bucket = invoiceBucket(inv);
          const lateBy = invoiceOverdueDays(inv);
          const badge =
              bucket === "paid"    ? <Badge kind="success" dot>Paid</Badge>
            : bucket === "pending" ? (partial ? <Badge kind="warning" dot>Partial</Badge> : <Badge kind="warning" dot>Pending</Badge>)
            : bucket === "overdue" ? (partial ? <Badge kind="danger" dot>Overdue · Partial · {lateBy}d</Badge> : <Badge kind="danger" dot>Overdue {lateBy}d</Badge>)
            : bucket === "draft"   ? <Badge kind="muted">Draft</Badge>
            : bucket === "void"    ? <Badge kind="muted">Void</Badge>
            : null;
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
            <Button size="sm" icon="file" variant="ghost" onClick={() => setPreviewOpen(true)}>
              View
            </Button>
          ) : null}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" icon="more_h" aria-label="More actions" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[13rem]">
              {/* Uniform secondary actions for every invoice. */}
              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setPreviewOpen(true)}>
                <Icon name="file" size={15} /> View / download PDF
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2.5 py-2 cursor-pointer"
                onClick={() => {
                  const url = `${window.location.origin}/invoices?open=${inv.id}`;
                  navigator.clipboard.writeText(url);
                  toast.success("Invoice link copied to clipboard!");
                }}
              >
                <Icon name="link" size={15} /> Copy invoice link
              </DropdownMenuItem>
              {inv.quote_id && (
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
        {previewOpen && (
          <InvoicePreviewContainer
            invoice={inv}
            open={previewOpen}
            onOpenChange={setPreviewOpen}
          />
        )}
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
 * InvoicePreviewContainer — lazily loads the parent quote + advances when the
 * dialog opens, then renders TaxInvoiceDialog. Lives in its own component so
 * the network calls only fire on first "View" click (not for every row).
 */
function InvoicePreviewContainer({
  invoice,
  open,
  onOpenChange,
}: {
  invoice: Invoice;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pdfDialogOpen, setPdfDialogOpen] = React.useState(false);
  const [showItems, setShowItems] = React.useState(true);
  const [showSummary, setShowSummary] = React.useState(true);
  const [showPayments, setShowPayments] = React.useState(true);

  const { data: quote } = useQuoteByInvoiceId(invoice.id);
  const { data: payments } = usePaymentsByQuote(quote?.id);
  const { data: customer } = useCustomer(invoice.customer_id ?? undefined);
  const { data: me } = useCurrentUser();
  const waSender = useWhatsAppSender();

  /* ── WHO IS SELLING THIS — resolved or refused, never invented ──────────────
     This used to be `me || { tenantName: "Excel Technologies Pvt Ltd",
     tenantGstin: "27AABCE9876D1Z3", tenantStateCode: "27", … }` — a fallback that
     looked like a placeholder and behaved like a false declaration.

     The costly part was `stateCode: "27"`. It feeds isInterStateSupply() four lines
     below. ANUTECH is Delhi, **07**. So while `useCurrentUser` was still in flight —
     a deep link into an invoice on a slow connection — a Delhi customer's INTRA-state
     sale (CGST 9% + SGST 9%) was computed as **IGST 18%**. Same rupees, wrong tax
     heads, wrong government paid, and the fix is a credit note plus a fresh invoice
     rather than an edit. Invisible in testing; reproducible in front of a customer.

     The rule now lives in lib/invoices/supplier-identity.ts with its own regression
     test: there is no safe default for "who is selling this", so an unknown identity
     is reported and the document is withheld. */
  const identity = supplierIdentity(me);
  const supplier = identity.ok ? identity.supplier : null;

  /* R-010. A project-milestone invoice has no quote — it is raised from a milestone — and
     a subscription instalment deliberately leaves quote_id null. Both write their own
     `invoices.line_items`, and this read of the quote alone is why the dialog and the PDF
     printed "No line items recorded on the parent quote." over a correct ₹5,00,000 + GST:
     right money, a document that did not say what was sold (CGST Rule 46(g)). */
  const lineItems = quote?.line_items ?? invoice.line_items ?? [];
  /* R-066. This used to be `subtotal = quote?.subtotal ?? invoice.amount` and then 18%
     on top — but `invoice.amount` is the GST-INCLUSIVE gross, so a quote-less invoice
     was taxed on tax: ₹5,90,000 showed "Tax Total ₹1,06,200" instead of ₹90,000.
     Quote-less is the NORMAL case for project-milestone and subscription-instalment
     invoices, and `quote` is also undefined on every first render while the query is in
     flight, so the wrong figure flashed on quote-backed invoices too.

     One call, and it is the same one the server PDF builder makes — these four numbers
     go straight into TaxInvoiceDialog and both PDF buttons below, so the file a customer
     receives was wrong in the same way. */
  const { subtotal, discount, taxable, taxRate, tax } = invoiceDisplayAmounts(invoice, quote);
  const total     = quote?.amount ?? invoice.amount;

  /* `supplier` is null until the identity is complete, so this cannot silently pick a
     side. `undefined` makes isInterStateSupply say "I don't know" instead of guessing —
     and the PDF button below is disabled while that is the case. */
  const interState = isInterStateSupply(
    customer?.state_code,
    supplier?.stateCode,
    { customerGstin: customer?.gstin, sellerGstin: supplier?.gstin },
  );
  const receivedPayments = (payments ?? []).filter((p) => p.status === "received");

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="sm:max-w-xl w-full p-0 flex flex-col h-full bg-paper overflow-y-auto">
          <SheetHeader className="p-4 border-b border-hairline bg-paper-2 sticky top-0 z-20 flex flex-row items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-base font-bold text-ink">{invoice.id}</span>
                <Badge kind={invoice.status === "paid" ? "success" : "warning"} size="sm" dot>
                  {invoice.status}
                </Badge>
              </div>
              <SheetTitle className="text-xs font-medium text-ink-2 mt-0.5">
                {cleanDisplayName(invoice.customer_name)}
              </SheetTitle>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {quote?.id && (
                /* "View quote" — same reasoning as tax-invoice-dialog.tsx. This opens the
                   quote hub, which is a read-only view, and an issued tax invoice is no
                   place to suggest editing the figures behind it (CGST §31; corrections are
                   credit/debit notes under §34). */
                <Button
                  size="sm"
                  variant="outline"
                  icon="file"
                  onClick={() => {
                    onOpenChange(false);
                    router.push(`/quotes/${quote.id}` as any);
                  }}
                >
                  View quote
                </Button>
              )}
              <Button
                size="sm"
                variant="primary"
                icon="whatsapp"
                onClick={() => window.open(getInvoiceWhatsAppUrl(invoice, customer?.contact_phone, waSender), "_blank")}
              >
                WhatsApp
              </Button>
              {/* §24 — a block never dead-ends. The button stays visible and clickable so
                  the operator learns WHY rather than wondering why nothing happens, and
                  the toast carries the route to the fix. */}
              <Button
                size="sm"
                variant="ghost"
                icon="file"
                onClick={() => {
                  if (!supplier) {
                    const msg = supplierIdentityMessage(identity)!;
                    toast.error("Can't issue this Tax Invoice yet", {
                      description: msg,
                      action: identity.ok || !identity.hasSession ? undefined : {
                        label: "Open Settings",
                        onClick: () => router.push("/settings"),
                      },
                    });
                    return;
                  }
                  setPdfDialogOpen(true);
                }}
              >
                PDF
              </Button>
            </div>
          </SheetHeader>

          <div className="p-4 space-y-4 flex-1">
            {/* 🔽 Collapsible Panel 1: Invoice Overview & Tax Summary */}
            <Card className="overflow-hidden">
              <button
                type="button"
                onClick={() => setShowSummary((s) => !s)}
                className="w-full px-4 py-3 bg-paper-2/60 border-b border-hairline flex items-center justify-between font-semibold text-xs text-ink hover:bg-paper-2 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <Icon name="receipt" size={14} className="text-ink-3" />
                  <span>Invoice Overview & GST Summary</span>
                </div>
                <Icon name={showSummary ? "chevron_up" : "chevron_down"} size={14} className="text-ink-3" />
              </button>

              {showSummary && (
                <div className="p-4 space-y-3 text-xs">
                  <div className="grid grid-cols-2 gap-3 pb-3 border-b border-hairline/60">
                    <div>
                      <p className="text-3xs text-ink-3 uppercase tracking-wider font-semibold">Total Amount</p>
                      <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{rupee(total)}</p>
                    </div>
                    <div>
                      <p className="text-3xs text-ink-3 uppercase tracking-wider font-semibold">Net Payable</p>
                      <p className="font-serif text-lg font-bold text-emerald tabular-nums mt-0.5">{rupee(invoice.net_payable ?? total)}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-ink-2">
                    <div><span className="text-ink-3">Invoice Date:</span> {formatDate(invoice.invoice_date)}</div>
                    <div><span className="text-ink-3">Due Date:</span> {invoice.due_date ? formatDate(invoice.due_date) : "—"}</div>
                    {/* R-043: the place of supply and tax head FROZEN on the invoice (Rule 46 name + code), not today's customer. */}
                    <div><span className="text-ink-3">Place of Supply:</span> {placeOfSupplyLabel({ posCode: invoice.pos_state_code, interState: invoice.inter_state ?? !!interState, isExport: invoice.pos_state_code === "96", country: invoice.customer_country })}</div>
                    <div><span className="text-ink-3">Tax Total:</span> {rupee(tax)} ({taxRate}%)</div>
                  </div>
                </div>
              )}
            </Card>

            {/* 🔽 Collapsible Panel 2: Line Items & HSN/SAC Breakdown */}
            <Card className="overflow-hidden">
              <button
                type="button"
                onClick={() => setShowItems((s) => !s)}
                className="w-full px-4 py-3 bg-paper-2/60 border-b border-hairline flex items-center justify-between font-semibold text-xs text-ink hover:bg-paper-2 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <Icon name="file" size={14} className="text-ink-3" />
                  <span>Line Items ({lineItems.length > 0 ? lineItems.length : "1"})</span>
                </div>
                <Icon name={showItems ? "chevron_up" : "chevron_down"} size={14} className="text-ink-3" />
              </button>

              {showItems && (
                <div className="p-3">
                  {lineItems.length > 0 ? (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-hairline text-ink-3 text-3xs uppercase">
                          <th className="text-left py-1">Description</th>
                          <th className="text-center py-1">HSN/SAC</th>
                          <th className="text-right py-1">Qty</th>
                          <th className="text-right py-1">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-hairline/60">
                        {lineItems.map((item, idx) => (
                          <tr key={idx}>
                            <td className="py-2 font-medium text-ink">{item.name}</td>
                            <td className="py-2 text-center text-ink-3 font-mono text-2xs">{(item as { hsn?: string | null }).hsn || SAAS_HSN}</td>
                            <td className="py-2 text-right tabular-nums">{item.qty}</td>
                            <td className="py-2 text-right font-medium tabular-nums">{rupee((item.rate ?? 0) * (item.qty ?? 1))}</td>
                          </tr>
                        ))}
                      </tbody>
                      {/* R-084 (1 Oct 2026): a coupon's discount was invisible here — line ₹600,
                          total ₹637 (540 + 97) with no −₹60 anywhere on screen, though the PDF
                          showed it. Same numbers as the PDF (invoiceDisplayAmounts). */}
                      {discount > 0 && (
                        <tfoot className="border-t border-hairline text-ink-2">
                          <tr>
                            <td colSpan={3} className="pt-2 text-right">Subtotal</td>
                            <td className="pt-2 text-right tabular-nums">{rupee(subtotal)}</td>
                          </tr>
                          <tr>
                            <td colSpan={3} className="py-1 text-right">Discount{quote?.discount_pct ? ` (${quote.discount_pct}%)` : ""}</td>
                            <td className="py-1 text-right tabular-nums text-emerald">−{rupee(discount)}</td>
                          </tr>
                          <tr className="font-semibold text-ink">
                            <td colSpan={3} className="text-right">Taxable value</td>
                            <td className="text-right tabular-nums">{rupee(taxable)}</td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  ) : (
                    <p className="text-xs text-ink-3 italic p-2">Standard Subscription License Supply (HSN {SAAS_HSN})</p>
                  )}
                </div>
              )}
            </Card>

            {/* 🔽 Collapsible Panel 3: Payments & Receipts Accordion */}
            <Card className="overflow-hidden">
              <button
                type="button"
                onClick={() => setShowPayments((s) => !s)}
                className="w-full px-4 py-3 bg-paper-2/60 border-b border-hairline flex items-center justify-between font-semibold text-xs text-ink hover:bg-paper-2 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <Icon name="rupee" size={14} className="text-ink-3" />
                  <span>Payment Receipts & Advance Adjustments</span>
                </div>
                <Icon name={showPayments ? "chevron_up" : "chevron_down"} size={14} className="text-ink-3" />
              </button>

              {showPayments && (
                <div className="p-4">
                  <InvoicePaymentsAccordion inv={invoice} />
                </div>
              )}
            </Card>

            {/* 🔽 Collapsible Panel 4: Internal Notes */}
            <Card className="p-4">
              <p className="text-xs font-semibold text-ink mb-2">Internal Notes & History</p>
              <InvoiceNotesList invoiceId={invoice.id} />
            </Card>
          </div>
        </SheetContent>
      </Sheet>

      {/* `supplier &&` is load-bearing, not defensive. Without a complete identity this
          dialog would render a Tax Invoice headed by whatever was available — which is
          how the fabricated GSTIN used to reach the page. No identity, no document. */}
      {pdfDialogOpen && supplier && (
        <TaxInvoiceDialog
          open={pdfDialogOpen}
          onOpenChange={setPdfDialogOpen}
          invoice={invoice}
          lineItems={lineItems}
          subtotal={subtotal}
          discountPct={quote?.discount_pct ?? 0}
          discount={discount}
          taxable={taxable}
          taxRate={taxRate}
          tax={tax}
          total={total}
          receivedPayments={receivedPayments}
          interState={interState}
          customerGstin={customer?.gstin}
          customerEmail={customer?.contact_email}
          customerPhone={customer?.contact_phone}
          customerState={customer?.state}
          customerCountry={customer?.country}
          currency={quote?.currency}
          exchangeRate={quote?.exchange_rate}
          tenantName={supplier.name}
          tenantGstin={supplier.gstin}
          tenantEmail={supplier.email}
          tenantPhone={supplier.phone}
          tenantAddress={supplier.address}
          tenantState={supplier.state}
        />
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

/** Credit / debit notes issued against this invoice — shown in the expand so a
 *  note (which quietly lowered/raised the balance) is auditable. */
function InvoiceNotesList({ invoiceId }: { invoiceId: string }) {
  const { data: creditNotes } = useCreditNotesByInvoice(invoiceId);
  const { data: debitNotes } = useDebitNotesByInvoice(invoiceId);
  const notes = [
    ...(creditNotes ?? []).map((n) => ({ ...n, kind: "credit" as const, date: n.credit_date })),
    ...(debitNotes ?? []).map((n) => ({ ...n, kind: "debit" as const, date: n.debit_date })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  if (notes.length === 0) return null;

  return (
    <div>
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
        Credit &amp; debit notes ({notes.length})
      </div>
      <ul className="space-y-1.5">
        {notes.map((n) => (
          <li key={n.id} className="flex items-center justify-between gap-3 rounded-md border border-hairline bg-paper px-3 py-2">
            <span className="flex items-center gap-2 min-w-0">
              <span className={`text-3xs font-semibold uppercase px-1.5 py-0.5 rounded ${n.kind === "credit" ? "bg-rose/10 text-rose" : "bg-indigo-soft text-indigo-ink"}`}>
                {n.kind === "credit" ? "Credit" : "Debit"} note
              </span>
              <span className="font-mono text-2xs text-ink truncate">{n.id}</span>
              <span className="text-2xs text-ink-3 capitalize">· {n.reason_code.replace(/_/g, " ")}</span>
            </span>
            <span className="flex items-center gap-3 shrink-0">
              <span className={`tabular-nums text-sm font-medium ${n.kind === "credit" ? "text-rose" : "text-indigo-ink"}`}>
                {n.kind === "credit" ? "−" : "+"} {rupee(n.amount)}
              </span>
              <span className="text-2xs text-ink-3">{formatDate(n.date)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function InvoicePaymentsAccordion({ inv }: { inv: Invoice }) {
  const { data: quote } = useQuoteByInvoiceId(inv.id);
  const { data: payments, isLoading } = usePaymentsByQuote(quote?.id);
  // Project invoices have no parent quote — their receipts live in project_payments.
  const { data: projPays, isLoading: projLoading } = useProjectPaymentsByInvoice(inv.id);
  const { data: customer } = useCustomer(inv.customer_id ?? undefined);
  const { data: me } = useCurrentUser();
  const [receiptPayment, setReceiptPayment] = React.useState<Payment | null>(null);

  const received = (payments ?? []).filter((p) => p.status === "received");
  const interState = isInterStateSupply(customer?.state_code, me?.tenantStateCode, { customerGstin: customer?.gstin, sellerGstin: me?.tenantGstin });

  if (isLoading || projLoading) return <div className="text-xs text-ink-3 italic">Loading receipts…</div>;

  // Project-sale invoice: render its project payments as the receipts.
  if (received.length === 0 && (projPays?.length ?? 0) > 0) {
    return (
      <div>
        <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
          Payment receipts ({projPays!.length})
        </div>
        <ul className="space-y-1.5">
          {projPays!.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 rounded-md border border-hairline bg-paper px-3 py-2">
              <span className="flex items-center gap-2 min-w-0">
                <Icon name="receipt" size={14} className="text-amber-ink shrink-0" />
                <span className="text-xs text-ink capitalize">{p.method ?? "Payment"}{p.reference ? ` · ${p.reference}` : ""}</span>
                {p.bank_txn_id && <span className="text-3xs text-emerald">· bank-reconciled</span>}
              </span>
              <span className="flex items-center gap-3 shrink-0">
                <span className="tabular-nums text-sm font-medium text-ink">{rupee(p.amount)}</span>
                <span className="text-2xs text-ink-3">{formatDate(p.received_at)}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (received.length === 0) {
    return <div className="text-xs text-ink-3">No payment receipts recorded for this invoice yet.</div>;
  }

  return (
    <div>
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
        Payment receipts ({received.length})
      </div>
      <ul className="space-y-1.5">
        {received.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => setReceiptPayment(p)}
              className="w-full flex items-center justify-between gap-3 rounded-md border border-hairline bg-paper px-3 py-2 text-left transition-colors hover:border-amber-soft hover:bg-amber-soft/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
              title="Open receipt voucher"
            >
              <span className="flex items-center gap-2 min-w-0">
                <Icon name="receipt" size={14} className="text-amber-ink shrink-0" />
                <span className="font-mono text-xs text-ink truncate">{p.receipt_voucher_no ?? "Receipt"}</span>
                <span className="text-2xs text-ink-3 capitalize">· {p.method}</span>
              </span>
              <span className="flex items-center gap-3 shrink-0">
                <span className="tabular-nums text-sm font-medium text-ink">{rupee(p.amount)}</span>
                <span className="text-2xs text-ink-3">{formatDate(p.received_at)}</span>
                <Icon name="chevron_right" size={12} className="text-ink-3" />
              </span>
            </button>
          </li>
        ))}
      </ul>

      {receiptPayment && me && (
        <ReceiptVoucherDialog
          open={!!receiptPayment}
          onOpenChange={(o) => { if (!o) setReceiptPayment(null); }}
          payment={receiptPayment}
          customerName={inv.customer_name}
          customerGstin={customer?.gstin}
          customerEmail={customer?.contact_email}
          customerAddress={customer?.address}
          tenantName={me.tenantName}
          tenantGstin={me.tenantGstin}
          tenantEmail={me.tenantEmail}
          tenantPhone={me.tenantPhone}
          tenantAddress={me.tenantAddress}
          tenantState={me.tenantState}
          interState={interState}
          quoteId={quote?.id}
          gstRate={quote?.tax_rate ?? 18}
        />
      )}
    </div>
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
      <InvoicesPageInner />
    </React.Suspense>
  );
}
