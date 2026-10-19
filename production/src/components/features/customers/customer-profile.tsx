/**
 * Customer 360 — the whole customer profile, rendered on its own page OR inside the
 * master-detail panel on /customers.
 *
 * ─── ONE IMPLEMENTATION, TWO SURFACES ───────────────────────────────────────
 * Extracted from app/(app)/customers/[id]/page.tsx on 14 Sep 2026, when Abhishek asked
 * for the full profile in the side panel rather than the summary that was there. The
 * obvious shortcut was to copy the good parts of the page into the panel; that is how
 * this codebase ended up with three copies of a contact phone number, and how the panel
 * and the page would quietly disagree about the same customer six months from now. So
 * the page became a thin wrapper and everything lives here.
 *
 * `variant` is the only difference between the two, and it is deliberately small:
 *   · "page"  — back arrow, page padding and max-width, tab state in the URL
 *   · "panel" — close button, no page chrome, tab state local, single column
 * Anything larger than that belongs in the shared body, not behind the flag.
 *
 * Removed long ago and staying removed: stub "Customer added" activity, a hardcoded
 * account manager, and dead Note/Log-call buttons. Everything here is derived from real
 * rows (compass: no fabricated numbers, no fake timeline).
 */
"use client";

import { projectQuotationView } from "@/lib/projects/quotation-view";
import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { useCustomer, useDeleteCustomer, useSetCustomerActive, useCustomerOpenCredit, customerDeleteBlockReason } from "@/lib/queries/customers";
import { useCustomerGroups } from "@/lib/queries/customer-groups";
import { useCustomerSubscriptions } from "@/lib/queries/subscriptions";
import { CustomerContactsCard } from "@/components/features/customers/customer-contacts-card";
import { LateChargesPreview } from "@/components/features/late-charges/customer-late-charges";
import { CreditSettingsCard } from "@/components/features/customers/credit-settings-card";
import { CustomerFollowupCard } from "@/components/features/collections/customer-followup-card";
import { EntitlementCard } from "@/components/features/support/entitlement-card";
import { useCustomerInvoices, useCustomerQuotes } from "@/lib/queries/invoices";
import { usePayments, useDeletePayment } from "@/lib/queries/payments";
import { useTdsReceivables } from "@/lib/queries/tds-receivable";
import { receiptSplitLine, tdsByPayment } from "@/lib/accounting/tds-receipt";
import { useCustomerProjects, useCustomerProjectPayments } from "@/lib/queries/projects";
import { CreateProjectQuoteDialog } from "@/components/features/projects/create-project-quote-dialog";
import { Card } from "@/components/ui/card";
import { Button, IconButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { TabBar } from "@/components/ui/tabs";
import { LeadHistoryCard } from "@/components/features/contacts/lead-history-card";
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
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canWriteSales } from "@/lib/nav";
import { canDeleteMoney, canRecordMoney } from "@/lib/auth/roles";
import { ViewOnlyNote } from "@/components/shared/view-only-note";
import { canOpenQuotes } from "@/lib/quotes/access";
import { COPY } from "@/lib/copy";
import { useCustomerContacts } from "@/lib/queries/contacts";
import { PrimaryContactLine } from "@/components/features/customers/primary-contact-line";
import { txnHref, primaryContactOf } from "@/components/features/customers/customer-links";
import { buildCustomerStatement, useCustomerNotes } from "@/components/features/customers/customer-statement";
import { RecordTable, RowLink } from "@/components/features/customers/customer-record-table";

export interface CustomerProfileProps {
  customerId: string;
  /** "page" is the standalone route; "panel" is the master-detail pane on /customers. */
  variant?: "page" | "panel";
  /** Panel only: close the pane. Also where a delete lands, since there is no page to leave. */
  onClose?: () => void;
}

export function CustomerProfile({ customerId, variant = "page", onClose }: CustomerProfileProps) {
  const params = { id: customerId };
  const inPanel = variant === "panel";
  const router = useRouter();
  const confirm = useConfirm();
  /* R-237: billing opens customers but not /quotes (middleware sends it to /invoices) —
     no quote clicks or New quote buttons for it. */
  const { data: me } = useCurrentUser();
  const canQuotes = canOpenQuotes(me?.role);
  /* R-255: the accountant reads the profile; edit / invoice / archive / delete stay with the team. */
  const canWrite = canWriteSales(me?.role);
  /* R-718: deleting a payment is owner / accountant only — the database refuses everyone else. */
  const canDeletePay = canWrite && canDeleteMoney(me?.role);
  /* R-1521: every Transactions / Statement row opens its own document (customer-links.ts). */
  const linkOpts = { canQuotes };

  const { data: customer, isLoading, error } = useCustomer(params.id);
  const { data: allGroups } = useCustomerGroups();
  const { data: subs }     = useCustomerSubscriptions(params.id);
  const { data: invoices } = useCustomerInvoices(params.id);
  const { data: quotes }   = useCustomerQuotes(params.id);
  const { data: projects } = useCustomerProjects(params.id);
  const { data: projPay } = useCustomerProjectPayments(params.id);
  const { data: openCredit } = useCustomerOpenCredit(params.id);
  /* R-1682: credit / debit notes belong on the Statement. */
  const { data: customerNotes } = useCustomerNotes(params.id);
  const { data: allPayments } = usePayments();
  /* R-523: TDS this customer deducted — the statement and Lifetime paid show the bank
     money and the TDS apart, else the bank reconciliation can never match. */
  const { data: customerTds } = useTdsReceivables({ customerId: params.id });
  /* R-1522: the customer's people — the header shows the primary one. Same query (and
     cache) as the Contacts card below. */
  const { data: contactRows } = useCustomerContacts(params.id);
  /* "Add contact" from the header / identity card opens the Contacts card's own dialog
     (one add flow, not a second form). It lives on the Overview tab, so go there first. */
  const [addContactAsked, setAddContactAsked] = React.useState(false);
  const startAddContact = React.useCallback(() => { setMainTab("overview"); setAddContactAsked(true); }, []);
  const clearAddContactAsk = React.useCallback(() => setAddContactAsked(false), []);

  /* The ?edit=1 deep link is a ROUTE concern. In the panel there is no URL to read, and
     calling useSearchParams there would also opt the whole /customers page into a
     Suspense boundary it does not need. */
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
              <Link href={"/customers" as any}>Back to companies</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const c = customer;
  /* R-1522: the primary contact PERSON, or null — never the company name (customer-links.ts). */
  const primaryContact = primaryContactOf(c, contactRows);
  const allSubs = subs ?? [];
  const allInvoices = invoices ?? [];
  const allQuotes = quotes ?? [];
  const allProjects = projects ?? [];
  const customerPayments = (allPayments ?? []).filter((p) => p.customer_id === c.id);
  const receivedPaymentsTotal = customerPayments
    .filter((p) => p.status === "received")
    .reduce((s, p) => s + (p.amount ?? 0), 0);
  const insights = deriveCustomerInsights(c, allSubs, allInvoices, allProjects, allQuotes, receivedPaymentsTotal);
  // R-523: TDS inside Lifetime paid — on received quote/invoice payments (tds_receivable by
  // payment) plus project milestones, where the TDS is its own project payment (method 'tds').
  const tdsOnPayment = tdsByPayment(customerTds ?? []);
  const lifetimeTds =
    customerPayments.filter((p) => p.status === "received").reduce((s, p) => s + (tdsOnPayment[p.id] ?? 0), 0) +
    (projPay?.payments ?? []).filter((p) => p.method === "tds").reduce((s, p) => s + (p.amount ?? 0), 0);

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
      return { date: i.invoice_date, type: "Invoice" as const, ref: i.id, amount: i.amount, status, href: txnHref({ kind: "invoice", invoiceId: i.id }, linkOpts) };
    }),
    ...customerPayments.map((p) => ({ date: p.status === "refunded" ? (p.refunded_at ?? p.received_at) : p.received_at, type: p.status === "refunded" ? ("Refund" as const) : ("Payment" as const), ref: p.receipt_voucher_no ?? p.id, amount: p.amount, status: p.status, href: txnHref({ kind: "payment", quoteId: p.quote_id, customerId: params.id }, linkOpts), payId: p.id })),
    // Project milestone receipts — show as Payment rows so they're not invisible.
    ...projPayments.map((p) => ({ date: p.received_at, type: "Payment" as const, ref: p.reference?.trim() || p.project_title, amount: p.amount, status: p.bank_txn_id ? "reconciled" : "received", href: txnHref({ kind: "projectPayment", invoiceId: p.invoice_id ?? null, projectId: p.project_id }, linkOpts) })),
    ...allQuotes.map((q) => ({ date: q.created_date, type: "Quote" as const, ref: q.id, amount: q.amount, status: q.status, href: txnHref({ kind: "quote", quoteId: q.id }, linkOpts) })),
    /* R-006: the status reads in QUOTE language ("Quotation" / "Accepted" / "Declined")
       because this row is the project's quotation as well as the project. The raw
       `quoted` / `active` wording made no sense under a Quotes heading. */
    ...allProjects.map((p) => ({ date: p.created_at, type: "Project" as const, ref: p.title, amount: p.total_amount, status: projectQuotationView(p.status, p.accepted_at).label, href: txnHref({ kind: "project", projectId: p.id }, linkOpts) })),
  ].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  // Hierarchical view (the "All" tab): Project → its invoices → their receipts,
  // so the relationship is obvious. Standalone invoices / subscription payments /
  // quotes sit at the top level. indent drives the left-inset in the render.
  const invoiceProject = projPay?.invoiceProject ?? {};
  type HRow = {
    key: string; parentKey: string | null; indent: number;
    date: string; type: "Invoice" | "Payment" | "Refund" | "Quote" | "Project";
    ref: string; amount: number; status: string; due?: number;
    /** R-1521: where this row's document lives (null = nothing this role can open). */
    href: string | null;
    /** Set only on rows from the `payments` table → enables the delete action. */
    payId?: string;
  };
  const hierRows: HRow[] = [];
  const usedInv = new Set<string>();
  const usedPay = new Set<string>();
  for (const pr of allProjects) {
    const projKey = `proj:${pr.id}`;
    const projDue = Math.max(0, (pr.total_amount ?? 0) - (pr.paid ?? 0));
    hierRows.push({ key: projKey, parentKey: null, indent: 0, date: pr.created_at, type: "Project", ref: pr.title, amount: pr.total_amount, status: projectQuotationView(pr.status, pr.accepted_at).label, due: projDue > 0 ? projDue : undefined, href: txnHref({ kind: "project", projectId: pr.id }, linkOpts) });
    for (const i of allInvoices.filter((iv) => invoiceProject[iv.id]?.projectId === pr.id)) {
      usedInv.add(i.id);
      const pPaid = invoicePaid[i.id] ?? 0;
      const st = pPaid <= 0 ? i.status : pPaid >= i.amount ? "paid" : "partially paid";
      const invKey = `inv:${i.id}`;
      hierRows.push({ key: invKey, parentKey: projKey, indent: 1, date: i.invoice_date, type: "Invoice", ref: i.id, amount: i.amount, status: st, due: pPaid > 0 && pPaid < i.amount ? i.amount - pPaid : undefined, href: txnHref({ kind: "invoice", invoiceId: i.id }, linkOpts) });
      for (const p of projPayments.filter((pp) => pp.invoice_id === i.id)) {
        usedPay.add(p.id);
        hierRows.push({ key: `pay:${p.id}`, parentKey: invKey, indent: 2, date: p.received_at, type: "Payment", ref: p.reference?.trim() || "Payment", amount: p.amount, status: p.bank_txn_id ? "reconciled" : "received", href: txnHref({ kind: "projectPayment", invoiceId: i.id, projectId: pr.id }, linkOpts) });
      }
    }
    // Advance receipts recorded before their milestone was invoiced.
    for (const p of projPayments.filter((pp) => pp.project_id === pr.id && !pp.invoice_id && !usedPay.has(pp.id))) {
      usedPay.add(p.id);
      hierRows.push({ key: `pay:${p.id}`, parentKey: projKey, indent: 1, date: p.received_at, type: "Payment", ref: p.reference?.trim() || "Advance", amount: p.amount, status: p.bank_txn_id ? "reconciled" : "received", href: txnHref({ kind: "projectPayment", invoiceId: null, projectId: pr.id }, linkOpts) });
    }
  }
  for (const i of allInvoices.filter((iv) => !usedInv.has(iv.id))) {
    hierRows.push({ key: `inv:${i.id}`, parentKey: null, indent: 0, date: i.invoice_date, type: "Invoice", ref: i.id, amount: i.amount, status: i.status, href: txnHref({ kind: "invoice", invoiceId: i.id }, linkOpts) });
  }
  for (const p of customerPayments) {
    hierRows.push({ key: `cpay:${p.id}`, parentKey: null, indent: 0, date: p.status === "refunded" ? (p.refunded_at ?? p.received_at) : p.received_at, type: p.status === "refunded" ? "Refund" : "Payment", ref: p.receipt_voucher_no ?? p.id, amount: p.amount, status: p.status, payId: p.id, href: txnHref({ kind: "payment", quoteId: p.quote_id, customerId: params.id }, linkOpts) });
  }
  for (const q of allQuotes) {
    hierRows.push({ key: `q:${q.id}`, parentKey: null, indent: 0, date: q.created_date, type: "Quote", ref: q.id, amount: q.amount, status: q.status, href: txnHref({ kind: "quote", quoteId: q.id }, linkOpts) });
  }
  // Which rows are parents (have children) + parent lookup for the collapse walk.
  const parentOf: Record<string, string | null> = {};
  const hasKids = new Set<string>();
  for (const r of hierRows) { parentOf[r.key] = r.parentKey; if (r.parentKey) hasKids.add(r.parentKey); }

  // Running-balance ledger (Zoho "Statement" tab). R-1682: built by buildCustomerStatement —
  // invoices + debit notes − payments − credit notes + refunds, the same entries as the books'
  // customer ledger (a refunded payment shows its receipt AND the refund).
  const statement = buildCustomerStatement({
    invoices: allInvoices,
    payments: customerPayments,
    creditNotes: customerNotes?.creditNotes ?? [],
    debitNotes: customerNotes?.debitNotes ?? [],
    projectPayments: projPayments,
    paymentSplit: (id, amount) => receiptSplitLine(amount, tdsOnPayment[id]),
  });
  const ledger = statement.rows.map((e) => ({
    ...e,
    href: txnHref(e.link.kind === "payment" ? { kind: "payment", quoteId: e.link.quoteId, customerId: params.id } : e.link, linkOpts),
  }));
  const closingBalance = statement.closing;

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
      /* From the pane there is nowhere to navigate — the list is already on screen, so
         closing the pane IS the return. */
      deleteCustomer.mutate(c.id, {
        onSuccess: () => { if (inPanel) onClose?.(); else router.push("/customers" as never); },
      });
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

  /* Transactions segment filter — invoices / quotes / payments each on their own.
     R-006: "Quotes" counts PROJECT rows too. A project's quotation lives on
     `project_sales` and never reaches the `quotes` table, so this tab was empty for a
     software client who had very much been quoted — the owner reads that as "no quote
     was ever made". The project row is not copied anywhere; it appears under two
     segments, which is true of it. */
  const isQuoteish = (type: string) => type === "Quote" || type === "Project";
  const txnInFilter = (type: string) =>
    txnFilter === "all" ? true
    : txnFilter === "invoices" ? type === "Invoice"
    : txnFilter === "quotes"   ? isQuoteish(type)
    : txnFilter === "payments" ? (type === "Payment" || type === "Refund")
    : txnFilter === "projects" ? type === "Project"
    : true;
  const txnSegments = [
    { id: "all" as const,      label: "All",      n: txns.length },
    { id: "invoices" as const, label: "Invoices", n: txns.filter((t) => t.type === "Invoice").length },
    { id: "quotes" as const,   label: "Quotes",   n: txns.filter((t) => isQuoteish(t.type)).length },
    { id: "payments" as const, label: "Payments", n: txns.filter((t) => t.type === "Payment" || t.type === "Refund").length },
    { id: "projects" as const, label: "Projects", n: txns.filter((t) => t.type === "Project").length },
  ].filter((s) => s.id === "all" || s.n > 0);
  const filteredTxns = txns.filter((t) => txnInFilter(t.type));

  return (
    <div className={inPanel
      /* The pane owns its own scrolling; the page scrolls with the document. */
      ? "h-full overflow-y-auto p-4"
      : "p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto"}>
      {/* Header — identity + real contact actions */}
      <div className="flex items-start justify-between gap-3 flex-wrap mb-6">
        <div className="flex items-start gap-3 min-w-0">
          {/* Back leaves the page; in the pane the equivalent is closing it, and an
              arrow that navigated away would throw out the list beside it. */}
          {inPanel
            ? <IconButton icon="x" aria-label="Close" onClick={() => onClose?.()} />
            : <IconButton icon="arrow_left" aria-label="Back" onClick={() => router.push("/customers" as any)} />}
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
              Customer · since {formatDate(c.since)} · {tenure}
            </p>
            <h1 className={cn(
              "font-serif leading-tight",
              inPanel ? "text-2xl" : "text-3xl md:text-4xl",
            )}>{c.display_name || c.name}</h1>
            {/* R-1522 (17 Oct 2026, Pardeep): the primary contact PERSON sits right under
                the company name — name · designation · phone · email, tap to call / mail.
                Never the company name again as if it were a person. */}
            <PrimaryContactLine contact={primaryContact} onAddContact={canWrite ? startAddContact : undefined} />
            {c.domain && (
              <p className="mt-0.5 text-sm text-ink-3">
                <span className="font-mono text-xs">{c.domain}</span>
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
        {canWrite && (
        <div className="flex gap-2 flex-wrap items-center">
          <Button icon="award" onClick={() => setReferralOpen(true)}>
            {(agreements ?? []).some((a) => a.status === "active") ? "Referral ✓" : "Add referral"}
          </Button>
          <Button icon="edit" onClick={() => router.push(`/customers/${c.id}/edit` as never)}>Edit</Button>
          {/* R-885: issuing an invoice is owner / manager / accountant / billing. */}
          {canRecordMoney(me?.role) && <Button icon="receipt" onClick={() => setInvoiceOpen(true)}>Invoice</Button>}
          {canQuotes && (
            <Button variant="primary" icon="plus" onClick={() => router.push(`/quotes/new?customer=${c.id}` as any)}>{COPY.newQuote}</Button>
          )}
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
          {/* R-885: delete_customer is owner / accountant only (Pardeep's role table). */}
          {canDeleteMoney(me?.role) && (
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
          )}
        </div>
        )}
      </div>

      {!canWrite && <ViewOnlyNote what="edit, invoice or archive customers" />}

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
        <CustomerMetricBar insights={insights} customerId={customer.id} lifetimeTds={lifetimeTds} />
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
      {/* Side by side on the page; stacked in the pane, which is about half as wide as
          the viewport and would otherwise squeeze both columns to unreadable. */}
      <div className={cn(
        "grid gap-5",
        inPanel ? "grid-cols-1" : "grid-cols-1 lg:grid-cols-[minmax(0,340px)_1fr]",
      )}>
        {/* LEFT — who / where / tax + billing details */}
        <CustomerIdentityRail c={c} contact={primaryContact} onAddContact={canWrite ? startAddContact : undefined} />

        {/* RIGHT — subscriptions + activity */}
        <div className="space-y-4 min-w-0">
          {/* Which of their licences the support plan actually covers. Above the
              subscription list because "do they have support for this?" is the
              question a rep opens this page with. */}
          <EntitlementCard customerId={params.id} customerName={c.name} />

          {/* The customer's people. Above the subscription list because "who do I
              ring about this" is asked more often than "what do they own", and
              because the PRIMARY contact here is who invoices and payment reminders
              actually go to — see migration 20260910100000. */}
          <CustomerContactsCard
            customerId={params.id}
            customerName={c.name}
            autoOpenAdd={addContactAsked}
            onAutoOpenHandled={clearAddContactAsk}
          />

          {/* R-346: may this customer be activated on credit, and up to how much. */}
          <CreditSettingsCard customer={c} isOwner={me?.role === "owner"} />

          {/* R-1517: payment follow-ups — log a call / promise, next date, full history. */}
          <CustomerFollowupCard customerId={params.id} customerName={c.name} />

          {/* R-530: late fee On/Off for this customer + charges building up. */}
          <LateChargesPreview level="customer" id={params.id} />

          {/* Is customer ke email/phone par aayi LEADS — quotation/invoice ki tarah
             yahan bhi itihaas dikhe (Pardeep, 1 Sep 2026). */}
          <LeadHistoryCard
            emails={[c.contact_email].filter(Boolean) as string[]}
            phones={[c.contact_phone, c.contact_mobile].filter(Boolean) as string[]}
          />

          <Card
            title="Subscriptions & projects"
            sub={svcView === "subscription"
              ? (allSubs.length > 0 ? `${insights.activeSubs.length} active` : undefined)
              : ((projects ?? []).length > 0 ? `${(projects ?? []).length} project${(projects ?? []).length > 1 ? "s" : ""}` : undefined)}
            actions={!canWrite || (svcView !== "project" && !canQuotes) ? undefined : (
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
            )}
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
                    href: txnHref({ kind: "project", projectId: p.id }, linkOpts),
                    label: `Open project ${p.title}`,
                    cells: [
                      <span key="t" className="font-medium"><RowLink href={txnHref({ kind: "project", projectId: p.id }, linkOpts)}>{p.title}</RowLink></span>,
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
                      : filteredTxns.map((t) => ({ key: "", parentKey: null, indent: 0, due: undefined as number | undefined, ...t }))
                    ).map((t) => {
                      const canExpand = txnFilter === "all" && hasKids.has(t.key);
                      const isCollapsed = collapsed.has(t.key);
                      const payId = (t as { payId?: string }).payId;
                      return {
                      href: t.href,
                      label: `Open ${t.type.toLowerCase()} ${t.ref}`,
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
                          <RowLink href={t.href}>{t.ref}</RowLink>
                        </span>,
                        <span key="a" className="inline-flex flex-col">
                          <span className={cn("tabular-nums", t.indent === 0 ? "font-semibold" : "font-medium text-ink-2")}>{rupee(t.amount)}</span>
                          {t.due != null && t.due > 0 && (
                            <span className="text-3xs text-amber-ink tabular-nums">{rupee(t.due)} due</span>
                          )}
                        </span>,
                        <span key="s" className="text-ink-2 capitalize">{t.status}</span>,
                        // Delete — only on payments from the `payments` table.
                        payId && canDeletePay ? (
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
                  <p className="text-sm text-ink-3">Account statement — invoices and debit notes billed vs payments, credit notes and refunds.</p>
                  <div className="text-right">
                    <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Closing balance</div>
                    <div className={cn("font-serif text-xl tabular-nums", closingBalance > 0 ? "text-rose" : "text-emerald")}>
                      {closingBalance > 0 ? `${rupee(closingBalance)} owed` : closingBalance < 0 ? `${rupee(-closingBalance)} credit` : rupee(0)}
                    </div>
                  </div>
                </div>
                {/* R-530: late charges accrued but not billed yet (they are not in the balance until billed). */}
                <div className="mb-4"><LateChargesPreview level="customer" id={params.id} /></div>
                <RecordTable
                  head={["Date", "Details", "Debit", "Credit", "Balance"]}
                  rows={ledger.map((e) => ({
                    href: e.href,
                    label: `Open ${e.desc}`,
                    cells: [
                      formatDate(e.date),
                      <RowLink key="desc" href={e.href}>{e.desc}</RowLink>,
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

