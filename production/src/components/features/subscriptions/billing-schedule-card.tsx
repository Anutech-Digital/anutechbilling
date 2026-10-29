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
import { subscriptionSchedule, nextTermSchedule, currentTermStart } from "@/lib/billing/subscription-schedule";import { periodLastDay } from "@/lib/billing/schedule";
import { cycleScheduleLabel } from "@/lib/quotes/billing";
import { useScheduleInvoices } from "@/lib/queries/subscriptions";
import {
  scheduleInvoices, nextUninvoiced, nextTermShowsNext, scheduleCountLabel, scheduleCounts, termAddSeatInvoices, shownTermTotal,
  quoteTermAmount, scheduleFootnote,
  type ScheduleInvoice, type AddSeatInvoice,
} from "./schedule-invoices";
import { subscriptionEnded } from "@/lib/subscriptions/renewal-display";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canOpenRoute } from "@/lib/nav";
import { InvoicePeekDialog } from "./invoice-peek-dialog";

export function BillingScheduleCard({ subscription, todayISO }: {
  subscription: Subscription;
  todayISO: string;
}) {
  const { data: inv } = useScheduleInvoices(subscription);
  /* R-2101: the sale term's parts at the quote's own figure (13 × ₹11,000 → ₹35,750 a quarter),
     not the rounded mrr's (₹35,751) — the first term only; a renewed term is priced on mrr. */
  const saleTermAmount = React.useMemo(() => {
    const start = subscription.start_date?.slice(0, 10) ?? null;
    if (!inv?.saleQuote || !start || currentTermStart(subscription) !== start) return null;
    return quoteTermAmount({
      plan: subscription.plan, seats: subscription.seats, mrr: subscription.mrr,
      termMonths: Math.max(1, subscription.term_months ?? 12), quote: inv.saleQuote,
    });
  }, [subscription, inv]);
  const current = React.useMemo(() => subscriptionSchedule(subscription, saleTermAmount), [subscription, saleTermAmount]);
  /* R-1685: an ended subscription has no next term and no "next" bill. */
  const ended   = subscriptionEnded(subscription.status);
  const next    = React.useMemo(() => (ended ? [] : nextTermSchedule(subscription)), [subscription, ended]);
  const invoiced = React.useMemo(() => scheduleInvoices({
    periods: current,
    startDate: subscription.start_date,
    saleInvoice: inv?.sale ?? null,
    instalments: inv?.instalments ?? [],
    source: subscription,
    renewals: inv?.renewals ?? [],
  }), [current, subscription, inv]);
  const extras = React.useMemo(() => termAddSeatInvoices(current, inv?.addSeats ?? []), [current, inv]);

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
      <ScheduleTable rows={current} todayISO={todayISO} label={ended ? "Billing dates (ended)" : "This term"} invoiced={invoiced} showNext={!ended} extras={extras} />

      {next.length > 0 && (
        <div className="mt-4 border-t border-hairline pt-4">
          <ScheduleTable rows={next} todayISO={todayISO} label="Next term (on renewal)" muted invoiced={EMPTY}
            showNext={nextTermShowsNext(current, invoiced, todayISO)} />
        </div>
      )}

      <p className="mt-3 text-2xs leading-snug text-ink-3">
        {scheduleFootnote(subscription.billing_cycle)}
      </p>
    </Card>
  );
}

const EMPTY = new Map<number, ScheduleInvoice>();

function ScheduleTable({ rows, todayISO, label, muted, invoiced, showNext = true, extras = [] }: {
  rows: ReturnType<typeof subscriptionSchedule>;
  todayISO: string;
  label: string;
  muted?: boolean;
  invoiced: Map<number, ScheduleInvoice>;
  /** R-527: only one table on the card may tag a row "next". */
  showNext?: boolean;
  /** R-1683: the add-seats invoices raised inside this term — listed under its billing dates. */
  extras?: AddSeatInvoice[];
}) {
  /* R-1683: invoiced rows count their invoice's own figure; the term's add-seats invoices are added. */
  const total = shownTermTotal(rows, invoiced, extras);
  const nextIndex = showNext ? nextUninvoiced(rows, invoiced, todayISO) : null;
  /* R-2101: a period billed outside (Opening, R-1763) is not "invoiced" here. */
  const counts = scheduleCounts(rows, invoiced);
  return (
    <div className={cn(muted && "opacity-75")}>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-2xs font-semibold uppercase tracking-wider text-ink-3">{label}</span>
        {/* "ex-GST" is stated because the customer's own portal shows the
            GST-inclusive figure for the same instalments, and two different numbers
            for one bill with nothing distinguishing them is how a rep and a customer
            end up arguing about which is right. */}
        <span className="text-2xs text-ink-3">
          {scheduleCountLabel(rows.length, counts.invoiced, extras.length, counts.billedOutside)} · {rupee(total)} ex-GST
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
                  {inv && <InvoicedChip inv={inv} />}
                  {past && <span className="ml-2 text-3xs uppercase tracking-wider text-ink-3">date passed</span>}
                </p>
                <p className="text-2xs text-ink-3">
                  covers {formatDate(p.periodStart)} – {formatDate(periodLastDay(p.periodEnd))}
                </p>
              </div>
              <span className={cn("shrink-0 text-sm tabular-nums", dim ? "text-ink-3" : "font-medium text-ink")}>
                {rupee(inv?.exGst ?? p.amount)}
              </span>
            </li>
          );
        })}
        {/* R-1683: seats added mid-term are billed on their own invoice — shown here so this
            term never reads as billed for fewer seats than it really was. */}
        {extras.map((x) => (
          <li key={`${label}-seats-${x.invoiceId}`} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="text-sm text-ink-3">
                {x.invoiceDate ? formatDate(x.invoiceDate) : "Seats added"}
                <InvoicedChip inv={x} />
              </p>
              <p className="text-2xs text-ink-3">seats added in this term · one-off pro-rata charge</p>
            </div>
            <span className="shrink-0 text-sm tabular-nums text-ink-3">{rupee(x.exGst ?? 0)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * R-1620: the "Invoiced · INV-… · paid" chip opens that invoice in a popup. A role that
 * cannot open /invoices (canOpenRoute — the same menu rule) sees the chip as plain text,
 * not a button that leads nowhere.
 */
export function InvoicedChip({ inv }: { inv: ScheduleInvoice }) {
  const { data: me } = useCurrentUser();
  const [open, setOpen] = React.useState(false);
  /* R-1763: billed in Zoho — that invoice is not in this app, so the tag is plain text. */
  if (inv.externalLabel) {
    return <span className="ml-2"><Badge kind="muted" size="sm">{inv.externalLabel}</Badge></span>;
  }
  const label = `Invoiced · ${inv.invoiceId}${inv.status === "paid" ? " · paid" : ""}`;
  const badge = <Badge kind={inv.status === "paid" ? "success" : "muted"} size="sm">{label}</Badge>;
  if (!canOpenRoute(me?.role, "/invoices/x")) return <span className="ml-2">{badge}</span>;
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        title={`Open invoice ${inv.invoiceId}`}
        onClick={() => setOpen(true)}
        className="ml-2 cursor-pointer rounded-full align-middle transition hover:brightness-95 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-1"
      >
        {badge}
      </button>
      {open && <InvoicePeekDialog invoiceId={inv.invoiceId} open={open} onOpenChange={setOpen} />}
    </>
  );
}
