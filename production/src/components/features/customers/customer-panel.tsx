"use client";

/**
 * CustomerPanel — right-hand detail pane for the Customers master-detail layout,
 * "answers-first" (beats the accountant-first Zoho layout). Composes the shared
 * customer-insights building blocks so it stays byte-for-byte consistent with the
 * full /customers/[id] 360 page (same Outstanding / MRR / Next-best-action).
 *
 * Human-psychology ordering — the brain asks 3 things on open:
 *   1. WHO + can I reach them?  → identity header + contact actions
 *   2. Healthy / do they owe?   → answer-bar (4 real KPIs)
 *   3. What do I do NEXT?       → next-best-action card
 * Then subscriptions (the heart) and, behind light tabs, secondary detail.
 */
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { useCustomer, useSetCustomerActive } from "@/lib/queries/customers";
import { useCustomerGroups } from "@/lib/queries/customer-groups";
import { useCustomerSubscriptions } from "@/lib/queries/subscriptions";
import { useCustomerInvoices, useCustomerQuotes } from "@/lib/queries/invoices";
import { useCustomerProjects } from "@/lib/queries/projects";
import { usePayments } from "@/lib/queries/payments";
import { Badge } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { initials, formatDate, rupee, daysBetween, cn } from "@/lib/utils";
import { InvoiceChooserDialog } from "@/components/features/invoices/invoice-chooser-dialog";
import { CreateProjectQuoteDialog } from "@/components/features/projects/create-project-quote-dialog";
import { useConfirm } from "@/components/providers/confirm-provider";
import {
  deriveCustomerInsights,
  CustomerMetricBar,
  NextBestActionCard,
  CustomerContactActions,
  SubscriptionList,
  CustomerActivity,
  CustomerDetailsGrid,
  PanelEmpty,
} from "./customer-insights";

export function CustomerPanel({ customerId, onClose }: { customerId: string; onClose?: () => void }) {
  const router = useRouter();
  const setActive = useSetCustomerActive();
  const confirm = useConfirm();
  const { data: allGroups } = useCustomerGroups();
  const { data: c, isLoading } = useCustomer(customerId);
  const { data: subs } = useCustomerSubscriptions(customerId);
  const { data: invoices } = useCustomerInvoices(customerId);
  const { data: quotes } = useCustomerQuotes(customerId);
  const { data: projects } = useCustomerProjects(customerId);
  const { data: allPayments } = usePayments();
  const [tab, setTab] = React.useState("activity");
  const [invoiceOpen, setInvoiceOpen] = React.useState(false);
  const [projInvoiceOpen, setProjInvoiceOpen] = React.useState(false);

  React.useEffect(() => { setTab("activity"); }, [customerId]);

  if (isLoading) {
    return (
      <div className="p-5 space-y-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-12 w-12 rounded-full" />
          <Skeleton className="h-7 w-48" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (!c) {
    return <div className="p-8 text-center text-sm text-ink-3">Customer not found.</div>;
  }

  const allSubs = subs ?? [];
  const allInvoices = invoices ?? [];
  const allQuotes = quotes ?? [];
  // Received payments (subscription/direct) — same 6th arg the 360 page passes,
  // so "Lifetime paid" here matches it (was silently 0, dropping all receipts).
  const receivedPaymentsTotal = (allPayments ?? [])
    .filter((p) => p.customer_id === c.id && p.status === "received")
    .reduce((s, p) => s + (p.amount ?? 0), 0);
  const insights = deriveCustomerInsights(c, allSubs, allInvoices, projects ?? [], allQuotes, receivedPaymentsTotal);

  const tenureDays = daysBetween(c.since, new Date());
  const tenure =
    tenureDays >= 365 ? `${Math.floor(tenureDays / 365)}y ${Math.floor((tenureDays % 365) / 30)}mo`
    : tenureDays >= 30 ? `${Math.floor(tenureDays / 30)}mo`
    : `${Math.max(tenureDays, 0)}d`;
  const healthKind = c.health >= 85 ? "success" : c.health >= 70 ? "warning" : "danger";
  const healthLabel = c.health >= 85 ? "Healthy" : c.health >= 70 ? "Watch" : "At risk";

  const tabs: TabBarItem[] = [
    { id: "activity", label: "Activity" },
    { id: "invoices", label: "Invoices", count: allInvoices.length || undefined },
    { id: "quotes",   label: "Quotes",   count: (allQuotes.length + (projects ?? []).length) || undefined },
    { id: "details",  label: "Details" },
  ];
  const custProjects = projects ?? [];

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 1. Identity header */}
      <div className="px-5 pt-4 pb-3 border-b border-hairline flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Avatar initials={initials(c.name) || "?"} color="amber" size="md" />
          <div className="min-w-0">
            <h2 className="font-serif text-2xl text-ink leading-tight truncate">
              <Link href={`/customers/${c.id}` as never} className="hover:underline decoration-1 underline-offset-2" title="Open full customer profile">
                {c.display_name || c.name}
              </Link>
            </h2>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {/* Health is only meaningful for an active paying relationship. For a
                  customer with no active subscription, a score would be noise — show
                  a neutral state instead of an alarming "At risk / Watch". */}
              {insights.activeSubs.length > 0
                ? <Badge kind={healthKind} dot>{healthLabel} · {c.health}</Badge>
                : <Badge kind="muted">{insights.lifetimePaid > 0 ? "Inactive" : "New"}</Badge>}
              <span className="text-[11px] text-ink-3">{tenureDays === 0 ? "Added today" : `Customer for ${tenure}`}</span>
              {c.domain && <span className="text-[11px] text-ink-3 font-mono truncate">· {c.domain}</span>}
            </div>
            {/* Parent account (customer group) — highlighted, so the operator
                instantly sees this customer belongs to a larger account. */}
            {c.group_id && (() => {
              const g = (allGroups ?? []).find((x) => x.id === c.group_id);
              return g ? (
                <Link
                  href={`/customers/groups/${g.id}` as never}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-amber-soft px-2.5 py-1 text-[11px] font-semibold text-amber-ink hover:bg-amber/20 transition-colors max-w-full"
                  title={`Part of parent account: ${g.name}`}
                >
                  <Icon name="layout" size={12} className="shrink-0" />
                  <span className="truncate">Parent account: {g.name}</span>
                </Link>
              ) : null;
            })()}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* The two "create a money document" shortcuts. Quote = the recurring
              money-spine (lead → quote → pay → subscription); Invoice = a one-off
              direct bill. Both kept here so a drawer visit can start either. */}
          <Button size="sm" variant="default" icon="plus" onClick={() => router.push(`/quotes/new?customer=${c.id}` as never)}>Quote</Button>
          <Button size="sm" variant="default" icon="receipt" onClick={() => setInvoiceOpen(true)}>Invoice</Button>
          <IconButton icon="edit" aria-label="Edit customer" onClick={() => router.push(`/customers/${c.id}/edit` as never)} />
          <IconButton icon="external" aria-label="Open full profile" onClick={() => router.push(`/customers/${c.id}` as never)} />
          {/* Archive / reactivate — money-safe alternative to delete (records kept). */}
          <IconButton
            icon="inbox"
            aria-label={c.is_active === false ? "Reactivate customer" : "Archive customer"}
            title={c.is_active === false ? "Reactivate customer" : "Archive (hide from active list)"}
            onClick={async () => {
              const next = c.is_active === false;
              if (next || (await confirm({ title: `Archive "${c.name}"?`, body: "Hidden from your active customers; all invoices/payments are kept. Reactivate anytime.", confirmLabel: "Archive", icon: "inbox" }))) {
                setActive.mutate({ id: c.id, isActive: next }, { onSuccess: () => { if (!next) onClose?.(); } });
              }
            }}
          />
          {onClose && <IconButton icon="x" aria-label="Close" onClick={onClose} />}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        <CustomerContactActions customer={c} />

        {/* 2. Answer-bar */}
        <CustomerMetricBar insights={insights} />

        {/* 3. Next-best-action */}
        <NextBestActionCard nba={insights.nba} customer={c} />

        {/* 4. Subscriptions & projects — ongoing revenue relationships */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Subscriptions & projects</span>
            {(allSubs.length + custProjects.length) > 0 && <span className="text-[10px] text-ink-3 tabular-nums">({allSubs.length + custProjects.length})</span>}
          </div>
          <SubscriptionList subs={allSubs} />
          {custProjects.length > 0 && (
            <ul className="space-y-1.5 mt-2">
              {custProjects.map((p) => (
                <li key={p.id}>
                  <Link href={`/projects/${p.id}` as never} className="flex items-center justify-between gap-3 rounded-md border border-hairline bg-paper px-3 py-2 hover:border-hairline-strong transition-colors">
                    <span className="flex items-center gap-2 min-w-0">
                      <Icon name="package" size={14} className="text-ink-3 shrink-0" />
                      <span className="min-w-0">
                        <span className="text-sm text-ink truncate block">{p.title}</span>
                        <span className="text-[11px] text-ink-3">Project · {p.receivable > 0 ? `${rupee(p.receivable)} outstanding` : "fully paid"}</span>
                      </span>
                    </span>
                    <Badge kind={p.status === "completed" ? "success" : p.status === "cancelled" ? "muted" : p.status === "quoted" ? "info" : "warning"} size="sm" dot>
                      {p.status === "quoted" ? "Quotation" : p.status}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 5. Secondary detail — progressive disclosure */}
        <section>
          <TabBar value={tab} onChange={setTab} items={tabs} />
          <div className="pt-4">
            {tab === "activity" && <CustomerActivity subs={allSubs} invoices={allInvoices} quotes={allQuotes} limit={10} />}
            {tab === "invoices" && (
              allInvoices.length > 0 ? (
                <SimpleTable
                  head={["Invoice", "Date", "Amount", "Status"]}
                  rows={allInvoices.map((i) => [
                    i.id, formatDate(i.invoice_date), rupee(i.amount),
                    <Badge key="b" kind={i.status === "paid" ? "success" : i.status === "overdue" ? "danger" : "warning"} dot>{i.status}</Badge>,
                  ])}
                  rowLinks={allInvoices.map((i) => `/invoices?open=${i.id}`)}
                />
              ) : <PanelEmpty icon="receipt" text="No invoices yet." />
            )}
            {tab === "quotes" && (
              (allQuotes.length + custProjects.length) > 0 ? (
                <SimpleTable
                  head={["Quote / Project", "Type", "Amount", "Status"]}
                  rows={[
                    ...allQuotes.map((q) => [
                      q.id, "Subscription", rupee(q.amount),
                      <Badge key="b" kind="info" dot>{q.status}</Badge>,
                    ]),
                    ...custProjects.map((p) => [
                      p.title, "Project", rupee(p.total_amount),
                      <Badge key="b" kind={p.status === "completed" ? "success" : p.status === "cancelled" ? "muted" : p.status === "quoted" ? "info" : "warning"} dot>
                        {p.status === "quoted" ? "Quotation" : p.status}
                      </Badge>,
                    ]),
                  ]}
                  rowLinks={[
                    ...allQuotes.map((q) => `/quotes/${q.id}`),
                    ...custProjects.map((p) => `/projects/${p.id}`),
                  ]}
                />
              ) : <PanelEmpty icon="file" text="No quotes yet." />
            )}
            {tab === "details" && <CustomerDetailsGrid c={c} />}
          </div>
        </section>
      </div>

      <InvoiceChooserDialog open={invoiceOpen} onOpenChange={setInvoiceOpen} customerId={c.id} onChooseProject={() => setProjInvoiceOpen(true)} />
      <CreateProjectQuoteDialog open={projInvoiceOpen} onOpenChange={setProjInvoiceOpen} mode="invoice" prefillCustomerId={c.id} />
    </div>
  );
}

function SimpleTable({ head, rows, rowLinks }: {
  head: string[];
  rows: React.ReactNode[][];
  /** Per-row destination; a row with a link becomes clickable (opens the doc). */
  rowLinks?: (string | undefined)[];
}) {
  const router = useRouter();
  return (
    <div className="border border-hairline rounded-md overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-paper-2/50">
          <tr>
            {head.map((h) => (
              <th key={h} className="text-left px-3 py-2 text-[10px] font-semibold text-ink-3 uppercase tracking-wider">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {rows.map((r, i) => {
            const href = rowLinks?.[i];
            const go = href ? () => router.push(href as never) : undefined;
            return (
              <tr
                key={i}
                className={cn("hover:bg-paper-2/30", href && "cursor-pointer")}
                onClick={go}
                role={href ? "button" : undefined}
                tabIndex={href ? 0 : undefined}
                onKeyDown={href ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go?.(); } } : undefined}
              >
                {r.map((cell, j) => (
                  <td key={j} className={cn("px-3 py-2 text-ink-2", href && j === 0 && "font-medium text-amber hover:underline")}>{cell}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
