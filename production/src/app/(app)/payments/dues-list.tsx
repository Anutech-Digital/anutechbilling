"use client";
/**
 * Payments → Subscription dues: the rows (R-1698, 20 Oct 2026 payments audit).
 *
 * Before: a phone list (`md:hidden`) and a table (`hidden xl:block`) — between 768 and 1279px
 * (a laptop with the sidebar, the Claude pane at ~800px) NO rows showed, only the heading
 * "Subscription dues · ₹X". Each table row carried four buttons (Record payment, Remind,
 * Suspend, Write off), and the table scrolled inside its own max-height box under the page's
 * sticky bar — two scrolls.
 *
 * Now: cards below 1280px, the table from 1280px — every width shows the rows. One filled
 * button per row (Record payment, R-1697); Remind / Suspend / Resume / Write off sit in "⋯".
 * Overdue first; the first 5 rows, then "Show all N". No inner scroll box. The age legend
 * lives on the Age header's tooltip instead of a line under the list. Money logic unchanged.
 */
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { rupee, formatDate } from "@/lib/utils";
import { paymentDueState, paymentDueChipLabel, todayIST } from "@/lib/subscriptions/payment-due";
import type { OutstandingRow } from "@/lib/queries/payments";

/** Rows shown before "Show all N". */
export const DUES_FIRST = 5;

/** What each age band means — on the Age header's tooltip (was a line under the list). */
export const DUES_AGE_LEGEND =
  "Age = days since the oldest unpaid invoice was due. 0–15 days: friendly reminder · 16–30 days: stronger nudge · 30+ days: consider suspending service · 60+ days: accept it as a loss (bad debt)";

/** Write off is offered once a balance is more than 30 days old (unchanged rule). */
export const canWriteOffDue = (o: Pick<OutstandingRow, "days_outstanding">) => o.days_outstanding > 30;

/**
 * Overdue first: rows past their agreed due date, then the oldest balance first. Stable for
 * ties (the hook's own order), and never mutates the input.
 */
export function duesOrder<T extends Pick<OutstandingRow, "payment_due_date" | "outstanding_amount" | "days_outstanding">>(
  rows: readonly T[],
  today: string = todayIST(),
): T[] {
  const overdue = (o: T) => (paymentDueState(o.payment_due_date, today, o.outstanding_amount).kind === "overdue" ? 1 : 0);
  return rows
    .map((o, i) => ({ o, i, od: overdue(o) }))
    .sort((a, b) => b.od - a.od || b.o.days_outstanding - a.o.days_outstanding || a.i - b.i)
    .map((x) => x.o);
}

const ageKind = (days: number): "success" | "warning" | "danger" =>
  days <= 7 ? "success" : days <= 15 ? "warning" : "danger";

export interface DuesActions {
  /** The row's one filled button — "Record payment" (DuesPayButton, R-1697). */
  payButton: (o: OutstandingRow) => React.ReactNode;
  onRemind: (o: OutstandingRow) => void;
  onSuspend: (o: OutstandingRow) => void;
  onResume: (o: OutstandingRow) => void;
  onWriteOff: (o: OutstandingRow) => void;
}

/** "⋯" — the row's other actions. */
function DuesMoreMenu({ o, actions }: { o: OutstandingRow; actions: DuesActions }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`More actions for ${o.customer_name}`}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2 data-[state=open]:text-ink"
        >
          <Icon name="more_h" size={20} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[11rem]">
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => actions.onRemind(o)}>
          <Icon name="mail" size={14} /> Remind
        </DropdownMenuItem>
        {o.status === "active" ? (
          <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => actions.onSuspend(o)}>
            <Icon name="lock" size={14} /> Suspend
          </DropdownMenuItem>
        ) : o.status === "paused" ? (
          <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => actions.onResume(o)}>
            <Icon name="play" size={14} /> Resume
          </DropdownMenuItem>
        ) : null}
        {canWriteOffDue(o) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer text-rose focus:text-rose" onClick={() => actions.onWriteOff(o)}>
              <Icon name="x_circle" size={14} /> Write off
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The agreed-due-date chip (postpaid credit clock) — same function as /subscriptions. */
function DueChip({ o }: { o: OutstandingRow }) {
  const due = paymentDueState(o.payment_due_date, todayIST(), o.outstanding_amount);
  if (due.kind === "none") return null;
  return (
    <Badge
      kind={due.kind === "overdue" ? "danger" : due.kind === "upcoming" ? "muted" : "warning"}
      size="sm"
      title={`Agreed due date ${formatDate(o.payment_due_date!)}`}
    >
      {paymentDueChipLabel(due, formatDate(o.payment_due_date!))}
    </Badge>
  );
}

/** Not active → say so beside the plan (the Status column is gone; active is the norm). */
function StatusNote({ o }: { o: OutstandingRow }) {
  if (o.status === "active") return null;
  return <Badge kind={o.status === "paused" ? "warning" : "muted"} size="sm">{o.status}</Badge>;
}

const lastReminder = (o: OutstandingRow) =>
  o.last_reminder_at ? formatDate(o.last_reminder_at) : <span className="italic">never</span>;

export function SubscriptionDuesList({
  rows,
  readOnly,
  actions,
}: {
  rows: readonly OutstandingRow[];
  /** R-255: a view-only role (the accountant) sees the rows with no action buttons. */
  readOnly: boolean;
  actions: DuesActions;
}) {
  const [all, setAll] = React.useState(false);
  const ordered = React.useMemo(() => duesOrder(rows), [rows]);
  const shown = all ? ordered : ordered.slice(0, DUES_FIRST);

  return (
    <div data-dues-list="">
      {/* Cards — every width below 1280px (phone, tablet, laptop with the sidebar). */}
      <ul className="xl:hidden space-y-2" aria-label="Subscription dues">
        {shown.map((o) => (
          <li key={o.subscription_id} data-dues-row="" className="rounded-lg border border-hairline bg-paper p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-ink truncate">{o.customer_name}</p>
                <p className="text-2xs text-ink-3 truncate mt-0.5">{o.plan}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge kind={ageKind(o.days_outstanding)} size="sm" dot title={`Age counted from ${formatDate(o.age_from)}. ${DUES_AGE_LEGEND}`}>
                    {o.days_outstanding}d
                  </Badge>
                  <DueChip o={o} />
                  <StatusNote o={o} />
                  <span className="text-3xs text-ink-3">Last reminder {lastReminder(o)}</span>
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="font-serif text-base tabular-nums text-rose">{rupee(o.outstanding_amount)}</p>
                <p className="text-3xs text-ink-3">of {rupee(o.total_quote_amount)}</p>
              </div>
            </div>
            {!readOnly && (
              <div className="mt-2 flex items-center justify-end gap-1 border-t border-hairline/60 pt-2">
                {actions.payButton(o)}
                <DuesMoreMenu o={o} actions={actions} />
              </div>
            )}
          </li>
        ))}
      </ul>

      {/* Table — 1280px and up. No inner max-height box: the page is the only scroll. */}
      <div className="hidden xl:block rounded-md border border-hairline bg-paper">
        <table className="w-full">
          <thead className="bg-paper-2 border-b border-hairline">
            <tr>
              <th className="text-left p-2 text-3xs uppercase tracking-wider font-semibold text-ink-3">Customer</th>
              <th className="text-right p-2 text-3xs uppercase tracking-wider font-semibold text-ink-3">Balance due</th>
              <th className="text-left p-2 text-3xs uppercase tracking-wider font-semibold text-ink-3 cursor-help" title={DUES_AGE_LEGEND}>
                Age <Icon name="info" size={10} className="inline align-[-1px]" />
              </th>
              <th className="text-left p-2 text-3xs uppercase tracking-wider font-semibold text-ink-3">Last reminder</th>
              <th className="text-right p-2 text-3xs uppercase tracking-wider font-semibold text-ink-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((o) => (
              <tr key={o.subscription_id} data-dues-row="" className="border-b border-hairline last:border-0 hover:bg-paper-2/40">
                <td className="p-2">
                  <div className="font-medium text-sm text-ink">{o.customer_name}</div>
                  <div className="flex flex-wrap items-center gap-1.5 text-3xs text-ink-3">
                    <span>{o.plan}</span>
                    <StatusNote o={o} />
                  </div>
                </td>
                {/* R-1701: of THIS subscription's quote, not the customer's total. */}
                <td className="p-2 text-right" title={o.quote_id ? `Received ${rupee(o.paid_amount)} on ${o.quote_id}` : `Received ${rupee(o.paid_amount)} on this subscription's quote`}>
                  <div className="tabular-nums text-sm font-medium text-rose">{rupee(o.outstanding_amount)}</div>
                  <div className="tabular-nums text-3xs text-ink-3">of {rupee(o.total_quote_amount)}</div>
                </td>
                <td className="p-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge kind={ageKind(o.days_outstanding)} dot title={`Age counted from ${formatDate(o.age_from)}`}>{o.days_outstanding}d</Badge>
                    <DueChip o={o} />
                  </div>
                </td>
                <td className="p-2 text-xs text-ink-3">{lastReminder(o)}</td>
                <td className="p-2 text-right">
                  {readOnly ? <span className="text-2xs text-ink-3">View only</span> : (
                    <div className="flex items-center justify-end gap-1">
                      {actions.payButton(o)}
                      <DuesMoreMenu o={o} actions={actions} />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {ordered.length > DUES_FIRST && (
        <div className="mt-2 flex justify-center">
          <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)} aria-expanded={all}>
            {all ? "Show fewer" : `Show all ${ordered.length}`}
          </Button>
        </div>
      )}
    </div>
  );
}
