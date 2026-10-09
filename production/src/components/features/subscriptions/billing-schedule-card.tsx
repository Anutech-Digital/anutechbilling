"use client";

/**
 * When this subscription will be invoiced, and for how much.
 *
 * ─── IT SHOWS A SCHEDULE, NOT DOCUMENTS ─────────────────────────────────────
 * Nothing on this card creates an invoice. Creating an invoice takes a number out of
 * the tenant's GST series (CLAUDE.md §17a), and issuing those numbers ahead of the
 * supply breaks the consecutive series CGST Rule 46 requires — a renewal that lapses
 * would leave an issued number needing a credit note to cancel.
 *
 * So this is the forecast: every future billing date and amount, with the actual
 * invoice raised on its own date. R-451: a row whose invoice ALREADY exists says so
 * ("Invoiced · INV-… · paid") — a paid first year used to be labelled the "next" bill,
 * which reads as "a second bill is still to be raised".
 *
 * ─── THE TOTAL IS SHOWN SO THE SPLIT CAN BE CHECKED ─────────────────────────
 * A quarterly ₹1,00,001 term is three instalments of ₹25,000 and one of ₹25,001. That
 * looks like a mistake unless the total is on screen next to it.
 */
import * as React from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn, rupee, formatDate } from "@/lib/utils";
import type { Subscription } from "@/lib/supabase/database.types";
import { subscriptionSchedule, nextTermSchedule } from "@/lib/billing/subscription-schedule";
import { scheduleTotal, periodLastDay } from "@/lib/billing/schedule";
import { cycleScheduleLabel } from "@/lib/quotes/billing";
import { useScheduleInvoices } from "@/lib/queries/subscriptions";
import { scheduleInvoices, nextUninvoiced, nextTermShowsNext, type ScheduleInvoice } from "./schedule-invoices";

export function BillingScheduleCard({ subscription, todayISO }: {
  subscription: Subscription;
  todayISO: string;
}) {
  const current = React.useMemo(() => subscriptionSchedule(subscription), [subscription]);
  const next    = React.useMemo(() => nextTermSchedule(subscription), [subscription]);
  const { data: inv } = useScheduleInvoices(subscription);
  const invoiced = React.useMemo(() => scheduleInvoices({
    periods: current,
    startDate: subscription.start_date,
    saleInvoice: inv?.sale ?? null,
    instalments: inv?.instalments ?? [],
  }), [current, subscription.start_date, inv]);

  if (current.length === 0) {
    return (
      <Card title="Billing schedule">
        <p className="text-sm text-ink-3">
          {(subscription.mrr ?? 0) <= 0
            ? "No MRR on this subscription, so there is nothing to schedule."
            : "No start or renewal date, so there is no term to lay a schedule against."}
        </p>
      </Card>
    );
  }

  const termMonths = subscription.term_months ?? 12;
  const years = termMonths / 12;
  const termLabel = termMonths % 12 === 0
    ? `${years} ${years === 1 ? "year" : "years"}`
    : `${termMonths} months`;

  return (
    <Card
      title="Billing schedule"
      sub={`${termLabel} term · ${cycleScheduleLabel(subscription.billing_cycle)}`}
    >
      <ScheduleTable rows={current} todayISO={todayISO} label="This term" invoiced={invoiced} />

      {next.length > 0 && (
        <div className="mt-4 border-t border-hairline pt-4">
          <ScheduleTable rows={next} todayISO={todayISO} label="Next term (on renewal)" muted invoiced={EMPTY}
            showNext={nextTermShowsNext(current, invoiced, todayISO)} />
        </div>
      )}

      <p className="mt-3 text-2xs leading-snug text-ink-3">
        Amounts without an invoice number are scheduled, not invoiced yet. Each tax invoice
        is raised on its own billing date and takes its GST number then.
      </p>
    </Card>
  );
}

const EMPTY = new Map<number, ScheduleInvoice>();

function ScheduleTable({ rows, todayISO, label, muted, invoiced, showNext = true }: {
  rows: ReturnType<typeof subscriptionSchedule>;
  todayISO: string;
  label: string;
  muted?: boolean;
  invoiced: Map<number, ScheduleInvoice>;
  /** R-527: only one table on the card may tag a row "next". */
  showNext?: boolean;
}) {
  const total = scheduleTotal(rows);
  const nextIndex = showNext ? nextUninvoiced(rows, invoiced, todayISO) : null;
  return (
    <div className={cn(muted && "opacity-75")}>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-2xs font-semibold uppercase tracking-wider text-ink-3">{label}</span>
        {/* "ex-GST" is stated because the customer's own portal shows the
            GST-inclusive figure for the same instalments, and two different numbers
            for one bill with nothing distinguishing them is how a rep and a customer
            end up arguing about which is right. */}
        <span className="text-2xs text-ink-3">
          {rows.length} {rows.length === 1 ? "invoice" : "invoices"} · {rupee(total)} ex-GST
        </span>
      </div>
      <ul className="divide-y divide-hairline">
        {rows.map((p) => {
          const inv = invoiced.get(p.index);
          const past = !inv && p.billOn < todayISO;
          const isNext = p.index === nextIndex;
          const dim = !!inv || past;
          return (
            <li key={`${label}-${p.index}`} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className={cn("text-sm", dim ? "text-ink-3" : "text-ink")}>
                  {formatDate(p.billOn)}
                  {isNext && <Badge kind="warning" size="sm" className="ml-2">next</Badge>}
                  {inv && (
                    <Badge kind={inv.status === "paid" ? "success" : "muted"} size="sm" className="ml-2">
                      Invoiced · {inv.invoiceId}{inv.status === "paid" ? " · paid" : ""}
                    </Badge>
                  )}
                  {past && <span className="ml-2 text-3xs uppercase tracking-wider text-ink-3">date passed</span>}
                </p>
                <p className="text-2xs text-ink-3">
                  covers {formatDate(p.periodStart)} – {formatDate(periodLastDay(p.periodEnd))}
                </p>
              </div>
              <span className={cn("shrink-0 text-sm tabular-nums", dim ? "text-ink-3" : "font-medium text-ink")}>
                {rupee(p.amount)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
