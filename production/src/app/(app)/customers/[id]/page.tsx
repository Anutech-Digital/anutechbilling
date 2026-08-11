/**
 * Customer 360 — full detail page, "answers-first" (same blueprint as the
 * master-detail CustomerPanel, composed from the shared customer-insights
 * building blocks so the two surfaces never drift).
 *
 * Removed the old fake data: stub "Customer added" activity, hardcoded
 * "Account manager: Pardeep Sharma", and dead Note/Log-call/New-activity
 * buttons. Everything here is now derived from real rows (compass: no
 * fabricated numbers, no fake timeline).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";

import { useCustomer, useDeleteCustomer, useSetCustomerActive, useCustomerOpenCredit, customerDeleteBlockReason } from "@/lib/queries/customers";
import { useCustomerGroups } from "@/lib/queries/customer-groups";
import { useCustomerSubscriptions } from "@/lib/queries/subscriptions";
import { useCustomerInvoices, useCustomerQuotes } from "@/lib/queries/invoices";
import { usePayments, useDeletePayment } from "@/lib/queries/payments";
import { useCustomerProjects, useCustomerProjectPayments } from "@/lib/queries/projects";
import { CreateProjectQuoteDialog } from "@/components/features/projects/create-project-quote-dialog";
import { Card } from "@/components/ui/card";
import { Button, IconButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { TabBar } from "@/components/ui/tabs";
import { Icon } from "@/components/ui/icon";
import { formatDate, rupee, daysBetween, cn } from "@/lib/utils";
import {
  deriveCustomerInsights,
  CustomerMetricBar,
  NextBestActionCard,
  SubscriptionList,
  CustomerActivity,
  CustomerIdentityRail,
} from "@/components/features/customers/customer-insights";
import { AddReferralDialog } from "@/components/features/referrals/add-referral-dialog";
import { useReferralAgreements } from "@/lib/queries/referral-partners";
import { InvoiceChooserDialog } from "@/components/features/invoices/invoice-chooser-dialog";
import { DeleteBlockedDialog } from "@/components/shared/delete-blocked-dialog";
import { useConfirm } from "@/components/providers/confirm-provider";

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const confirm = useConfirm();

  const { data: customer, isLoading, error } = useCustomer(params.id);
  const { data: allGroups } = useCustomerGroups();
  const { data: subs }     = useCustomerSubscriptions(params.id);
  const { data: invoices } = useCustomerInvoices(params.id);
  const { data: quotes }   = useCustomerQuotes(params.id);
  const { data: projects } = useCustomerProjects(params.id);
  const { data: projPay } = useCustomerProjectPayments(params.id);
  const { data: openCredit } = useCustomerOpenCredit(params.id);
  const { data: allPayments } = usePayments();

  const searchParams = useSearchParams();
  const [mainTab, setMainTab] = React.useState<"overview" | "transactions" | "statement">("overview");
  // Segment filter inside the Transactions tab so quotes / invoices / payments
  // can each be viewed on their own (not just the combined feed).
  const [txnFilter, setTxnFilter] = React.useState<"all" | "invoices" | "quotes" | "payments" | "projects">("all");
  // Collapsed parent keys in the hierarchical "All" view (default: all expanded).
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const toggleCollapse = (key: string) => setCollapsed((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const [svcView, setSvcView] = React.useState<"subscription" | "project">("subscription");
  const [projQuoteOpen, setProjQuoteOpen] = React.useState(false);
  const [referralOpen, setReferralOpen] = React.useState(false);
  const [invoiceOpen, setInvoiceOpen] = React.useState(false);
  const [projInvoiceOpen, setProjInvoiceOpen] = React.useState(false);
  const { data: agreements } = useReferralAgreements(params.id);
  const deleteCustomer = useDeleteCustomer();
  const setActive = useSetCustomerActive();
  // Blocked-delete dialog (dependency-aware): when a payment can't be deleted
  // because a document depends on it, show what's linked + where to resolve it.
  const [payBlock, setPayBlock] = React.useState<string | null>(null);
  const deletePayment = useDeletePayment({ onBlocked: (msg) => setPayBlock(msg) });

  // Delete a customer payment (from the Transactions tab). The delete_payment RPC
  // reverses balances and blocks if unsafe (GST invoice issued / bank-reconciled).
  async function handleDeletePayment(id: string) {
    if (!(await confirm({ title: "Delete this payment?", body: "This reverses the receipt and increases the customer's outstanding again. It can't be undone.", confirmLabel: "Delete", danger: true }))) return;
    deletePayment.mutate(id);
  }

  // Deep-link: /customers/[id]?edit=1 sends straight to the full-page edit form
  // (used by the "Complete customer" nudge on a project with missing GST info).
  const editParamHandled = React.useRef(false);
  React.useEffect(() => {
    if (editParamHandled.current) return;
    if (searchParams.get("edit") === "1") {
      editParamHandled.current = true;
      router.replace(`/customers/${params.id}/edit` as never);
    }
  }, [searchParams, router, params.id]);

  if (isLoading) {
    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto space-y-6">
        <div className="flex items-start gap-3">
          <Skeleton className="h-12 w-12 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-8 w-64" />
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
        </div>
        <div className="grid lg:grid-cols-[1.5fr_1fr] gap-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (error || !customer) {
    return (
      <div className="p-8 max-w-[1240px] mx-auto">
        <EmptyState
          icon="alert"
          title={error ? "Could not load customer" : "Customer not found"}
          body={error?.message ?? "This customer does not exist in your tenant."}
          action={
            <Button asChild variant="primary" icon="users">
              <Link href={"/customers" as any}>Back to customers</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const c = customer;
  const allSubs = subs ?? [];
  const allInvoices = invoices ?? [];
  const allQuotes = quotes ?? [];
  const allProjects = projects ?? [];
  const customerPayments = (allPayments ?? []).filter((p) => p.customer_id === c.id);
  const receivedPaymentsTotal = customerPayments
    .filter((p) => p.status === "received")
    .reduce((s, p) => s + (p.amount ?? 0), 0);
  const insights = deriveCustomerInsights(c, allSubs, allInvoices, allProjects, allQuotes, receivedPaymentsTotal);

  // Project milestone receipts live in project_payments (not `payments`) — pull
  // them so the customer's Transactions/Statement + a project invoice's status
  // reflect them (else a part-paid project invoice looks fully "Pending" here).
  const invoicePaid = projPay?.invoicePaid ?? {};
  const projPayments = projPay?.payments ?? [];

  // Unified transactions feed (Zoho "Transactions" tab) — every money record.
  const txns = [
    ...allInvoices.map((i) => {
      // A project invoice's real state comes from project_payments against its
      // milestone: fully covered = paid, some = partially paid, else its own status.
      const pPaid = invoicePaid[i.id] ?? 0;
      const status = pPaid <= 0 ? i.status : pPaid >= i.amount ? "paid" : "partially paid";
      return { date: i.invoice_date, type: "Invoice" as const, ref: i.id, amount: i.amount, status, onClick: undefined as (() => void) | undefined };
    }),
    ...customerPayments.map((p) => ({ date: p.status === "refunded" ? (p.refunded_at ?? p.received_at) : p.received_at, type: p.status === "refunded" ? ("Refund" as const) : ("Payment" as const), ref: p.receipt_voucher_no ?? p.id, amount: p.amount, status: p.status, onClick: undefined as (() => void) | undefined, payId: p.id })),
    // Project milestone receipts — show as Payment rows so they're not invisible.
    ...projPayments.map((p) => ({ date: p.received_at, type: "Payment" as const, ref: p.reference?.trim() || p.project_title, amount: p.amount, status: p.bank_txn_id ? "reconciled" : "received", onClick: undefined as (() => void) | undefined })),
    ...allQuotes.map((q) => ({ date: q.created_date, type: "Quote" as const, ref: q.id, amount: q.amount, status: q.status, onClick: () => router.push(`/quotes/${q.id}` as never) })),
    ...allProjects.map((p) => ({ date: p.created_at, type: "Project" as const, ref: p.title, amount: p.total_amount, status: p.status, onClick: () => router.push(`/projects/${p.id}` as never) })),
  ].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  // Hierarchical view (the "All" tab): Project → its invoices → their receipts,
  // so the relationship is obvious. Standalone invoices / subscription payments /
  // quotes sit at the top level. indent drives the left-inset in the render.
  const invoiceProject = projPay?.invoiceProject ?? {};
  type HRow = {
    key: string; parentKey: string | null; indent: number;
    date: string; type: "Invoice" | "Payment" | "Refund" | "Quote" | "Project";
    ref: string; amount: number; status: string; due?: number; onClick?: () => void;
    /** Set only on rows from the `payments` table → enables the delete action. */
    payId?: string;
  };
  const hierRows: HRow[] = [];
  const usedInv = new Set<string>();
  const usedPay = new Set<string>();
  for (const pr of allProjects) {
    const projKey = `proj:${pr.id}`;
    const projDue = Math.max(0, (pr.total_amount ?? 0) - (pr.paid ?? 0));
    hierRows.push({ key: projKey, parentKey: null, indent: 0, date: pr.created_at, type: "Project", ref: pr.title, amount: pr.total_amount, status: pr.status, due: projDue > 0 ? projDue : undefined, onClick: () => router.push(`/projects/${pr.id}` as never) });
    for (const i of allInvoices.filter((iv) => invoiceProject[iv.id]?.projectId === pr.id)) {
      usedInv.add(i.id);
      const pPaid = invoicePaid[i.id] ?? 0;
      const st = pPaid <= 0 ? i.status : pPaid >= i.amount ? "paid" : "partially paid";
      const invKey = `inv:${i.id}`;
      hierRows.push({ key: invKey, parentKey: projKey, indent: 1, date: i.invoice_date, type: "Invoice", ref: i.id, amount: i.amount, status: st, due: pPaid > 0 && pPaid < i.amount ? i.amount - pPaid : undefined });
      for (const p of projPayments.filter((pp) => pp.invoice_id === i.id)) {
        usedPay.add(p.id);
        hierRows.push({ key: `pay:${p.id}`, parentKey: invKey, indent: 2, date: p.received_at, type: "Payment", ref: p.reference?.trim() || "Payment", amount: p.amount, status: p.bank_txn_id ? "reconciled" : "received" });
      }
    }
    // Advance receipts recorded before their milestone was invoiced.
    for (const p of projPayments.filter((pp) => pp.project_id === pr.id && !pp.invoice_id && !usedPay.has(pp.id))) {
      usedPay.add(p.id);
      hierRows.push({ key: `pay:${p.id}`, parentKey: projKey, indent: 1, date: p.received_at, type: "Payment", ref: p.reference?.trim() || "Advance", amount: p.amount, status: p.bank_txn_id ? "reconciled" : "received" });
    }
  }
  for (const i of allInvoices.filter((iv) => !usedInv.has(iv.id))) {
    hierRows.push({ key: `inv:${i.id}`, parentKey: null, indent: 0, date: i.invoice_date, type: "Invoice", ref: i.id, amount: i.amount, status: i.status });
  }
  for (const p of customerPayments) {
    hierRows.push({ key: `cpay:${p.id}`, parentKey: null, indent: 0, date: p.status === "refunded" ? (p.refunded_at ?? p.received_at) : p.received_at, type: p.status === "refunded" ? "Refund" : "Payment", ref: p.receipt_voucher_no ?? p.id, amount: p.amount, status: p.status, payId: p.id });
  }
  for (const q of allQuotes) {
    hierRows.push({ key: `q:${q.id}`, parentKey: null, indent: 0, date: q.created_date, type: "Quote", ref: q.id, amount: q.amount, status: q.status, onClick: () => router.push(`/quotes/${q.id}` as never) });
  }
  // Which rows are parents (have children) + parent lookup for the collapse walk.
  const parentOf: Record<string, string | null> = {};
  const hasKids = new Set<string>();
  for (const r of hierRows) { parentOf[r.key] = r.parentKey; if (r.parentKey) hasKids.add(r.parentKey); }

  // Running-balance ledger (Zoho "Statement" tab). Invoice = debit (owed),
  // payment = credit; positive closing balance = receivable still owed.
  const ledgerRaw = [
    ...allInvoices.map((i) => ({ date: i.invoice_date, desc: `Invoice ${i.id}`, debit: i.amount, credit: 0 })),
    ...customerPayments.filter((p) => p.status === "received").map((p) => ({ date: p.received_at, desc: `Payment received${p.receipt_voucher_no ? ` · ${p.receipt_voucher_no}` : ""}`, debit: 0, credit: p.amount })),
    ...customerPayments.filter((p) => p.status === "refunded").map((p) => ({ date: p.refunded_at ?? p.received_at, desc: `Refund${p.receipt_voucher_no ? ` · ${p.receipt_voucher_no}` : ""}`, debit: p.amount, credit: 0 })),
    // Project milestone receipts credit the ledger against their raised invoices.
    ...projPayments.map((p) => ({ date: p.received_at, desc: `Payment received · ${p.reference?.trim() || p.project_title}`, debit: 0, credit: p.amount })),
  ].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  let runningBal = 0;
  const ledger = ledgerRaw.map((e) => { runningBal += e.debit - e.credit; return { ...e, balance: runningBal }; });
  const closingBalance = runningBal;

  // Guarded delete — Zoho-Books parity: a customer can be hard-deleted ONLY when
  // it is truly empty (no subscriptions, payments, invoices, quotes, or projects).
  // The delete_customer RPC (0174) is the authority; this client twin explains the
  // block. The Delete button stays CLICKABLE (a disabled button + hover tooltip is
  // invisible on touch/embeds) — on click it shows a clear dialog offering Archive.
  const deleteBlock = customerDeleteBlockReason({
    subscriptions: allSubs.length,
    payments: customerPayments.length,
    invoices: allInvoices.length,
    quotes: allQuotes.length,
    projects: allProjects.length,
  });
  const handleDelete = async () => {
    if (deleteBlock) {
      // Has documents → can't hard-delete. Explain why, and offer Archive (unless
      // it's already archived, in which case just acknowledge).
      const alreadyArchived = c.is_active === false;
      const archived = await confirm({
        title: `Can't delete "${c.name}"`,
        body: deleteBlock,
        confirmLabel: alreadyArchived ? "OK" : "Archive instead",
        icon: "inbox",
      });
      if (archived && !alreadyArchived) {
        setActive.mutate({ id: c.id, isActive: false });
      }
      return;
    }
    if (await confirm({ title: `Permanently delete customer "${c.name}"?`, body: "This cannot be undone.", confirmLabel: "Delete", danger: true })) {
      deleteCustomer.mutate(
        { id: c.id, customer_number: c.customer_number },
        { onSuccess: () => router.push("/customers" as never) }
      );
    }
  };

  const tenureDays = daysBetween(c.since, new Date());
  const tenure =
    tenureDays >= 365 ? `${Math.floor(tenureDays / 365)}y ${Math.floor((tenureDays % 365) / 30)}mo`
    : tenureDays >= 30 ? `${Math.floor(tenureDays / 30)}mo`
    : `${Math.max(tenureDays, 0)}d`;

  const TXN_BADGE: Record<string, "info" | "success" | "danger" | "muted" | "warning"> = {
    Invoice: "info", Payment: "success", Refund: "danger", Quote: "muted", Project: "warning",
  };

  // Transactions segment filter — view invoices / quotes / payments separately.
  const txnInFilter = (type: string) =>
    txnFilter === "all" ? true
    : txnFilter === "invoices" ? type === "Invoice"
    : txnFilter === "quotes"   ? type === "Quote"
    : txnFilter === "payments" ? (type === "Payment" || type === "Refund")
    : txnFilter === "projects" ? type === "Project"
    : true;
  const txnSegments = [
    { id: "all" as const,      label: "All",      n: txns.length },
    { id: "invoices" as const, label: "Invoices", n: txns.filter((t) => t.type === "Invoice").length },
    { id: "quotes" as const,   label: "Quotes",   n: txns.filter((t) => t.type === "Quote").length },
    { id: "payments" as const, label: "Payments", n: txns.filter((t) => t.type === "Payment" || t.type === "Refund").length },
    { id: "projects" as const, label: "Projects", n: txns.filter((t) => t.type === "Project").length },
  ].filter((s) => s.id === "all" || s.n > 0);
  const filteredTxns = txns.filter((t) => txnInFilter(t.type));

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto">
      {/* Header — identity + real contact actions */}
      <div className="flex items-start justify-between gap-3 flex-wrap mb-6">
        <div className="flex items-start gap-3 min-w-0">
          <IconButton icon="arrow_left" aria-label="Back" onClick={() => router.push("/customers" as any)} />
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
              Customer · since {formatDate(c.since)} · {tenure}
            </p>
            <h1 className="font-serif text-3xl md:text-4xl leading-tight">{c.display_name || c.name}</h1>
            {(c.contact_name || c.domain) && (
              <p className="mt-1 text-sm text-ink-3">
                {c.contact_name}{c.contact_name && c.contact_title ? ` · ${c.contact_title}` : ""}
                {c.contact_name && c.domain ? "  ·  " : ""}
                {c.domain && <span className="font-mono text-xs">{c.domain}</span>}
              </p>
            )}
            {c.group_id && (() => {
              const g = (allGroups ?? []).find((x) => x.id === c.group_id);
              return g ? (
                <Link href={`/customers/groups/${g.id}` as never} className="mt-1.5 inline-flex items-center gap-1 text-xs text-amber hover:underline">
                  <Icon name="layout" size={12} /> Part of group: {g.name}
                </Link>
              ) : null;
            })()}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <Button icon="award" onClick={() => setReferralOpen(true)}>
            {(agreements ?? []).some((a) => a.status === "active") ? "Referral ✓" : "Add referral"}
          </Button>
          <Button icon="edit" onClick={() => router.push(`/customers/${c.id}/edit` as never)}>Edit</Button>
          <Button icon="receipt" onClick={() => setInvoiceOpen(true)}>Invoice</Button>
          <Button variant="primary" icon="plus" onClick={() => router.push(`/quotes/new?customer=${c.id}` as any)}>New quote</Button>
          {/* Archive / reactivate — the money-safe alternative to delete. Works
              even when the customer has invoices/payments (records are kept). */}
          <Button
            icon="inbox"
            variant="ghost"
            loading={setActive.isPending}
            onClick={async () => {
              const next = c.is_active === false;
              if (next || (await confirm({ title: `Archive "${c.name}"?`, body: "They'll be hidden from your active customers (all invoices/payments are kept). You can reactivate anytime.", confirmLabel: "Archive", icon: "inbox" }))) {
                setActive.mutate({ id: c.id, isActive: next });
              }
            }}
            title={c.is_active === false ? "Reactivate this customer" : "Archive (hide from active list)"}
          >
            {c.is_active === false ? "Reactivate" : "Archive"}
          </Button>
          <Button
            icon="trash"
            variant="ghost"
            onClick={handleDelete}
            loading={deleteCustomer.isPending}
            title={deleteBlock ? "This customer has documents — click to see options" : "Delete this customer"}
            className="!text-rose hover:!bg-rose/10"
          >
            Delete
          </Button>
        </div>
      </div>

      {/* Top tabs — Zoho-style customer 360 */}
      <TabBar
        value={mainTab}
        onChange={(v) => setMainTab(v as "overview" | "transactions" | "statement")}
        items={[
          { id: "overview",     label: "Overview" },
          { id: "transactions", label: "Transactions", count: txns.length || undefined },
          { id: "statement",    label: "Statement" },
        ]}
        className="mb-5 overflow-y-hidden"
      />

      {mainTab === "overview" && (
      <>
      {/* Answer-bar */}
      <div className="mb-4">
        <CustomerMetricBar insights={insights} />
      </div>

      {/* Advance credit held (from an earlier overpayment) — adjustable against the next bill */}
      {(openCredit ?? 0) > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-emerald/30 bg-emerald-soft/40 px-3 py-2 text-sm">
          <Icon name="rupee" size={15} className="text-emerald flex-shrink-0" />
          <span className="text-ink">
            <b>{rupee(openCredit ?? 0)}</b> advance credit — will be offered to adjust against this customer's next payment.
          </span>
        </div>
      )}

      {/* Next-best-action */}
      <div className="mb-6">
        <NextBestActionCard nba={insights.nba} customer={c} />
      </div>

      {/* Body — identity rail (Zoho-style) on the left, money + activity on the right */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,340px)_1fr] gap-5">
        {/* LEFT — who / where / tax + billing details */}
        <CustomerIdentityRail c={c} />

        {/* RIGHT — subscriptions + activity */}
        <div className="space-y-4 min-w-0">
          <Card
            title="Subscriptions & projects"
            sub={svcView === "subscription"
              ? (allSubs.length > 0 ? `${insights.activeSubs.length} active` : undefined)
              : ((projects ?? []).length > 0 ? `${(projects ?? []).length} project${(projects ?? []).length > 1 ? "s" : ""}` : undefined)}
            actions={
              <Button
                size="sm"
                variant="primary"
                icon="plus"
                onClick={() =>
                  svcView === "project"
                    ? setProjQuoteOpen(true)
                    : router.push(`/quotes/new?customer=${c.id}` as any)
                }
              >
                {svcView === "project" ? "New project quote" : "New subscription"}
              </Button>
            }
          >
            <div className="mb-3">
              <TabBar
                value={svcView}
                onChange={(v) => setSvcView(v as "subscription" | "project")}
                items={[
                  { id: "subscription", label: "Subscription", count: allSubs.length || undefined },
                  { id: "project",      label: "Project",      count: (projects ?? []).length || undefined },
                ]}
              />
            </div>

            {svcView === "subscription" && <SubscriptionList subs={allSubs} />}

            {svcView === "project" && (
              (projects ?? []).length > 0 ? (
                <RecordTable
                  head={["Project", "Total (incl GST)", "Outstanding", "Status", "Created"]}
                  rows={(projects ?? []).map((p) => ({
                    onClick: () => router.push(`/projects/${p.id}` as any),
                    cells: [
                      <span key="t" className="font-medium">{p.title}</span>,
                      <span key="tot" className="tabular-nums font-medium">{rupee(p.total_amount)}</span>,
                      <span key="out" className={`tabular-nums ${p.receivable > 0 ? "text-rose" : "text-emerald"}`}>{rupee(p.receivable)}</span>,
                      <Badge key="b" kind={p.status === "completed" ? "success" : p.status === "cancelled" ? "muted" : p.status === "quoted" ? "info" : "warning"} dot>
                        {p.status === "quoted" ? "Quotation" : p.status}
                      </Badge>,
                      formatDate(p.created_at),
                    ],
                  }))}
                />
              ) : (
                <p className="text-sm text-ink-3 py-6 text-center">No projects for this customer yet.</p>
              )
            )}
          </Card>

          <Card title="Recent activity">
            <CustomerActivity subs={allSubs} invoices={allInvoices} quotes={allQuotes} limit={12} />
          </Card>
        </div>
      </div>
      </>
      )}

      {/* ─────────── Transactions — every money record ─────────── */}
      {mainTab === "transactions" && (
        <Card flush>
          <div className="p-4">
            {txns.length > 0 ? (
              <>
                {/* Segment filter — invoices / quotes / payments each on their own. */}
                <div className="flex flex-wrap gap-2 mb-4">
                  {txnSegments.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={txnFilter === s.id}
                      onClick={() => setTxnFilter(s.id)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
                        txnFilter === s.id
                          ? "border-amber bg-amber-soft text-amber-ink"
                          : "border-hairline text-ink-3 hover:text-ink hover:bg-paper-2",
                      )}
                    >
                      {s.label}
                      <span className={cn("tabular-nums", txnFilter === s.id ? "text-amber-ink" : "text-ink-3")}>{s.n}</span>
                    </button>
                  ))}
                </div>
                {filteredTxns.length > 0 ? (
                  <RecordTable
                    head={["Date", "Type", "Reference", "Amount", "Status", ""]}
                    rows={(txnFilter === "all"
                      // Hierarchical: hide a row if any ancestor is collapsed.
                      ? hierRows.filter((r) => {
                          let pk = r.parentKey;
                          while (pk) { if (collapsed.has(pk)) return false; pk = parentOf[pk] ?? null; }
                          return true;
                        })
                      : filteredTxns.map((t) => ({ key: "", parentKey: null, indent: 0, due: undefined, ...t }))
                    ).map((t) => {
                      const canExpand = txnFilter === "all" && hasKids.has(t.key);
                      const isCollapsed = collapsed.has(t.key);
                      const payId = (t as { payId?: string }).payId;
                      return {
                      onClick: t.onClick,
                      cells: [
                        formatDate(t.date),
                        <Badge key="ty" kind={TXN_BADGE[t.type]} dot>{t.type}</Badge>,
                        // Indent children with a tree connector; parents get a
                        // chevron to expand/collapse their nested rows inline.
                        <span key="r" className="font-mono text-xs inline-flex items-center" style={{ paddingLeft: t.indent * 18 }}>
                          {canExpand ? (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); toggleCollapse(t.key); }}
                              className="mr-1 -ml-1 p-0.5 rounded hover:bg-paper-2 text-ink-3"
                              aria-label={isCollapsed ? "Expand" : "Collapse"}
                            >
                              <Icon name={isCollapsed ? "chevron_right" : "chevron_down"} size={13} />
                            </button>
                          ) : t.indent > 0 ? (
                            <span className="text-ink-4 mr-1">└</span>
                          ) : null}
                          {t.ref}
                        </span>,
                        <span key="a" className="inline-flex flex-col">
                          <span className={cn("tabular-nums", t.indent === 0 ? "font-semibold" : "font-medium text-ink-2")}>{rupee(t.amount)}</span>
                          {t.due != null && t.due > 0 && (
                            <span className="text-[10px] text-amber-ink tabular-nums">{rupee(t.due)} due</span>
                          )}
                        </span>,
                        <span key="s" className="text-ink-2 capitalize">{t.status}</span>,
                        // Delete — only on payments from the `payments` table.
                        payId ? (
                          <IconButton
                            key="del"
                            icon="trash"
                            size="sm"
                            variant="ghost"
                            aria-label="Delete payment"
                            title="Delete this payment"
                            onClick={(e) => { e.stopPropagation(); handleDeletePayment(payId); }}
                          />
                        ) : <span key="del" />,
                      ],
                    };})}
                  />
                ) : (
                  <EmptyState icon="receipt" title="Nothing here" body="No records of this type for this customer." compact />
                )}
              </>
            ) : (
              <EmptyState icon="receipt" title="No transactions yet" body="Quotes, invoices and payments for this customer will appear here." compact />
            )}
          </div>
        </Card>
      )}

      {/* ─────────── Statement — running-balance ledger ─────────── */}
      {mainTab === "statement" && (
        <Card flush>
          <div className="p-4">
            {ledger.length > 0 ? (
              <>
                <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
                  <p className="text-sm text-ink-3">Account statement — invoices billed vs payments received.</p>
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Closing balance</div>
                    <div className={cn("font-serif text-xl tabular-nums", closingBalance > 0 ? "text-rose" : "text-emerald")}>
                      {closingBalance > 0 ? `${rupee(closingBalance)} owed` : closingBalance < 0 ? `${rupee(-closingBalance)} credit` : rupee(0)}
                    </div>
                  </div>
                </div>
                <RecordTable
                  head={["Date", "Details", "Debit", "Credit", "Balance"]}
                  rows={ledger.map((e) => ({
                    cells: [
                      formatDate(e.date),
                      e.desc,
                      <span key="d" className="tabular-nums text-ink-2">{e.debit ? rupee(e.debit) : "—"}</span>,
                      <span key="cr" className="tabular-nums text-emerald">{e.credit ? rupee(e.credit) : "—"}</span>,
                      <span key="b" className="tabular-nums font-medium">{rupee(e.balance)}</span>,
                    ],
                  }))}
                />
              </>
            ) : (
              <EmptyState icon="file" title="No statement yet" body="Once this customer has invoices and payments, a running statement appears here." compact />
            )}
          </div>
        </Card>
      )}

      <CreateProjectQuoteDialog open={projQuoteOpen} onOpenChange={setProjQuoteOpen} prefillCustomerId={c.id} />
      <AddReferralDialog open={referralOpen} onOpenChange={setReferralOpen} customerId={c.id} customerName={c.name} />
      <InvoiceChooserDialog open={invoiceOpen} onOpenChange={setInvoiceOpen} customerId={c.id} onChooseProject={() => setProjInvoiceOpen(true)} />
      <CreateProjectQuoteDialog open={projInvoiceOpen} onOpenChange={setProjInvoiceOpen} mode="invoice" prefillCustomerId={c.id} />
      <DeleteBlockedDialog
        open={payBlock !== null}
        onClose={() => setPayBlock(null)}
        title="Can't delete this payment yet"
        reason={payBlock ?? ""}
        links={[
          { label: "Open Invoices", href: "/invoices" },
          { label: "Open Banking (to un-reconcile)", href: "/accounting/banking" },
        ]}
      />
    </div>
  );
}

// Clickable record table for the Quotes / Invoices tabs.
function RecordTable({ head, rows }: { head: string[]; rows: { cells: React.ReactNode[]; onClick?: () => void }[] }) {
  return (
    <>
      {/* Mobile: each row as a stacked label→value card (table side-scrolls on
          phones, §20). Uses the column heads as labels so it stays generic. */}
      <ul className="md:hidden space-y-2">
        {rows.map((r, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={r.onClick}
              className={cn(
                "w-full text-left rounded-md border border-hairline bg-paper p-3 space-y-1.5",
                r.onClick ? "cursor-pointer hover:bg-paper-2/40" : "cursor-default",
              )}
            >
              {r.cells.map((cell, j) => (
                <div key={j} className="flex items-baseline justify-between gap-3">
                  <span className="text-[10px] uppercase tracking-wider text-ink-3 shrink-0">{head[j]}</span>
                  <span className="text-sm text-ink-2 text-right min-w-0">{cell}</span>
                </div>
              ))}
            </button>
          </li>
        ))}
      </ul>

      {/* Desktop / tablet table */}
      <div className="hidden md:block border border-hairline rounded-md overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-paper-2/50">
            <tr>
              {head.map((h) => (
                <th key={h} className="text-left px-3 py-2 text-[10px] font-semibold text-ink-3 uppercase tracking-wider whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {rows.map((r, i) => (
              <tr
                key={i}
                onClick={r.onClick}
                className={cn("hover:bg-paper-2/30", r.onClick && "cursor-pointer")}
              >
                {r.cells.map((cell, j) => <td key={j} className="px-3 py-2 text-ink-2 whitespace-nowrap">{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
