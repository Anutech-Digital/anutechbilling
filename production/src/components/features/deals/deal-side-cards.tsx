"use client";
/**
 * Deal page right column — summary, details, follow-ups, quotes, money. Every figure is read
 * from a real row; a number that cannot be worked out says why instead of showing 0.
 */
import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { MetricCard } from "@/components/features/customers/customer-insights";
import { LoadErrorInline } from "@/components/shared/load-error";
import { Fact } from "@/components/features/leads/lead-detail-format";
import { ExpectedCloseField } from "@/components/features/leads/expected-close-field";
import { LeadFollowupsTab } from "@/components/features/leads/lead-detail-followups-tab";
import { addedByLabel } from "@/lib/leads/added-by";
import type { DealMoney } from "@/lib/deals/timeline";
import type { DealQuoteRow } from "@/lib/deals/deal-quotes";
import type { Lead, Quote } from "@/lib/supabase/database.types";
import type { useUserNames } from "@/lib/hooks/useUserNames";
import type { useTasksForLead, useCompleteTask, useSnoozeTask, useDeleteTask } from "@/lib/queries/tasks";

type TaskRow = NonNullable<ReturnType<typeof useTasksForLead>["data"]>[number];

export function DealSummaryCard({ lead, latestQuote }: { lead: Lead; latestQuote: Quote | undefined }) {
  /* leads.value is the ANNUAL deal value (lib/leads/deal-rules.ts#autoDealValue = seats ×
     price × 12), so price per seat per month is value ÷ seats ÷ 12. */
  /* A project deal is one-time work, not a yearly seat subscription — no seats, no price/seat,
     and its value is not "per year" (1 Oct 2026, Demo Co showed "Deal value (saal)"). */
  const isProject = lead.enquiry_type === "project" || !!lead.project_id;
  const perSeat = !isProject && lead.value && lead.seats ? Math.round(lead.value / lead.seats / 12) : null;
  const cycle = latestQuote?.billing_cycle ?? null;
  const hints = [
    cycle ? `Quote billing: ${cycle}` : null,
    latestQuote?.discount_pct ? `Discount ${latestQuote.discount_pct}%` : null,
    lead.subscription_type === "fresh" ? "Fresh subscription" : lead.subscription_type === "switch" ? "Vendor switch" : null,
    lead.pipeline === "renewal" ? "Renewal" : lead.pipeline === "migration" ? "Migration" : null,
  ].filter(Boolean) as string[];
  return (
    <Card title="Deal summary">
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <Fact label={isProject ? "Project" : "Plan"} value={isProject ? (lead.requirement ?? "Project") : lead.plan} />
        {!isProject && <Fact label="Seats" value={lead.seats?.toString()} mono />}
        {!isProject && <Fact label="Price / seat / month" value={perSeat ? rupee(perSeat) : null} mono />}
        <Fact label={isProject ? "Deal value (one-time, ex-GST)" : "Deal value / year"} value={lead.value ? rupee(lead.value) : null} big />
      </div>
      {hints.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {hints.map((h) => <Badge key={h} kind="outline" size="sm">{h}</Badge>)}
        </div>
      )}
      {!isProject && !perSeat && (
        <p className="mt-2 text-xs text-ink-3">Add value and seats via Edit to see price / seat.</p>
      )}
    </Card>
  );
}

export function DealDetailsCard({ lead, userNames, onEdit }: {
  lead: Lead; userNames: ReturnType<typeof useUserNames>["data"]; onEdit: () => void;
}) {
  return (
    <Card title="Details" actions={<Button size="sm" variant="ghost" icon="edit" onClick={onEdit}>Edit</Button>}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <ExpectedCloseField lead={lead} />
        <Fact label="Source" value={lead.source} mono />
        <Fact label="Contact" value={lead.contact_name} />
        <Fact label="Phone" value={lead.contact_phone} mono />
        <div className="col-span-2"><Fact label="Email" value={lead.contact_email} mono /></div>
        <Fact label="GSTIN" value={lead.gstin} mono />
        <Fact label="Created" value={formatDate(lead.created_at)} />
        <div className="col-span-2">
          <Fact label="Added by" value={addedByLabel({ createdBy: lead.created_by, source: lead.source, createdAt: lead.created_at }, userNames)} />
        </div>
      </div>
      {lead.customer_id && (
        <Link href={`/customers/${lead.customer_id}` as never}
          className="mt-3 flex items-center gap-2 rounded-lg border border-emerald/30 bg-emerald/5 px-3 py-2 text-sm text-ink hover:bg-emerald/10">
          <Icon name="users" size={14} className="text-emerald" /> Open customer
        </Link>
      )}
      <div className="mt-3">
        <div className="mb-1 text-2xs uppercase tracking-wider text-ink-3">Notes</div>
        <div className="min-h-[48px] whitespace-pre-wrap rounded-md bg-paper-2 p-3 text-sm text-ink-2">
          {lead.notes || <span className="italic text-ink-3">No notes.</span>}
        </div>
      </div>
    </Card>
  );
}

export function DealFollowupsCard(props: {
  openTasks: TaskRow[]; doneTasks: TaskRow[]; setAddTaskOpen: (o: boolean) => void;
  completeTask: ReturnType<typeof useCompleteTask>; snoozeTask: ReturnType<typeof useSnoozeTask>; deleteTask: ReturnType<typeof useDeleteTask>;
}) {
  return (
    <Card>
      <LeadFollowupsTab {...props} />
    </Card>
  );
}

/* R-1806: `error` = the quotes-by-lead read failed — say so with Try again, never "No quotes yet". */
export function DealQuotesCard({ rows, onNewQuote, projectFailed, error, onRetry }: {
  rows: DealQuoteRow[]; onNewQuote: () => void; projectFailed?: boolean; error?: unknown; onRetry?: () => void;
}) {
  return (
    <Card title={`Quotes${rows.length ? ` (${rows.length})` : ""}`} actions={<Button size="sm" variant="ghost" icon="plus" onClick={onNewQuote}>New quote</Button>}>
      {error != null ? (
        <LoadErrorInline what="Quotes" error={error} onRetry={onRetry ?? (() => {})} />
      ) : rows.length === 0 ? (
        <p className="text-sm italic text-ink-3">No quotes yet.</p>
      ) : (
        <ul className="-mx-1 divide-y divide-hairline">
          {rows.map((q) => (
            <li key={q.key}>
              <Link href={q.href as never}
                className="flex items-center justify-between gap-3 rounded px-1 py-2.5 hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {q.kind === "project" && <Badge kind="outline" size="sm">Project</Badge>}
                    <span className={`truncate text-xs font-semibold text-ink ${q.kind === "project" ? "" : "font-mono"}`}>{q.ref}</span>
                    <Badge kind={q.badge} size="sm" dot>{q.statusLabel}</Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-ink-3">{formatDate(q.createdAt)}{q.kind === "subscription" && q.sub ? ` · ${q.sub}` : ""}</div>
                </div>
                <span className="shrink-0 font-serif text-sm tabular-nums text-ink">{rupee(q.amount)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {projectFailed && <p className="mt-2 text-xs text-rose">Couldn't load project quotation — list may be incomplete.</p>}
    </Card>
  );
}

export function DealMoneyCard({ money, subscriptions, failed, hasQuotes }: {
  money: DealMoney; subscriptions: number; failed: boolean; hasQuotes: boolean;
}) {
  const p = money.project;
  return (
    <Card title="Payments" sub="Invoices and payments from this deal's quotes">
      {/* R-1806: after a failed read "no quote" is not known — the line at the bottom says so. */}
      {!hasQuotes ? (
        failed ? null : <p className="text-sm italic text-ink-3">Invoices and payments appear here after a quote.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] gap-2">
          <MetricCard label="Invoiced" value={money.invoiceCount ? rupee(money.invoiced) : "—"} hint={money.invoiceCount ? `${money.invoiceCount} invoice` : "None yet"} />
          <MetricCard label="Paid" value={money.paymentCount ? rupee(money.paid) : "—"} tone={money.paid > 0 ? "success" : "default"} hint={money.paymentCount ? `${money.paymentCount} payment${p.tds > 0 ? ` · ${rupee(p.tds)} TDS` : ""}` : undefined} />
          <MetricCard
            label="Balance due"
            value={money.outstanding === null ? "—" : money.outstanding > 0 ? rupee(money.outstanding) : "Clear"}
            tone={money.outstanding && money.outstanding > 0 ? "danger" : money.outstanding === 0 ? "success" : "default"}
          />
        </div>
      )}
      {p.value > 0 && (
        <p className="mt-2 text-xs text-ink-3">
          Project total {rupee(p.value)}
          {p.notInvoiced > 0 ? ` — ${rupee(p.notInvoiced)} of milestones not invoiced yet.` : " — all milestones invoiced."}
        </p>
      )}
      {subscriptions > 0 && (
        <p className="mt-2 text-xs text-ink-3">{subscriptions} subscription(s) from this deal's quotes.</p>
      )}
      {failed && <p className="mt-2 text-xs text-rose">Some billing records didn't load — numbers may be incomplete.</p>}
    </Card>
  );
}
