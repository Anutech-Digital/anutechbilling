/**
 * Payments — money in, reconciled and ready for GST invoice.
 * Queries the `payments` table directly (supports multiple per quote = installments).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { getDocumentSignedUrl } from "@/lib/queries/documents";

/** Open a payment's attached receipt (private bucket → short-lived signed URL). */
async function openReceipt(path: string) {
  try {
    const url = await getDocumentSignedUrl(path);
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    toast.error("Could not open the receipt");
  }
}

import {
  usePayments,
  useDeletePayment,
  useOutstandingReceivables,
  useMarkReminderSent,
  useSuspendSubscription,
  useResumeSubscription,
  useWriteOffSubscription,
  type Payment,
  type OutstandingRow,
} from "@/lib/queries/payments";
import { useQuotes } from "@/lib/queries/quotes";
import { useAllProjectPayments } from "@/lib/queries/projects";
import { useCustomers } from "@/lib/queries/customers";
import { useBankAccounts } from "@/lib/queries/bank";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { ReceiptVoucherDialog } from "@/components/features/quotes/receipt-voucher-dialog";
import { EditPaymentDialog } from "@/components/features/quotes/edit-payment-dialog";
import { GeminiCard } from "@/components/shared/gemini-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { rupee, formatDate, bankLabel, cleanDisplayName } from "@/lib/utils";
import { useConfirm } from "@/components/providers/confirm-provider";

const STATUS_TABS: TabBarItem[] = [
  { id: "all",       label: "All" },
  { id: "received",  label: "Received",  dot: "emerald" },
  { id: "refunded",  label: "Refunded",  dot: "rose" },
];

const METHOD_META: Record<string, { label: string; icon: string }> = {
  upi:           { label: "UPI",        icon: "rupee" },
  razorpay:      { label: "Razorpay",   icon: "zap" },
  bank_transfer: { label: "Bank",       icon: "receipt" },
  cheque:        { label: "Cheque",     icon: "file" },
  cash:          { label: "Cash",       icon: "rupee" },
  other:         { label: "Other",      icon: "info" },
};

// Table columns (left→right) + fluid percentage widths. A dedicated LINKED DOCS
// column keeps the source quote / invoice / receipt out of the Status badge.
const PAY_COL_ORDER = ["date", "customer", "amount", "method", "reference", "linked", "status", "action"];
const PAY_COL_WIDTHS: Record<string, string> = {
  date: "10%", customer: "19%", amount: "12%", method: "13%", reference: "12%", linked: "16%", status: "10%", action: "8%",
};

export default function PaymentsPage() {
  const [tab, setTab]       = React.useState<"all" | "received" | "refunded">("all");
  const [view, setView]     = React.useState<"all" | "subscription" | "project">("all");
  const [search, setSearch] = React.useState("");
  // Payment currently open in the "edit details" sheet (null = closed).
  const [editPayment, setEditPayment] = React.useState<Payment | null>(null);

  const { data: payments, isLoading, error, refetch } = usePayments();
  const { data: projectPayments } = useAllProjectPayments();
  const { data: quotes } = useQuotes();
  const { data: outstanding } = useOutstandingReceivables();
  const { data: customers } = useCustomers();
  const { data: bankAccounts } = useBankAccounts();
  const { data: me } = useCurrentUser();
  const [kpiOpen, setKpiOpen] = React.useState(true);
  const confirm = useConfirm();

  // Lookup: bankAccountId → short label (for the "received in" hint on a row)
  const bankNameById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const a of bankAccounts ?? []) m.set(a.id, bankLabel(a.bank_name || a.name, a.account_number_last4));
    return m;
  }, [bankAccounts]);
  const markReminderSent  = useMarkReminderSent();
  const suspendSub        = useSuspendSubscription();
  const resumeSub         = useResumeSubscription();
  const writeOffSub       = useWriteOffSubscription();

  // Build a lookup: quoteId → quote (for customer name + status context)
  const quoteById = React.useMemo(() => {
    const m = new Map<string, { customerName: string; paymentStatus: string; invoiceId: string | null; customerId: string | null }>();
    for (const q of quotes ?? []) {
      m.set(q.id, {
        customerName:  q.customer_name,
        paymentStatus: q.payment_status,
        invoiceId:     q.invoice_id,
        customerId:    q.customer_id,
      });
    }
    return m;
  }, [quotes]);

  // Lookup: customerId → full customer record (for GSTIN, address, email on receipt voucher)
  const customerById = React.useMemo(() => {
    const m = new Map<string, NonNullable<typeof customers>[number]>();
    for (const c of customers ?? []) m.set(c.id, c);
    return m;
  }, [customers]);

  // Filter
  const filtered = (payments ?? []).filter((p) => {
    if (tab !== "all" && p.status !== tab) return false;
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    const quoteCtx = quoteById.get(p.quote_id);
    return (
      p.quote_id.toLowerCase().includes(s) ||
      (p.reference?.toLowerCase().includes(s) ?? false) ||
      p.method.toLowerCase().includes(s) ||
      (quoteCtx?.customerName.toLowerCase().includes(s) ?? false)
    );
  });

  const counts: Record<string, number> = { all: payments?.length ?? 0 };
  for (const p of payments ?? []) counts[p.status] = (counts[p.status] ?? 0) + 1;
  const tabsWithCounts = STATUS_TABS.map((t) => ({ ...t, count: counts[t.id] ?? 0 }));

  // KPIs — include project-sale payments so "collected" is ALL money in.
  const allReceived = (payments ?? []).filter((p) => p.status === "received");
  const projPays = projectPayments ?? [];
  const projCollected = projPays.reduce((s, p) => s + p.amount, 0);
  const totalCollected = allReceived.reduce((s, p) => s + p.amount, 0) + projCollected;

  // Awaiting-invoice: quotes with payment_status = 'received' (fully paid, no invoice yet)
  const awaitingInvoiceQuotes = (quotes ?? []).filter((q) => q.payment_status === "received");
  const awaitingInvoiceTotal = awaitingInvoiceQuotes.reduce((s, q) => s + (q.amount ?? 0), 0);

  // Partial payments (quotes with status=partial)
  const partialQuotes = (quotes ?? []).filter((q) => q.payment_status === "partial");

  const mtdStart = new Date(); mtdStart.setDate(1);
  const mtdCollected =
    allReceived.filter((p) => new Date(p.received_at) >= mtdStart).reduce((s, p) => s + p.amount, 0) +
    projPays.filter((p) => new Date(p.received_at) >= mtdStart).reduce((s, p) => s + p.amount, 0);

  // Method breakdown
  const methodBreakdown: Record<string, number> = {};
  for (const p of allReceived) {
    methodBreakdown[p.method] = (methodBreakdown[p.method] ?? 0) + 1;
  }
  const topMethod = Object.entries(methodBreakdown).sort((a, b) => b[1] - a[1])[0];

  // Real CSV export of the currently-filtered payments (hand this file to your
  // CA / accountant). Data is already in memory, so it's a plain Blob download —
  // no fake "coming soon".
  const handleExportCsv = () => {
    if (filtered.length === 0) { toast.info("No payments to export"); return; }
    const esc = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = ["Date", "Customer", "Quote", "Amount", "Method", "Reference", "Status", "Receipt Voucher"];
    const lines = filtered.map((p) => {
      const ctx = quoteById.get(p.quote_id);
      return [
        formatDate(p.received_at), ctx?.customerName ?? "", p.quote_id, String(p.amount),
        p.method ?? "", p.reference ?? "", p.status, p.receipt_voucher_no ?? "",
      ].map(esc).join(",");
    });
    const csv = [header.map(esc).join(","), ...lines].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `payments-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${filtered.length} payment${filtered.length === 1 ? "" : "s"} to CSV`);
  };

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Revenue</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Payments Received</h1>
          <p className="text-sm text-ink-3 mt-1">
            All payments received · partial / installments supported · ready for GST invoice
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button icon="download" onClick={handleExportCsv}>
            Export CSV
          </Button>
          <Button asChild variant="primary" icon="receipt">
            <Link href="/invoices">View Invoices →</Link>
          </Button>
        </div>
      </div>

      {/* All / Subscription / Project payments toggle (mirrors the Invoices page) */}
      <TabBar
        className="overflow-y-hidden"
        value={view}
        onChange={(v) => setView(v as "all" | "subscription" | "project")}
        items={[
          { id: "all",          label: "All payments", count: ((payments?.length ?? 0) + projPays.length) || undefined },
          { id: "subscription", label: "Subscription", count: (payments?.length ?? 0) || undefined },
          { id: "project",      label: "Project",      count: projPays.length || undefined },
        ]}
      />

      {(view === "subscription" || view === "all") && (<>
      {/* Collapsible Payments Analytics Banner */}
      {!isLoading && payments && (
        <div className="mb-4 bg-paper border border-hairline rounded-lg overflow-hidden transition-all shadow-xs">
          <button
            type="button"
            onClick={() => setKpiOpen((o) => !o)}
            className="w-full flex items-center justify-between px-3.5 py-2.5 bg-paper-2/70 hover:bg-paper-2 transition-colors text-left cursor-pointer"
          >
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <Icon name="bar_chart" size={15} className="text-amber-ink" />
              <span className="font-semibold text-ink">Payments &amp; Collections Analytics</span>
              <span className="text-ink-3">·</span>
              <span className="text-ink-2 font-mono font-medium">Collected MTD: <b className="text-emerald">{rupee(mtdCollected, { compact: true })}</b></span>
              <span className="text-ink-3 font-mono">·</span>
              <span className="text-ink-2 font-mono font-medium">Partial Quotes: <b className="text-amber-ink">{partialQuotes.length}</b></span>
              <span className="text-ink-3 font-mono">·</span>
              <span className="text-ink-2 font-mono font-medium">Awaiting Invoice: <b className="text-amber-ink">{rupee(awaitingInvoiceTotal, { compact: true })}</b> ({awaitingInvoiceQuotes.length})</span>
            </div>
            <div className="flex items-center gap-1 text-xs font-semibold text-amber-ink shrink-0 ml-2">
              <span>{kpiOpen ? "Collapse" : "Expand"}</span>
              <Icon name={kpiOpen ? "chevron_up" : "chevron_down"} size={14} />
            </div>
          </button>

          {kpiOpen && (
            <div className="p-3 border-t border-hairline bg-paper">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                  <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Collected MTD</p>
                  <p className="font-serif text-lg font-bold text-emerald tabular-nums mt-0.5">{rupee(mtdCollected, { compact: true })}</p>
                </div>
                <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                  <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Partial Quotes</p>
                  <p className="font-serif text-lg font-bold text-amber-ink tabular-nums mt-0.5">{partialQuotes.length}</p>
                </div>
                <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                  <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Awaiting GST Invoice</p>
                  <p className="font-serif text-lg font-bold text-amber-ink tabular-nums mt-0.5">{rupee(awaitingInvoiceTotal, { compact: true })} <span className="text-xs text-ink-3 font-normal">({awaitingInvoiceQuotes.length})</span></p>
                </div>
                <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                  <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Top Payment Method</p>
                  <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{topMethod ? METHOD_META[topMethod[0]]?.label ?? topMethod[0] : "—"}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Outstanding Receivables — actionable card ── */}
      {outstanding && outstanding.length > 0 && (() => {
        const totalDue = outstanding.reduce((s, o) => s + o.outstanding_amount, 0);
        const overdueCount = outstanding.filter((o) => o.days_outstanding > 30).length;
        return (
          <Card className="border-rose/30 bg-rose-soft/20">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
              <div className="flex items-center gap-2.5">
                <Icon name="alert" size={18} className="text-rose" />
                <div>
                  <h2 className="font-semibold text-ink">Subscription dues · {rupee(totalDue)}</h2>
                  <p className="text-xs text-ink-3">
                    {outstanding.length} subscription{outstanding.length === 1 ? "" : "s"} with a balance
                    {overdueCount > 0 && <> · <b className="text-rose">{overdueCount} overdue 30+ days</b></>}
                    {" · "}<Link href="/accounting/aging" className="text-amber-ink hover:text-amber">all receivables (incl. projects & invoices)</Link>
                  </p>
                </div>
              </div>
            </div>

            {/* Mobile card list — phones only. The desktop table's advanced
                money ops (suspend / write-off) stay desktop-only; mobile keeps
                the safe primary action (Record payment → the quote). */}
            <ul className="md:hidden space-y-2">
              {outstanding.map((o) => {
                const ageKind =
                  o.days_outstanding <= 7   ? "fresh"  :
                  o.days_outstanding <= 15  ? "warning" :
                  o.days_outstanding <= 30  ? "danger" : "danger";
                return (
                  <li key={o.subscription_id} className="rounded-lg border border-hairline bg-paper p-3">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-ink truncate">{o.customer_name}</p>
                        <p className="text-[11px] text-ink-3 truncate mt-0.5">{o.plan}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-serif text-base tabular-nums text-rose">{rupee(o.outstanding_amount)}</p>
                        <p className="text-[10px] text-ink-3">of {rupee(o.total_quote_amount)}</p>
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-hairline/60">
                      <div className="flex items-center gap-1.5">
                        <Badge kind={ageKind === "fresh" ? "muted" : ageKind === "warning" ? "warning" : "danger"} size="sm" dot>{o.days_outstanding}d</Badge>
                        <Badge kind={o.status === "active" ? "success" : o.status === "paused" ? "warning" : "muted"} size="sm">{o.status}</Badge>
                      </div>
                      {o.quote_id && (
                        <Button asChild size="sm" variant="primary" icon="rupee">
                          <Link href={`/quotes/${o.quote_id}` as any}>Record payment</Link>
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="hidden xl:block rounded-md border border-hairline bg-paper overflow-auto max-h-[calc(100vh-15rem)]">
              <table className="w-full">
                <thead className="sticky top-0 z-10 bg-paper-2 border-b border-hairline">
                  <tr>
                    <th className="text-left p-2 text-[10px] uppercase tracking-wider font-semibold text-ink-3">Customer</th>
                    <th className="text-right p-2 text-[10px] uppercase tracking-wider font-semibold text-ink-3">Paid</th>
                    <th className="text-right p-2 text-[10px] uppercase tracking-wider font-semibold text-ink-3">Balance due</th>
                    <th className="text-left p-2 text-[10px] uppercase tracking-wider font-semibold text-ink-3">Age</th>
                    <th className="text-left p-2 text-[10px] uppercase tracking-wider font-semibold text-ink-3">Status</th>
                    <th className="text-left p-2 text-[10px] uppercase tracking-wider font-semibold text-ink-3">Last reminder</th>
                    <th className="text-right p-2 text-[10px] uppercase tracking-wider font-semibold text-ink-3 w-72">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {outstanding.map((o) => (
                    <OutstandingRowView
                      key={o.subscription_id}
                      o={o}
                      onReminder={async () => {
                        await markReminderSent.mutateAsync(o.subscription_id);
                        const subject = `Payment reminder · ${rupee(o.outstanding_amount)} pending`;
                        const body =
                          `Hi ${o.customer_name},\n\nThis is a friendly reminder that ${rupee(o.outstanding_amount)} is still pending against ` +
                          `your subscription for ${o.plan} (started ${formatDate(o.first_payment_at)}).\n\n` +
                          `You've paid ${rupee(o.paid_amount)} of ${rupee(o.total_quote_amount)}.\n\n` +
                          `Please complete the payment at your earliest convenience to keep your service uninterrupted.\n\n— Anutech Digital`;
                        window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
                      }}
                      onSuspend={async () => {
                        if (await confirm({ title: `Pause subscription for ${o.customer_name}?`, body: "This pauses your service tracking. You'll need to suspend the actual licenses via Google CSP / M365 admin separately.", confirmLabel: "Pause" })) {
                          suspendSub.mutate(o.subscription_id);
                        }
                      }}
                      onResume={() => resumeSub.mutate(o.subscription_id)}
                      onWriteOff={() => {
                        const reason = prompt(`Write off ${rupee(o.outstanding_amount)} from ${o.customer_name}?\n\nThis cancels the subscription and marks the balance as uncollectable.\n\nReason (for audit):`);
                        if (reason && reason.trim().length > 0) {
                          writeOffSub.mutate({ id: o.subscription_id, reason: reason.trim() });
                        }
                      }}
                      recordPaymentHref={o.quote_id ? `/quotes/${o.quote_id}` : null}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[11px] text-ink-3 mt-2 flex items-center gap-1">
              <Icon name="info" size={11} />
              0–15 days: friendly reminder · 16–30 days: stronger nudge · 30+ days: consider suspending service · 60+ days: accept it as a loss (bad debt)
            </p>
          </Card>
        );
      })()}

      {/* Action needed — the two "close the loop" worklists (collect balance +
          generate the paid-but-uninvoiced GST invoices) merged into ONE compact
          card so they don't push the payment table down as two stacked bands. */}
      {!isLoading && (partialQuotes.length > 0 || awaitingInvoiceQuotes.length > 0) && (
        <GeminiCard title="Action needed to close the loop" compact>
          <ul className="space-y-2">
            {partialQuotes.length > 0 && (
              <li className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <b>{partialQuotes.length} partial payment{partialQuotes.length === 1 ? "" : "s"}</b> — collect the remaining balance from the customer.
                </span>
                <Button asChild size="sm" variant="default" icon="external" className="shrink-0">
                  <Link href={`/quotes/${partialQuotes[0].id}` as any}>Open</Link>
                </Button>
              </li>
            )}
            {awaitingInvoiceQuotes.length > 0 && (
              <li className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <b>{awaitingInvoiceQuotes.length} fully paid</b>, GST invoice not generated yet (₹{awaitingInvoiceTotal.toLocaleString("en-IN")} worth).
                </span>
                <Button asChild size="sm" variant="default" icon="receipt" className="shrink-0">
                  <Link href={`/quotes/${awaitingInvoiceQuotes[0].id}` as any}>Generate</Link>
                </Button>
              </li>
            )}
          </ul>
        </GeminiCard>
      )}

      {/* Sticky TabBar + Search */}
      {!isLoading && payments && (
        <div className="sticky top-[56px] z-20 bg-paper/95 backdrop-blur-md py-3 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 mb-4 border-b border-hairline transition-all space-y-3">
          <TabBar className="overflow-y-hidden" value={tab} onChange={(v) => setTab(v as typeof tab)} items={tabsWithCounts} />
          <div className="flex justify-between items-center gap-3 flex-wrap">
            <div className="text-xs text-ink-3">
              Showing {filtered.length} of {payments.length} payments · {rupee(totalCollected)} collected all-time
            </div>
            <div className="w-full sm:w-72">
              <Input
                prefix={<Icon name="search" size={14} />}
                placeholder="Quote ID, customer, reference, method…"
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
          title="Could not load payments"
          body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
        />
      )}

      {/* Loading */}
      {isLoading && (
        <Card flush>
          <table className="w-full">
            <tbody>
              {[1, 2, 3, 4].map((i) => (
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
      {!isLoading && !error && payments && payments.length === 0 && projPays.length === 0 && (
        <EmptyState
          icon="rupee"
          title="No payments yet"
          body="Once you record a payment on any quote, it shows up here for reconciliation and invoicing."
          action={
            <Button asChild icon="external">
              <Link href="/quotes">Go to Quotes</Link>
            </Button>
          }
        />
      )}

      {/* Filtered empty */}
      {!isLoading && !error && payments && payments.length > 0 && filtered.length === 0 && (
        <EmptyState
          icon="search"
          title="No payments match"
          body={search ? `No results for "${search}".` : `No payments with status "${tab}".`}
          action={<Button icon="x" onClick={() => { setTab("all"); setSearch(""); }}>Clear filters</Button>}
          compact
        />
      )}

      {/* Adaptive card list — viewports < 1280px */}
      {!isLoading && !error && filtered.length > 0 && (
        <ul className="xl:hidden space-y-2 mb-3">
          {filtered.map((p) => {
            const ctx = quoteById.get(p.quote_id);
            const customer = ctx?.customerId ? customerById.get(ctx.customerId) : undefined;
            return (
              <li key={p.id} className="bg-paper border border-hairline rounded-lg overflow-hidden">
                <Link
                  href={`/quotes/${p.quote_id}` as never}
                  className="block p-3 active:bg-paper-2/50"
                >
                  <div className="flex items-start justify-between gap-3 mb-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink truncate">
                        {cleanDisplayName(customer?.name ?? ctx?.customerName ?? "—")}
                      </p>
                      <p className="font-mono text-[11px] text-ink-3 mt-0.5">{p.quote_id}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-serif text-base tabular-nums text-ink">{rupee(p.amount)}</p>
                      <p className="text-[10px] text-ink-3">{p.method}</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-hairline/60 text-xs">
                    <span className="text-ink-3 truncate">
                      {p.received_at ? formatDate(p.received_at) : "—"}
                      {p.receipt_voucher_no && <> · <span className="font-mono">{p.receipt_voucher_no}</span></>}
                      {p.bank_account_id && bankNameById.get(p.bank_account_id) && (
                        <> · {bankNameById.get(p.bank_account_id)}</>
                      )}
                    </span>
                    <Badge
                      kind={p.status === "received" ? "success" : "danger"}
                      size="sm"
                      dot
                    >
                      {p.status}
                    </Badge>
                  </div>
                </Link>
                {(p.status === "received" || p.receipt_file_path) && (
                <div className="flex border-t border-hairline/60">
                  {p.status === "received" && (
                    <button
                      type="button"
                      onClick={() => setEditPayment(p)}
                      className="flex flex-1 items-center justify-center gap-1.5 py-2 text-xs font-medium text-ink-2 active:bg-paper-2"
                    >
                      <Icon name="edit" size={12} /> Edit details
                    </button>
                  )}
                  {p.receipt_file_path && (
                    <button
                      type="button"
                      onClick={() => openReceipt(p.receipt_file_path!)}
                      className="flex flex-1 items-center justify-center gap-1.5 py-2 text-xs font-medium text-ink-2 active:bg-paper-2 border-l border-hairline/60"
                    >
                      <Icon name="external" size={12} /> View receipt
                    </button>
                  )}
                </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Desktop table — viewports >= 1280px */}
      {!isLoading && !error && filtered.length > 0 && (
        <Card flush className="hidden xl:block">
          <table className="w-full table-fixed">
            <colgroup>
              {PAY_COL_ORDER.map((id) => <col key={id} style={{ width: PAY_COL_WIDTHS[id] }} />)}
            </colgroup>
            <thead className="bg-paper-2 border-b border-hairline-strong">
              <tr>
                <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Date</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Customer</th>
                <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Amount</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Method</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Reference</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Linked docs</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                <th className="px-2 py-2.5 text-right"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const ctx = quoteById.get(p.quote_id);
                const customer = ctx?.customerId ? customerById.get(ctx.customerId) : undefined;
                return (
                  <PaymentRowView
                    key={p.id}
                    p={p}
                    ctx={ctx}
                    customer={customer}
                    me={me}
                    bankLabel={p.bank_account_id ? bankNameById.get(p.bank_account_id) : undefined}
                    onEdit={() => setEditPayment(p)}
                  />
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* Help */}
      {!isLoading && payments && payments.length > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-ink-3">
          <Icon name="info" size={11} />
          A quote can have multiple payments (installments). Open the quote to see its full payment history.
        </div>
      )}
      </>)}

      {/* ── PROJECT payments view (also shown under "All") ── */}
      {(view === "project" || view === "all") && (
        projPays.length === 0 ? (
          view === "project" ? (
          <EmptyState icon="package" title="No project payments yet"
            body="Payments recorded against project milestones show here." />
          ) : null
        ) : (
        <Card flush>
          <div className="px-4 py-3 border-b border-hairline flex items-center gap-2">
            <Icon name="package" size={15} className="text-ink-3" />
            <h2 className="text-sm font-semibold text-ink">Project payments</h2>
            <span className="text-[11px] text-ink-3">· {rupee(projCollected)} collected</span>
          </div>

          {/* Mobile card list — phones only */}
          <ul className="md:hidden divide-y divide-hairline">
            {projPays.map((p) => (
              <li key={p.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    {p.customer_id ? (
                      <Link href={`/customers/${p.customer_id}` as never} className="font-medium text-ink hover:text-amber-ink hover:underline block truncate">{cleanDisplayName(p.customer_name)}</Link>
                    ) : (
                      <span className="font-medium text-ink block truncate">{cleanDisplayName(p.customer_name)}</span>
                    )}
                    <Link href={`/projects/${p.project_id}` as never} className="text-[11px] text-ink-2 hover:text-amber-ink hover:underline block truncate">{p.project_title}</Link>
                    <p className="text-[11px] text-ink-3 mt-0.5 capitalize">
                      {(p.method ?? "—").replace("_", " ")}{p.bank_txn_id ? " · reconciled" : ""} · {formatDate(p.received_at)}
                    </p>
                  </div>
                  <p className="font-serif text-base tabular-nums text-ink shrink-0">{rupee(p.amount)}</p>
                </div>
              </li>
            ))}
          </ul>

          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead className="bg-paper-2/50 text-[10px] uppercase tracking-wider text-ink-3">
                <tr>
                  <th className="text-left px-4 py-2">Customer / Project</th>
                  <th className="text-left px-3 py-2">Method</th>
                  <th className="text-right px-3 py-2">Amount</th>
                  <th className="text-left px-4 py-2">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {projPays.map((p) => (
                  <tr key={p.id} className="hover:bg-paper-2/40">
                    <td className="px-4 py-2.5">
                      {p.customer_id ? (
                        <Link href={`/customers/${p.customer_id}` as never} className="font-medium text-ink hover:text-amber-ink hover:underline">{cleanDisplayName(p.customer_name)}</Link>
                      ) : (
                        <span className="font-medium text-ink">{cleanDisplayName(p.customer_name)}</span>
                      )}
                      <span className="text-ink-3"> · </span>
                      <Link href={`/projects/${p.project_id}` as never} className="text-ink-2 hover:text-amber-ink hover:underline">{p.project_title}</Link>
                    </td>
                    <td className="px-3 py-2.5 text-ink-2 capitalize">{(p.method ?? "—").replace("_", " ")}{p.bank_txn_id ? " · reconciled" : ""}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium text-ink">{rupee(p.amount)}</td>
                    <td className="px-4 py-2.5 text-ink-2">{formatDate(p.received_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        )
      )}

      {/* Edit payment details (safe fields only — amount stays locked) */}
      <EditPaymentDialog
        open={!!editPayment}
        onOpenChange={(o) => { if (!o) setEditPayment(null); }}
        payment={editPayment}
        customerName={
          (editPayment && quoteById.get(editPayment.quote_id)?.customerName) || "Customer"
        }
      />
    </div>
  );
}

// ============================================================
// OutstandingRowView — single row in the outstanding receivables table
// ============================================================
function OutstandingRowView({
  o,
  onReminder,
  onSuspend,
  onResume,
  onWriteOff,
  recordPaymentHref,
}: {
  o: OutstandingRow;
  onReminder: () => void;
  onSuspend:  () => void;
  onResume:   () => void;
  onWriteOff: () => void;
  recordPaymentHref: string | null;
}) {
  const aging =
    o.days_outstanding <= 7   ? "fresh" :
    o.days_outstanding <= 15  ? "warn"  :
    o.days_outstanding <= 30  ? "urgent" : "overdue";
  const ageKind: "success" | "warning" | "danger" =
    aging === "fresh"   ? "success" :
    aging === "warn"    ? "warning" :
                          "danger";

  return (
    <tr className="border-b border-hairline last:border-0 hover:bg-paper-2/40">
      <td className="p-2">
        <div className="font-medium text-sm text-ink">{o.customer_name}</div>
        <div className="text-[10px] text-ink-3">{o.plan}</div>
      </td>
      <td className="p-2 text-right tabular-nums text-xs text-emerald">{rupee(o.paid_amount)}</td>
      <td className="p-2 text-right tabular-nums text-sm font-medium text-rose">{rupee(o.outstanding_amount)}</td>
      <td className="p-2">
        <Badge kind={ageKind} dot>{o.days_outstanding}d</Badge>
      </td>
      <td className="p-2">
        {o.status === "active" ? (
          <Badge kind="success" dot>Active</Badge>
        ) : o.status === "paused" ? (
          <Badge kind="warning" dot>Paused</Badge>
        ) : (
          <Badge kind="muted">{o.status}</Badge>
        )}
      </td>
      <td className="p-2 text-xs text-ink-3">
        {o.last_reminder_at ? formatDate(o.last_reminder_at) : <span className="italic">never</span>}
      </td>
      <td className="p-2 text-right">
        <div className="flex justify-end gap-1 flex-wrap">
          {recordPaymentHref && (
            <Button asChild size="sm" variant="primary" icon="rupee">
              <Link href={recordPaymentHref as any}>Pay</Link>
            </Button>
          )}
          <Button size="sm" icon="mail" onClick={onReminder}>
            Remind
          </Button>
          {o.status === "active" ? (
            <Button size="sm" variant="ghost" onClick={onSuspend}>Suspend</Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={onResume}>Resume</Button>
          )}
          {o.days_outstanding > 30 && (
            <Button size="sm" variant="ghost" className="!text-rose hover:!bg-rose/10" onClick={onWriteOff}>
              Write off
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

function PaymentRowView({
  p,
  ctx,
  customer,
  me,
  bankLabel,
  onEdit,
}: {
  p: Payment;
  ctx?: { customerName: string; paymentStatus: string; invoiceId: string | null; customerId: string | null };
  customer?: {
    name:           string;
    gstin:          string | null;
    contact_email:  string | null;
    state:          string | null;
    state_code:     string | null;
  };
  me?: ReturnType<typeof useCurrentUser>["data"];
  bankLabel?: string;
  onEdit: () => void;
}) {
  const router = useRouter();
  const methodInfo = METHOD_META[p.method];
  const [receiptOpen, setReceiptOpen] = React.useState(false);
  // When a delete is blocked (invoice issued / bank-reconciled / add-seats / etc.),
  // don't dead-end: show the reason AND a button to where the next step happens
  // (the quote, which lists the exact blocking records + how to clear them).
  const del = useDeletePayment({
    onBlocked: (msg) =>
      toast.error(msg, {
        description: "Yahin se nahi hata sakte — quote khol ke aage ka step wahan se karo.",
        action: { label: "Open quote", onClick: () => router.push(`/quotes/${p.quote_id}` as any) },
      }),
  });
  const confirm = useConfirm();

  // Delete = correct a wrong entry. Explains the reversal, then reverses via RPC
  // (guards block if a GST invoice was issued / it's bank-reconciled).
  const handleDelete = async () => {
    const body = `This reverses it: the quote's paid amount + the subscription's outstanding are recalculated. `
      + `If it's the only payment, the subscription + auto-created purchase order from this sale are removed too (the customer is kept).\n\n`
      + `Blocked if a GST invoice was already generated, or it's reconciled to a bank line — handle those first.`;
    if (await confirm({
      title: `Delete this ${rupee(p.amount)} payment on ${p.quote_id}?`,
      body,
      confirmLabel: "Delete",
      danger: true,
    })) del.mutate(p.id);
  };

  // Inter-state if customer's state-code differs from tenant's. Default = intra-state.
  const interState = Boolean(
    customer?.state_code &&
    me?.tenantStateCode &&
    customer.state_code !== me.tenantStateCode,
  );

  const customerName = cleanDisplayName(ctx?.customerName ?? "—");
  return (
    <tr
      className="group border-b border-hairline last:border-0 hover:bg-paper-2/50 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset"
      role="button"
      tabIndex={0}
      aria-label={`Open quote ${p.quote_id}`}
      onClick={() => router.push(`/quotes/${p.quote_id}` as any)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push(`/quotes/${p.quote_id}` as any); } }}
    >
      <td className="px-3 py-2.5 text-xs text-ink-2 whitespace-nowrap align-top">{formatDate(p.received_at)}</td>
      <td className="px-3 py-2.5 text-sm font-medium align-top" onClick={(e) => e.stopPropagation()}>
        {ctx?.customerId ? (
          <Link href={`/customers/${ctx.customerId}` as never} className="text-ink hover:text-amber-ink hover:underline break-words leading-snug">{customerName}</Link>
        ) : (
          <span className="text-ink break-words leading-snug">{customerName}</span>
        )}
      </td>
      {/* Amount — cash in, the happiest number; give it weight. */}
      <td className="px-3 py-2.5 text-right tabular-nums align-top">
        <span className="font-serif text-[15px] font-semibold text-emerald">{rupee(p.amount)}</span>
      </td>
      <td className="px-3 py-2.5 align-top">
        {methodInfo ? (
          <span className="inline-flex items-center gap-1.5 text-xs">
            <Icon name={methodInfo.icon} size={11} className="text-ink-3" />
            {methodInfo.label}
          </span>
        ) : (
          <span className="text-xs text-ink-3">{p.method}</span>
        )}
        {bankLabel && (
          <div className="text-[10px] text-ink-3 mt-0.5 flex items-center gap-1 truncate">
            <Icon name="receipt" size={9} className="shrink-0" /> <span className="truncate">{bankLabel}</span>
          </div>
        )}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-ink-2 break-all align-top" title={p.reference ?? undefined}>{p.reference ?? "—"}</td>
      {/* LINKED DOCS — source quote + GST invoice + receipt voucher as clickable
          chips, so the Status column stays a clean single badge. */}
      <td className="px-3 py-2.5 align-top" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col gap-1 items-start">
          <Link href={`/quotes/${p.quote_id}` as any} className="inline-flex items-center rounded-md bg-paper-2 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-ink hover:text-amber-ink" title={p.quote_id}>
            {p.quote_id}
          </Link>
          {ctx?.invoiceId && (
            <Link href={`/invoices?open=${ctx.invoiceId}` as any} className="font-mono text-[10px] text-indigo-ink hover:underline" title="Open GST invoice">{ctx.invoiceId}</Link>
          )}
          {p.receipt_voucher_no && (
            me
              ? <button type="button" onClick={() => setReceiptOpen(true)} className="font-mono text-[10px] text-ink-3 hover:text-amber-ink hover:underline" title="Open receipt voucher">{p.receipt_voucher_no}</button>
              : <span className="font-mono text-[10px] text-ink-3">{p.receipt_voucher_no}</span>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 align-top">
        {p.status === "received" ? (
          <Badge kind="success" dot>received</Badge>
        ) : (
          <Badge kind="danger" dot>refunded</Badge>
        )}
      </td>
      <td className="px-2 py-2.5 text-right align-top" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Payment actions"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2 data-[state=open]:text-ink"
              >
                <Icon name="more_h" size={20} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[12rem]">
              <DropdownMenuLabel>Actions</DropdownMenuLabel>
              <DropdownMenuItem asChild className="gap-2.5 py-2 cursor-pointer">
                <Link href={`/quotes/${p.quote_id}` as any}>
                  <Icon name="external" size={16} /> Open quote
                </Link>
              </DropdownMenuItem>
              {p.status === "received" && (
                <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={onEdit}>
                  <Icon name="edit" size={16} /> Edit details
                </DropdownMenuItem>
              )}
              {p.status === "received" && me && (
                <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setReceiptOpen(true)}>
                  <Icon name="file" size={16} /> Receipt voucher
                </DropdownMenuItem>
              )}
              {p.receipt_file_path && (
                <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => openReceipt(p.receipt_file_path!)}>
                  <Icon name="external" size={16} /> View attached receipt
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer text-rose" onClick={handleDelete}>
                <Icon name="trash" size={16} /> Delete payment
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {me && (
          <ReceiptVoucherDialog
            open={receiptOpen}
            onOpenChange={setReceiptOpen}
            payment={p}
            customerName={customer?.name ?? ctx?.customerName ?? "Customer"}
            customerGstin={customer?.gstin}
            customerEmail={customer?.contact_email}
            tenantName={me.tenantName}
            tenantGstin={me.tenantGstin}
            tenantEmail={me.tenantEmail}
            tenantPhone={me.tenantPhone}
            tenantAddress={me.tenantAddress}
            tenantState={me.tenantState}
            interState={interState}
            quoteId={p.quote_id}
          />
        )}
      </td>
    </tr>
  );
}
