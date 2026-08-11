/**
 * Invoices — list matching prototype design.
 *
 * Layout:
 *   - Header: eyebrow "Revenue" + title + subtitle
 *   - Actions: Export GSTR-1 + Push to Zoho + New invoice
 *   - 5 KPIs: Outstanding / Overdue / Collected MTD / Margin MTD / Avg collection
 *   - Status tabs (All/Paid/Pending/Overdue/Draft) with counts
 *   - Table: checkbox / Invoice # / Customer / Date / Due / Amount / Status / Action
 *   - Auto-Sync Status card at bottom
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useInvoices, useQuotesAwaitingInvoice, useGenerateInvoice, useDeleteProjectInvoice, useDeleteSubscriptionInvoice } from "@/lib/queries/invoices";
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
import { ReceiptVoucherDialog } from "@/components/features/quotes/receipt-voucher-dialog";
import { isInterStateSupply } from "@/lib/gst/place-of-supply";
import { Icon } from "@/components/ui/icon";
import { toast } from "sonner";
import { GeminiCard } from "@/components/shared/gemini-card";
import { EmptyState } from "@/components/shared/empty-state";
import { StatStrip } from "@/components/shared/stat-strip";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { FAB } from "@/components/ui/fab";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { rupee, formatDate, daysBetween, cleanDisplayName } from "@/lib/utils";
import type { Invoice, Payment } from "@/lib/supabase/database.types";

const INV_COL_ORDER = ["select", "invoice", "customer", "date", "due", "amount", "status", "action"];
// Fluid percentage widths (sum = 100) so the table always fits the viewport —
// no fixed-pixel widths, no horizontal scroll. table-fixed keeps them honest.
const INV_COL_WIDTHS: Record<string, string> = {
  select: "3%", invoice: "15%", customer: "19%", date: "10%", due: "10%", amount: "13%", status: "11%", action: "19%",
};

function InvoicesPageInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  /** Deep-link target: `?open=INV-XXX` auto-opens that invoice's dialog (set by
   *  the "Invoiced" button on the Quotes list). Consumed once + URL cleaned. */
  const openInvoiceId = searchParams.get("open");

  const { data: invoices, isLoading, error, refetch } = useInvoices();
  const { data: projectInvoiceIds } = useProjectInvoiceIds();
  const { data: pending } = useQuotesAwaitingInvoice();
  const generateInvoice = useGenerateInvoice();
  const [tab, setTab] = React.useState("all");
  const [search, setSearch] = React.useState("");
  // Combined by default — Subscription & Project invoices live in one list
  // (each row carries a Type badge). The tabs below are just an optional filter.
  const [view, setView] = React.useState<"all" | "subscription" | "project">("all");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const isProjectInv = React.useCallback((id: string) => projectInvoiceIds?.has(id) ?? false, [projectInvoiceIds]);
  const viewInvoices = React.useMemo(
    () => (invoices ?? []).filter((i) =>
      view === "all" ? true : view === "project" ? isProjectInv(i.id) : !isProjectInv(i.id)),
    [invoices, view, isProjectInv],
  );
  const subCount  = React.useMemo(() => (invoices ?? []).filter((i) => !isProjectInv(i.id)).length, [invoices, isProjectInv]);
  const projCount = React.useMemo(() => (invoices ?? []).filter((i) =>  isProjectInv(i.id)).length, [invoices, isProjectInv]);
  const [pendingSelected, setPendingSelected] = React.useState<Set<string>>(new Set());
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
  const counts = React.useMemo(() => {
    const map: Record<string, number> = { all: viewInvoices.length, partial: 0, pending_bare: 0 };
    for (const inv of viewInvoices) {
      map[inv.status] = (map[inv.status] ?? 0) + 1;
      const hasAdv = Array.isArray(inv.adjusted_advances) && inv.adjusted_advances.length > 0;
      if (inv.status === "pending") {
        if (hasAdv) map.partial += 1;
        else        map.pending_bare += 1;
      }
    }
    return map;
  }, [viewInvoices]);

  const tabs: TabBarItem[] = [
    { id: "all",     label: "All",     count: counts.all ?? 0 },
    { id: "paid",    label: "Paid",    count: counts.paid ?? 0, dot: "emerald" },
    { id: "partial", label: "Partial", count: counts.partial ?? 0, dot: "amber" },
    { id: "pending", label: "Pending", count: counts.pending_bare ?? 0, dot: "amber" },
    { id: "overdue", label: "Overdue", count: counts.overdue ?? 0, dot: "rose" },
    { id: "draft",   label: "Draft",   count: counts.draft ?? 0 },
  ];

  // Filter — status tab (Partial/Pending both derive from status='pending',
  // split by whether advances were applied) + free-text search on invoice #,
  // customer, or status.
  const rows = viewInvoices.filter((i) => {
    // Status tab
    if (tab !== "all") {
      const hasAdv = Array.isArray(i.adjusted_advances) && i.adjusted_advances.length > 0;
      if (tab === "partial")      { if (!(i.status === "pending" && hasAdv)) return false; }
      else if (tab === "pending") { if (!(i.status === "pending" && !hasAdv)) return false; }
      else if (i.status !== tab)  { return false; }
    }
    // Search
    if (search.trim()) {
      const s = search.toLowerCase();
      const hit =
        i.id.toLowerCase().includes(s) ||
        (i.customer_name?.toLowerCase().includes(s) ?? false) ||
        i.status.toLowerCase().includes(s);
      if (!hit) return false;
    }
    return true;
  });

  // KPIs — use net_payable (after any advance adjustment) to match the Aging report.
  const outstanding = (invoices ?? [])
    .filter((i) => i.status !== "paid")
    .reduce((s, i) => s + (i.net_payable ?? i.amount), 0);
  const overdueTotal = (invoices ?? [])
    .filter((i) => i.status === "overdue")
    .reduce((s, i) => s + (i.net_payable ?? i.amount), 0);
  const overdueCount = counts.overdue ?? 0;
  const collectedMTD = (invoices ?? [])
    .filter((i) => {
      if (i.status !== "paid" || !i.paid_date) return false;
      const d = new Date(i.paid_date);
      const now = new Date();
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    })
    .reduce((s, i) => s + i.amount, 0);
  const marginMTD = Math.round(collectedMTD * 0.17); // 17% avg estimate
  const paidInvoices = (invoices ?? []).filter((i) => i.status === "paid" && i.paid_date);
  const avgCollection = paidInvoices.length > 0
    ? Math.round(paidInvoices.reduce((s, i) => s + daysBetween(i.invoice_date, i.paid_date!), 0) / paidInvoices.length)
    : 0;

  // Toggle selection
  const toggleAll = () => {
    if (selected.size === rows.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(rows.map((r) => r.id)));
    }
  };
  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
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
        const buckets = { fresh: [] as any[], warn: [] as any[], urgent: [] as any[], overdue: [] as any[] };
        for (const q of pending) {
          // Legal aging anchor = first advance received (not last payment)
          const anchor = q.first_advance_at ?? q.payment_received_at;
          const days = anchor
            ? Math.floor((now - new Date(anchor).getTime()) / 86400000)
            : 0;
          if (days <= 15)       buckets.fresh.push({ ...q, days });
          else if (days <= 30)  buckets.warn.push({ ...q, days });
          else if (days <= 60)  buckets.urgent.push({ ...q, days });
          else                  buckets.overdue.push({ ...q, days });
        }
        // Outstanding, not face value — subtract anything already received
        // (paid_amount: project-milestone receipts, migration 0184) so a
        // part-paid invoice doesn't overstate the receivable bucket.
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

        const generateSelected = async () => {
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
          if (ok > 0) toast.success(`Generated ${ok} invoice${ok === 1 ? "" : "s"}` + (fail ? ` · ${fail} failed` : ""));
          if (fail > 0 && ok === 0) toast.error(`${fail} invoice${fail === 1 ? "" : "s"} failed`);
        };

        return (
          <Card className="mb-6 border-amber/40 bg-amber-soft/30">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
              <div className="flex items-center gap-2.5">
                <Icon name="receipt" size={18} className="text-amber-ink" />
                <div>
                  <h2 className="font-semibold text-ink">Pending GST invoice generation</h2>
                  <p className="text-xs text-ink-3">
                    {pending.length} quote{pending.length === 1 ? "" : "s"} ·{" "}
                    {pending.filter((q: any) => q.payment_status === "partial").length} partially paid ·{" "}
                    {rupee(totalAmt)} total · invoice mandatory within 30 days of first advance (CGST §13, Rule 47)
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                {pendingSelected.size > 0 && (
                  <Button
                    variant="primary"
                    icon="receipt"
                    loading={generating}
                    onClick={generateSelected}
                  >
                    Generate {pendingSelected.size} invoice{pendingSelected.size === 1 ? "" : "s"}
                  </Button>
                )}
              </div>
            </div>

            {/* Aging buckets — 30-day GST clock (Rule 47) */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
              <BucketTile label="0–15 days · fresh"      count={buckets.fresh.length}   amount={sumAmt(buckets.fresh)}   tone="emerald" />
              <BucketTile label="16–30 days · issue soon" count={buckets.warn.length}    amount={sumAmt(buckets.warn)}    tone="amber" />
              <BucketTile label="31–60 days · overdue"   count={buckets.urgent.length}  amount={sumAmt(buckets.urgent)}  tone="rose-soft" />
              <BucketTile label="60+ days · audit risk"  count={buckets.overdue.length} amount={sumAmt(buckets.overdue)} tone="rose" />
            </div>

            {/* Mobile card list — phones only. Keeps the primary "Generate"
                action; bulk-select stays a desktop power feature. */}
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
                        <p className="text-[11px] text-ink-3 mt-0.5">First advance {anchor ? formatDate(anchor) : "—"}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-serif text-base tabular-nums text-ink">{rupee(q.amount ?? 0)}</p>
                        {isPartial && q.payment_amount != null && (
                          <p className="text-[10px] text-amber-ink mt-0.5">{rupee(q.payment_amount)} received</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-hairline/60">
                      <div className="flex items-center gap-1.5">
                        {isPartial ? <Badge kind="info" size="sm" dot>Partial</Badge> : <Badge kind="success" size="sm" dot>Fully paid</Badge>}
                        <Badge kind={ageKind === "rose" ? "danger" : ageKind === "amber" ? "warning" : "success"} size="sm" dot>{days}d ago</Badge>
                      </div>
                      <Button size="sm" variant="primary" icon="receipt" loading={generateInvoice.isPending} onClick={() => generateInvoice.mutate(q.id)}>
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
                    <th className="text-left p-2 text-[10px] uppercase tracking-wider font-semibold text-ink-3">Quote</th>
                    <th className="text-left p-2 text-[10px] uppercase tracking-wider font-semibold text-ink-3">Customer</th>
                    <th className="text-right p-2 text-[10px] uppercase tracking-wider font-semibold text-ink-3">Amount</th>
                    <th className="text-left p-2 text-[10px] uppercase tracking-wider font-semibold text-ink-3">Payment</th>
                    <th className="text-left p-2 text-[10px] uppercase tracking-wider font-semibold text-ink-3">First advance</th>
                    <th className="text-left p-2 text-[10px] uppercase tracking-wider font-semibold text-ink-3">Aging</th>
                    <th className="w-32"></th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((q: any) => {
                    // Legal aging anchor — first advance receipt date (Sec 13(2))
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
                        <td className="p-2">
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
                            <div className="text-[10px] text-amber-ink mt-0.5">
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
                            onClick={() => generateInvoice.mutate(q.id)}
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
          </Card>
        );
      })()}

      {/* Compact metric strip (replaces the big KPI-card grid) */}
      {!isLoading && invoices && (
        <StatStrip
          className="mb-5"
          items={[
            { label: "Outstanding",    value: rupee(outstanding, { compact: true }), tone: outstanding > 0 ? "rose" : "emerald" },
            { label: "Overdue",        value: rupee(overdueTotal, { compact: true }), tone: overdueCount > 0 ? "rose" : "default" },
            { label: "Collected · MTD",value: rupee(collectedMTD, { compact: true }), tone: "emerald" },
            { label: "Margin · MTD",   value: rupee(marginMTD, { compact: true }) },
            { label: "Avg collection", value: avgCollection > 0 ? `${avgCollection}d` : "—" },
          ]}
        />
      )}

      {/* AI suggestion */}
      {!isLoading && invoices && overdueCount > 0 && (
        <div className="mb-4">
          <GeminiCard
            title="Collection intelligence"
            actions={
              <Button size="sm" variant="primary" icon="users" onClick={() => router.push("/customers" as any)}>
                Open customers
              </Button>
            }
            compact
          >
            <b>{overdueCount} overdue invoice{overdueCount === 1 ? "" : "s"} worth {rupee(overdueTotal, { compact: true })}.</b>{" "}
            Customers with overdue invoices have 2× higher churn risk. Reach out today.
          </GeminiCard>
        </div>
      )}

      {/* Tabs + search */}
      {!isLoading && invoices && invoices.length > 0 && (
        <div className="mb-3 space-y-3">
          <TabBar className="overflow-y-hidden" value={tab} onChange={setTab} items={tabs} />
          <div className="flex justify-between items-center gap-3 flex-wrap">
            <div className="text-xs text-ink-3">
              Showing {rows.length} of {viewInvoices.length} invoice{viewInvoices.length === 1 ? "" : "s"}
            </div>
            <div className="w-72">
              <Input
                prefix={<Icon name="search" size={14} />}
                placeholder="Invoice #, customer, status…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
        </div>
      )}

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
              <a href="/quotes/new">Create a quote</a>
            </Button>
          }
        />
      )}

      {/* Filtered empty */}
      {!isLoading && !error && invoices && invoices.length > 0 && rows.length === 0 && (
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
      )}

      {/* Mobile card list — phones only */}
      {!isLoading && !error && rows.length > 0 && (
        <ul className="md:hidden space-y-2 mb-3">
          {rows.map((inv) => (
            <li key={inv.id}>
              <Link
                href={`/quotes/${inv.quote_id}` as never}
                className="block bg-paper border border-hairline rounded-lg p-3 active:bg-paper-2/50"
              >
                <div className="flex items-start justify-between gap-3 mb-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs font-semibold text-ink">{inv.id}</p>
                    <p className="text-sm font-medium text-ink mt-0.5 truncate">{cleanDisplayName(inv.customer_name)}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-serif text-base tabular-nums text-ink">{rupee(inv.amount)}</p>
                    {inv.net_payable && inv.net_payable !== inv.amount && (
                      <p className="text-[10px] text-ink-3 tabular-nums">Net: {rupee(inv.net_payable)}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-hairline/60 text-xs">
                  <span className="text-ink-3">
                    {inv.created_at ? formatDate(inv.created_at) : "—"}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Badge
                      kind={
                        inv.status === "paid"    ? "success" :
                        inv.status === "overdue" ? "danger"  :
                        inv.status === "pending" ? "warning" :
                        inv.status === "void"    ? "muted"   :
                                                   "muted"
                      }
                      size="sm"
                      dot
                    >
                      {inv.status}
                    </Badge>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* Desktop table — fluid % columns so it always fits the viewport (no horizontal scroll). */}
      {!isLoading && !error && rows.length > 0 && (
        <Card flush className="hidden md:block">
          <table className="w-full table-fixed">
            <colgroup>
              {INV_COL_ORDER.map((id) => <col key={id} style={{ width: INV_COL_WIDTHS[id] }} />)}
            </colgroup>
            <thead className="bg-paper-2 border-b border-hairline-strong">
              <tr>
                <th className="px-3 py-2.5">
                  <Checkbox
                    checked={selected.size === rows.length && rows.length > 0}
                    onCheckedChange={toggleAll}
                  />
                </th>
                <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Invoice #</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Customer</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Date</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Due date</th>
                <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Amount</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => (
                <InvoiceRow
                  key={inv.id}
                  inv={inv}
                  checked={selected.has(inv.id)}
                  onToggle={() => toggleOne(inv.id)}
                  autoOpen={inv.id === openInvoiceId}
                  isProject={projectInvoiceIds?.has(inv.id) ?? false}
                />
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Mobile primary — the header "New invoice" scrolls away on a phone. */}
      <FAB icon="plus" label="New invoice" onClick={() => router.push("/quotes" as any)} />
    </div>
  );
}

// ============================================================
// Invoice row
// ============================================================
function InvoiceRow({
  inv,
  checked,
  onToggle,
  autoOpen = false,
  isProject = false,
}: {
  inv: Invoice;
  checked: boolean;
  onToggle: () => void;
  /** When true (set by `?open=INV-XX` deep link), opens the preview dialog
   *  immediately. Fires once via a ref guard so re-renders don't re-open. */
  autoOpen?: boolean;
  /** Invoice came from a project milestone (vs a subscription quote). */
  isProject?: boolean;
}) {
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
      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={checked} onCheckedChange={onToggle} />
      </td>
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
          {/* Net payable when advances were adjusted at issue (CGST Rule 53).
              Clean single line; the advance breakdown rides in the tooltip. */}
          {inv.net_payable !== null && inv.net_payable < inv.amount && (
            <span
              className="text-[10px] font-medium tabular-nums leading-tight text-ink-3 cursor-help"
              title={`Net payable ${rupee(inv.net_payable)} · advance adjusted ${rupee(inv.amount - inv.net_payable)}`}
            >
              Net due <span className="text-ink-2">{rupee(inv.net_payable)}</span>
            </span>
          )}
          {/* Part-received (project milestone receipts) — show what's still due. */}
          {(inv.paid_amount ?? 0) > 0 && inv.status !== "paid" && (
            <span className="text-[10px] font-medium tabular-nums leading-tight text-emerald">
              {rupee(inv.paid_amount)} paid · <span className="text-amber-ink">{rupee(Math.max(0, inv.amount - inv.paid_amount))} due</span>
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
          const badge =
              inv.status === "paid"    ? <Badge kind="success" dot>Paid</Badge>
            : inv.status === "pending" ? (partial ? <Badge kind="warning" dot>Partial</Badge> : <Badge kind="warning" dot>Pending</Badge>)
            : inv.status === "overdue" ? (partial ? <Badge kind="danger" dot>Overdue · Partial · {inv.overdue_days}d</Badge> : <Badge kind="danger" dot>Overdue {inv.overdue_days}d</Badge>)
            : inv.status === "draft"   ? <Badge kind="muted">Draft</Badge>
            : inv.status === "void"    ? <Badge kind="muted">Void</Badge>
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
          const moneyDue = inv.status === "pending" || inv.status === "overdue";
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
              {moneyDue && (
                <>
                  <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => (isProject ? setPayOpen(true) : setSubPayOpen(true))}>
                    <Icon name="rupee" size={15} /> Record payment
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="gap-2.5 py-2 cursor-pointer"
                    onClick={() => setPreviewOpen(true)}
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
              <DropdownMenuItem destructive className="gap-2.5 py-2 cursor-pointer" onClick={() => setDelOpen(true)}>
                <Icon name="trash" size={15} /> Delete invoice
              </DropdownMenuItem>
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
  const { data: quote, isLoading: qLoading } = useQuoteByInvoiceId(invoice.id);
  const { data: payments } = usePaymentsByQuote(quote?.id);
  const { data: customer } = useCustomer(invoice.customer_id ?? undefined);
  const { data: me } = useCurrentUser();

  // Derive totals from quote (same math as quote detail page) — falls back to invoice.amount
  const lineItems = quote?.line_items ?? [];
  const subtotal  = quote?.subtotal ?? invoice.amount;
  const discount  = Math.round(subtotal * ((quote?.discount_pct ?? 0) / 100));
  const taxable   = subtotal - discount;
  const taxRate   = quote?.tax_rate ?? 18;
  const tax       = Math.round(taxable * (taxRate / 100));
  const total     = quote?.amount ?? invoice.amount;

  const interState = isInterStateSupply(customer?.state_code, me?.tenantStateCode);

  const receivedPayments = (payments ?? []).filter((p) => p.status === "received");

  if (qLoading || !me) {
    return (
      <div className="text-[10px] text-ink-3 mt-1 italic">Loading invoice…</div>
    );
  }

  return (
    <TaxInvoiceDialog
      open={open}
      onOpenChange={onOpenChange}
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
      tenantName={me.tenantName}
      tenantGstin={me.tenantGstin}
      tenantEmail={me.tenantEmail}
      tenantPhone={me.tenantPhone}
      tenantAddress={me.tenantAddress}
      tenantState={me.tenantState}
    />
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
    return <div className="text-[10px] text-ink-3 mt-1 italic">Loading payment…</div>;
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

  const items: { what: string; why: string; extra?: React.ReactNode }[] = isProject
    ? [
        {
          what: (projPays?.length ?? 0) > 0
            ? `${projPays!.length} payment${projPays!.length === 1 ? "" : "s"} (${rupee(paysTotal)}) recorded against this invoice will be deleted`
            : "The payment(s) recorded against this invoice will be deleted",
          why:  "This invoice IS the record of that payment. Remove the invoice and the payment has no valid document behind it — keeping it would leave an orphan entry and double-count your collections.",
          extra: (projPays?.length ?? 0) > 0 ? (
            <ul className="mt-1.5 space-y-1">
              {projPays!.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-[11px]">
                  <span className="text-ink-2 capitalize">{(p.method ?? "payment").replace("_", " ")}{p.reference ? ` · ${p.reference}` : ""}{p.bank_txn_id ? " · bank-reconciled" : ""}</span>
                  <span className="tabular-nums font-medium text-ink">{rupee(p.amount)} · {formatDate(p.received_at)}</span>
                </li>
              ))}
            </ul>
          ) : null,
        },
        {
          what: "The matched bank statement line will be un-reconciled",
          why:  "That bank credit was linked to this payment. Since the payment is going, the link must break — otherwise the bank line points to a payment that no longer exists.",
        },
        {
          what: "The milestone re-opens as “unbilled”",
          why:  "The milestone was marked invoiced/paid. Undoing the invoice returns it to unbilled so you can raise a correct invoice again.",
        },
      ]
    : [
        {
          what: "The quote re-opens for re-invoicing",
          why:  "Deleting the GST invoice frees its source quote so a fresh, corrected invoice can be generated.",
        },
        {
          what: "Received payments & the subscription are NOT touched",
          why:  "That money and the active service are real. Only the GST document is removed — your payment and subscription history stay intact.",
        },
      ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="trash" size={18} className="text-rose" />
            Delete {invoiceId}?
          </DialogTitle>
          <DialogDescription>
            {isProject
              ? "Deleting this invoice also reverses everything tied to it, in order:"
              : "This safely removes the GST invoice. Here’s exactly what happens:"}
          </DialogDescription>
        </DialogHeader>

        <ol className="space-y-2.5">
          {items.map((it, i) => (
            <li key={i} className="flex gap-2.5">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-paper-2 text-[11px] font-semibold text-ink-2">{i + 1}</span>
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
          The invoice number is <b className="text-ink-2">retired, not reused</b> — GST rules forbid giving
          two different sales the same invoice number, so the next invoice takes a fresh number.
        </p>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="danger" icon="trash" loading={loading} onClick={onConfirm}>
            Delete invoice
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
      <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-2">
        Credit &amp; debit notes ({notes.length})
      </div>
      <ul className="space-y-1.5">
        {notes.map((n) => (
          <li key={n.id} className="flex items-center justify-between gap-3 rounded-md border border-hairline bg-paper px-3 py-2">
            <span className="flex items-center gap-2 min-w-0">
              <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${n.kind === "credit" ? "bg-rose/10 text-rose" : "bg-indigo-soft text-indigo-ink"}`}>
                {n.kind === "credit" ? "Credit" : "Debit"} note
              </span>
              <span className="font-mono text-[11px] text-ink truncate">{n.id}</span>
              <span className="text-[11px] text-ink-3 capitalize">· {n.reason_code.replace(/_/g, " ")}</span>
            </span>
            <span className="flex items-center gap-3 shrink-0">
              <span className={`tabular-nums text-sm font-medium ${n.kind === "credit" ? "text-rose" : "text-indigo-ink"}`}>
                {n.kind === "credit" ? "−" : "+"} {rupee(n.amount)}
              </span>
              <span className="text-[11px] text-ink-3">{formatDate(n.date)}</span>
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
  const interState = isInterStateSupply(customer?.state_code, me?.tenantStateCode);

  if (isLoading || projLoading) return <div className="text-xs text-ink-3 italic">Loading receipts…</div>;

  // Project-sale invoice: render its project payments as the receipts.
  if (received.length === 0 && (projPays?.length ?? 0) > 0) {
    return (
      <div>
        <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-2">
          Payment receipts ({projPays!.length})
        </div>
        <ul className="space-y-1.5">
          {projPays!.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 rounded-md border border-hairline bg-paper px-3 py-2">
              <span className="flex items-center gap-2 min-w-0">
                <Icon name="receipt" size={14} className="text-amber-ink shrink-0" />
                <span className="text-xs text-ink capitalize">{p.method ?? "Payment"}{p.reference ? ` · ${p.reference}` : ""}</span>
                {p.bank_txn_id && <span className="text-[10px] text-emerald">· bank-reconciled</span>}
              </span>
              <span className="flex items-center gap-3 shrink-0">
                <span className="tabular-nums text-sm font-medium text-ink">{rupee(p.amount)}</span>
                <span className="text-[11px] text-ink-3">{formatDate(p.received_at)}</span>
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
      <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-2">
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
                <span className="text-[11px] text-ink-3 capitalize">· {p.method}</span>
              </span>
              <span className="flex items-center gap-3 shrink-0">
                <span className="tabular-nums text-sm font-medium text-ink">{rupee(p.amount)}</span>
                <span className="text-[11px] text-ink-3">{formatDate(p.received_at)}</span>
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
                           "bg-rose-soft border-rose/40 text-rose";
  return (
    <div className={`rounded-md border ${styles} p-3`}>
      <div className="text-[10px] uppercase tracking-wider font-semibold opacity-80">{label}</div>
      <div className="font-serif text-xl mt-0.5 tabular-nums">{count}</div>
      <div className="text-[11px] tabular-nums opacity-80 mt-0.5">{rupee(amount)}</div>
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
