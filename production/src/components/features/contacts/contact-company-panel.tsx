/**
 * ContactCompanyPanel — when a contact is linked to a customer company, this
 * shows that company's live money picture right on the contact page: the same
 * KPI bar as the Customer 360 (MRR · Outstanding · Lifetime paid), record counts,
 * and the latest transactions — plus a jump to the full company page.
 *
 * It reuses the SHARED customer-insights logic (deriveCustomerInsights +
 * CustomerMetricBar) so the numbers here can never drift from the customer page.
 * Rendered only when `customerId` is set, so the record hooks fire only for
 * linked contacts.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { useCustomer } from "@/lib/queries/customers";
import { useCustomerSubscriptions } from "@/lib/queries/subscriptions";
import { useCustomerInvoices, useCustomerQuotes } from "@/lib/queries/invoices";
import { usePayments } from "@/lib/queries/payments";
import { useCustomerProjects } from "@/lib/queries/projects";
import { deriveCustomerInsights, CustomerMetricBar } from "@/components/features/customers/customer-insights";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar } from "@/components/ui/avatar";
import { rupee, formatDate, initials } from "@/lib/utils";

export function ContactCompanyPanel({ customerId }: { customerId: string }) {
  const { data: customer, isLoading, error } = useCustomer(customerId);
  const { data: subs } = useCustomerSubscriptions(customerId);
  const { data: invoices } = useCustomerInvoices(customerId);
  const { data: quotes } = useCustomerQuotes(customerId);
  const { data: projects } = useCustomerProjects(customerId);
  const { data: allPayments } = usePayments();

  if (isLoading) {
    return (
      <Panel>
        <Skeleton className="h-6 w-48 mb-3" />
        <Skeleton className="h-16 w-full" />
      </Panel>
    );
  }

  // The customer may have been deleted (FK is ON DELETE SET NULL, but there's a
  // brief window before the contact row is re-read) — degrade gracefully.
  if (error || !customer) {
    return (
      <Panel>
        <p className="text-sm text-ink-3 italic">Linked company is no longer available.</p>
      </Panel>
    );
  }

  const c = customer;
  const allSubs = subs ?? [];
  const allInvoices = invoices ?? [];
  const allQuotes = quotes ?? [];
  const allProjects = projects ?? [];
  const receivedPaymentsTotal = (allPayments ?? [])
    .filter((p) => p.customer_id === c.id && p.status === "received")
    .reduce((s, p) => s + (p.amount ?? 0), 0);

  const insights = deriveCustomerInsights(c, allSubs, allInvoices, allProjects, allQuotes, receivedPaymentsTotal);

  const counts = [
    { label: "Subscriptions", value: allSubs.filter((s) => s.status === "active").length },
    { label: "Invoices", value: allInvoices.length },
    { label: "Projects", value: allProjects.length },
    { label: "Quotes", value: allQuotes.length },
  ];

  // Latest few records across the company, newest first.
  const recent = [
    ...allInvoices.map((i) => ({ date: i.invoice_date, type: "Invoice", ref: i.id, amount: i.amount, status: i.status })),
    ...allQuotes.map((q) => ({ date: q.created_date, type: "Quote", ref: q.id, amount: q.amount, status: q.status })),
    ...allProjects.map((p) => ({ date: p.created_at, type: "Project", ref: p.title, amount: p.total_amount, status: p.status })),
  ]
    .filter((r) => r.date)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, 5);

  return (
    <Panel>
      {/* Header — company identity + jump to full 360 */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <Link href={`/customers/${c.id}` as never} className="flex items-center gap-3 min-w-0 group">
          <Avatar initials={initials(c.name) || "?"} color="emerald" size="md" />
          <span className="min-w-0">
            <span className="block font-medium text-ink truncate group-hover:text-amber-ink transition-colors">{c.name}</span>
            <span className="block text-[11px] text-ink-3 truncate">
              {c.customer_type === "individual" ? "Individual" : "Business"}
              {c.gstin ? ` · ${c.gstin}` : ""}
            </span>
          </span>
        </Link>
        <Link
          href={`/customers/${c.id}` as never}
          className="shrink-0 inline-flex items-center gap-1.5 text-xs font-medium text-amber-ink hover:text-amber whitespace-nowrap"
        >
          Open company <Icon name="arrow_right" size={13} />
        </Link>
      </div>

      {/* Shared KPI bar — identical to Customer 360 */}
      <CustomerMetricBar insights={insights} />

      {/* Record counts */}
      <div className="grid grid-cols-4 gap-2 mt-4">
        {counts.map((k) => (
          <div key={k.label} className="rounded-lg border border-hairline bg-paper px-3 py-2 text-center">
            <div className="text-lg font-semibold text-ink tabular-nums">{k.value}</div>
            <div className="text-[10px] uppercase tracking-wider text-ink-3">{k.label}</div>
          </div>
        ))}
      </div>

      {/* Recent records */}
      {recent.length > 0 && (
        <div className="mt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3 mb-2">Recent records</h3>
          <ul className="divide-y divide-hairline rounded-lg border border-hairline overflow-hidden">
            {recent.map((r, idx) => (
              <li key={`${r.type}-${r.ref}-${idx}`} className="flex items-center gap-3 px-3 py-2 bg-paper">
                <Badge kind="muted" size="sm">{r.type}</Badge>
                <span className="text-sm text-ink truncate flex-1 min-w-0">{r.ref}</span>
                <span className="text-[11px] text-ink-3 whitespace-nowrap">{r.date ? formatDate(r.date) : "—"}</span>
                <span className="text-sm font-medium text-ink tabular-nums whitespace-nowrap">{rupee(r.amount ?? 0)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-hairline bg-paper p-4 md:p-5">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3 mb-3">Company</h2>
      {children}
    </section>
  );
}
