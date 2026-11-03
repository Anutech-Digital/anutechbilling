/**
 * Renewals — ONE work queue (R-2403, 3 Nov 2026; was the prototype C8 bucket cards).
 *
 * Layout:
 *   - Page header (eyebrow/title/subtitle + Export / Bulk reminder)
 *   - Tiles (R-2405, tiles.ts): Overdue · Due in 30 / 31–60 / 61–90 days · Won't renew ·
 *     Renewed this month — count + renewal ₹; a press shows exactly those rows in the queue
 *   - Forecast strip (closed by default, R-2266): 6-month forecast, Renewal AI top pick
 *   - Grace over list (R-1621)
 *   - The queue: tabs Overdue · ≤7 days · 8–30 · 31–60 · 61–90 (every row in exactly one —
 *     queue.ts queueTabs); search, sort (date / amount), filters (product, status, vendor, At
 *     risk chip); a table from 1280px (cards on smaller screens) with customer + contact,
 *     product + seats, renewal date, the renewal AMOUNT for the term, ONE status chip
 *     (queue.ts renewalRowStatus) and the shared RenewalActions (R-2401); tick rows → bulk
 *     Send renewal quote / Send reminder.
 *
 * Risk model — REAL signals only (see renewalRisk):
 *   - Seat utilisation (used/seats) — only when seats were actually checked (R-453)
 *   - Unpaid balance on the current term
 *   - Plan tier (starter churns a little more)
 *   (Fabricated login/tickets/NPS signals were removed — misleading on a money screen.)
 */
"use client";

import * as React from "react";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { RENEWAL_BUCKETS } from "@/lib/navigation/drilldown";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSubscriptions, useOpenRenewalQuotes } from "@/lib/queries/subscriptions";
import { renewalForecast } from "@/lib/renewals/forecast";
import { toast } from "sonner";
import { EmptyState } from "@/components/shared/empty-state";
import { loadErrorBody } from "@/components/shared/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { Icon } from "@/components/ui/icon";
import { FAB } from "@/components/ui/fab";
import { BulkActionBar, BulkBarButton } from "@/components/ui/bulk-action-bar";
import { rupee, formatDate } from "@/lib/utils";
import { daysUntilRenewal, onRenewalsPage, RENEWAL_FUTURE_DAYS } from "@/lib/renewals/buckets";
import { cn } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import type { Subscription } from "@/lib/supabase/database.types";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canOpenQuotes } from "@/lib/quotes/access";
import { useQueryClient } from "@tanstack/react-query";
import { useConfirm } from "@/components/providers/confirm-provider";
import { Input } from "@/components/ui/input";
import {
  bulkReminderTargets,
  bulkReminderConfirm,
  matchesRenewalSearch,
  readJsonSafe,
  sendBulkReminders,
  bulkReminderReport,
  RENEWAL_QUOTE_VERBS,
  type RenewalRowLike,
} from "./reminders";
import { renewalRisk } from "./risk";
import { priorTermDueText } from "./prior-due";
import { openRenewalQuoteMap, openRenewalQuoteStatus, withRenewalQuote } from "./open-renewal-quotes";
import { renewalRowAction, type RowAction } from "./row-action";
import { GraceOverCard } from "./grace-over-card";
import { classifyRenewals, chasedRenewal, isFlexNextPart } from "./classify";
import {
  QUEUE_TABS, QUEUE_TAB_LABEL, QUEUE_TABLE_COLS, LEGACY_BUCKETS, STATUS_FILTER_LABEL, NO_FILTERS,
  queueTabs, resolveBucket, renewalRowStatus, renewalAmount, isPaidRenewalQuote,
  sortQueue, filterQueue, filterOptions, bulkQuoteTargets, bulkQuoteConfirm,
  type QueueTab, type LegacyBucket, type QueueFilters, type QueueSort, type RowStatus, type RenewalAmount, type RowStatusKey,
} from "./queue";
import { useRenewalContacts, useRenewalQuoteInfo, useRenewalFollowups, useRenewalPaymentsForMonth, type RowContact } from "./queue-data";
import { monthOf, renewalTiles, tileMatches, paidRenewalsInMonth, type TileKey, type TileRow } from "./tiles";
import { RenewalTileRow, TileViewBar } from "./tiles-card";
import { ForecastPanel } from "./forecast-panel";
import { renewalFrequency } from "./frequency";
import { useRenewalLastPaid } from "./last-paid-data";
import { LastPaidLine, canOpenInvoices } from "./last-paid-cell";
import {
  renewalFollowup, renewalDecision, showDecision, filterByFollowup, bulkAssignRequests, bulkAssignReport,
  DECISION_LABEL, DECISION_TONE, NO_FOLLOWUP_FILTERS, ASSIGN_NEEDS_ROLE,
  type RenewalFollowup, type RenewalDecision, type FollowupFilters,
} from "./followup";
import { FollowupDialog } from "@/components/features/collections/followup-dialog";
import { postFollowup, FollowupSaveError } from "@/lib/queries/payment-followups";
import { mayReassignFollowup } from "@/lib/collections/followup-rules";
import { useUserNames, type UserName } from "@/lib/hooks/useUserNames";
import { istToday } from "@/lib/dates/ist";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { isNonRenewing } from "@/lib/subscriptions/non-renewing";
import { VendorHoldBadge } from "@/components/features/subscriptions/vendor-hold-badge";
import { RenewalActions } from "@/components/features/renewals/renewal-actions";
import { isGraceOver } from "@/components/features/renewals/renewal-actions-rules";
import { CollapsibleKpiStrip, StripFact, StripLink } from "@/components/shared/collapsible-kpi-strip";

// ─── Vendor logo pill ─────────────────────────────────────────────────────────

function VendorPill({ vendor }: { vendor: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    google:    { label: "Google",    cls: "bg-blue-50 text-blue-700" },
    microsoft: { label: "Microsoft", cls: "bg-indigo-50 text-indigo-700" },
    zoho:      { label: "Zoho",      cls: "bg-amber-50 text-amber-700" },
    other:     { label: "Other",     cls: "bg-muted text-muted-foreground" },
  };
  const v = map[vendor] ?? { label: vendor ? vendor[0].toUpperCase() + vendor.slice(1) : "Other", cls: map.other.cls };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium",
        v.cls,
      )}
    >
      {v.label}
    </span>
  );
}

// ─── R-2232: the row's renewal-quote line ("Renewal sent Q-x · due …") ─────────

function RowActionLine({ action, canQuotes, className }: { action: RowAction; canQuotes: boolean; className?: string }) {
  /* R-2403: only the quote line — "Renewed — nothing to send" / "Service stopped" is the status chip. */
  if (!action.text || !action.quoteId) return null;
  const q = action.quoteId;
  const at = action.text.indexOf(q);
  if (at < 0) return <p className={cn("text-ink-3", className)}>{action.text}</p>;
  return (
    <p className={cn("text-ink-2", className)}>
      {action.text.slice(0, at)}
      {canQuotes ? (
        <Link href={`/quotes/${q}` as never} className="font-mono underline underline-offset-2 hover:text-ink">{q}</Link>
      ) : (
        <span className="font-mono">{q}</span>
      )}
      {action.text.slice(at + q.length)}
    </p>
  );
}

// ─── Row pieces ───────────────────────────────────────────────────────────────

function StatusChip({ status, size }: { status: RowStatus; size?: "sm" }) {
  return (
    <div className="min-w-0">
      <Badge kind={status.tone} size={size} dot>{status.label}</Badge>
      {status.note && <p className="mt-1 text-2xs font-medium text-rose-600">{status.note}</p>}
    </div>
  );
}

function ContactLine({ contact }: { contact: RowContact | undefined }) {
  if (!contact || (!contact.phone && !contact.email)) {
    return <p className="mt-0.5 text-2xs text-ink-3">No contact on file</p>;
  }
  return (
    <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-2xs text-ink-3">
      {contact.phone && (
        <a href={`tel:${contact.phone.replace(/\s+/g, "")}`} className="inline-flex items-center gap-1 hover:text-ink" title={contact.name ? `Call ${contact.name}` : "Call"}>
          <Icon name="phone" size={11} className="shrink-0" />{contact.phone}
        </a>
      )}
      {contact.email && (
        <a href={`mailto:${contact.email}`} className="inline-flex min-w-0 items-center gap-1 hover:text-ink" title={contact.email}>
          <Icon name="mail" size={11} className="shrink-0" /><span className="truncate">{contact.email}</span>
        </a>
      )}
    </p>
  );
}

/** R-2422: the second line says how it is paid, in the Subscriptions list's words (frequency.ts). */
function AmountCell({ amount, frequency, className }: { amount: RenewalAmount; frequency: string | null; className?: string }) {
  return (
    <div className={className}>
      <p className="font-medium tabular-nums text-ink">{amount.text}</p>
      <p className="text-2xs text-ink-3">{amount.gst}</p>
      {frequency && <p className="text-2xs text-ink-2">{frequency}</p>}
    </div>
  );
}

function AtRiskMark({ reason }: { reason: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 text-2xs font-medium text-rose-600" title={reason}>
      <Icon name="alert" size={11} className="shrink-0" />At risk
    </span>
  );
}

/**
 * R-2404: where the customer's decision stands, who works the renewal and when they follow up
 * next, the promise to pay. Under the ONE status chip; "Paid" / "Won't renew" are that chip already.
 */
function FollowupLine({ followup, decision, names }: { followup: RenewalFollowup; decision: RenewalDecision; names: Map<string, UserName> | undefined }) {
  const owner = followup.ownerId ? names?.get(followup.ownerId)?.label ?? "a colleague" : null;
  return (
    <div className="mt-1.5 space-y-0.5 text-2xs">
      {showDecision(decision) && <Badge kind={DECISION_TONE[decision]} size="sm">{DECISION_LABEL[decision]}</Badge>}
      <p className={cn("truncate", owner ? "text-ink-2" : "text-ink-3")} title={owner ? `Owner: ${owner}` : "No owner yet"}>
        <Icon name="user" size={10} className="mr-0.5 inline shrink-0" />{owner ?? "No owner"}
      </p>
      {followup.nextFollowUpOn && (
        <p className={cn("tabular-nums", followup.followUpDue ? "font-medium text-rose-600" : "text-ink-3")}>
          Next: {formatDate(followup.nextFollowUpOn)}
        </p>
      )}
      {followup.promisedOn && followup.promiseStatus !== "kept" && (
        <p className={cn("tabular-nums", followup.promiseBroken ? "font-medium text-rose-600" : "text-ink-2")}>
          {followup.promiseBroken ? "Promise broken" : "Promised"} · {formatDate(followup.promisedOn)}
          {followup.promisedAmount ? ` · ${rupee(followup.promisedAmount)}` : ""}
        </p>
      )}
    </div>
  );
}

/** R-2404: bulk "Assign owner" — pick a person; each ticked renewal gets a follow-up given to them. */
function AssignOwnerDialog({
  open, onOpenChange, count, team, onAssign, busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  team: UserName[];
  onAssign: (person: UserName) => void;
  busy: boolean;
}) {
  const [pick, setPick] = React.useState("");
  React.useEffect(() => { if (open) setPick(""); }, [open]);
  const person = team.find((u) => u.id === pick);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign owner</DialogTitle>
          <DialogDescription>
            Give the {count} selected renewal{count === 1 ? "" : "s"} to one person. It shows in their &quot;Mine&quot; list and in each renewal&apos;s follow-up history.
          </DialogDescription>
        </DialogHeader>
        <label htmlFor="assign-owner" className="text-xs font-semibold uppercase tracking-wider text-ink-3">Owner</label>
        <select id="assign-owner" value={pick} onChange={(e) => setPick(e.target.value)} className={cn(SELECT_CLS, "w-full min-h-[44px] md:min-h-0 text-sm")}>
          <option value="">Pick a person</option>
          {team.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
        </select>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="primary" icon="check" disabled={!person} loading={busy} onClick={() => person && onAssign(person)}>
            {person ? `Give ${count} to ${person.label}` : "Assign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── The queue (table ≥1280px, cards below) ───────────────────────────────────

interface QueueItem {
  sub: Subscription;
  daysUntil: number;
  status: RowStatus;
  amount: RenewalAmount;
  contact: RowContact | undefined;
  atRisk: boolean;
  riskReason: string;
  /** R-2404 */
  followup: RenewalFollowup;
  decision: RenewalDecision;
  customerOwnerId: string | null;
}

interface RenewalQueueProps {
  rows: QueueItem[];
  graceDays: number;
  strong: boolean;
  selected: ReadonlySet<string>;
  onSelect: (ids: string[], on: boolean) => void;
  emptyText: string;
  /** R-2404: open the renewal's Follow-up dialog. */
  onFollowup: (item: QueueItem) => void;
  names: Map<string, UserName> | undefined;
}

function RenewalQueue({ rows, graceDays, strong, selected, onSelect, emptyText, onFollowup, names }: RenewalQueueProps) {
  /* R-237: billing + support see Renewals but cannot open /quotes (middleware sends them
     home) — no "Open quote" link for them. */
  const { data: me } = useCurrentUser();
  const canQuotes = canOpenQuotes(me?.role);
  /* R-2232: draft vs sent for the row's "Renewal sent Q-x" line (same cached query as the page). */
  const { data: openRenewals } = useOpenRenewalQuotes();
  const quoteStatus = React.useMemo(() => openRenewalQuoteStatus(openRenewals ?? []), [openRenewals]);
  /* R-2422: last paid for every row on screen — one batched, paged read (last-paid-data.ts). */
  const { data: lastPaid, isLoading: lastPaidLoading } = useRenewalLastPaid(rows.map((r) => r.sub));
  const canInvoices = canOpenInvoices(me?.role);
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.sub.id));
  const someOn = rows.some((r) => selected.has(r.sub.id));

  if (rows.length === 0) {
    return <div className="py-10 text-center text-sm text-ink-3">{emptyText}</div>;
  }

  const byId = new Map(rows.map((r) => [r.sub.id, r]));
  /* R-2404: owner, next date, promise, notes, "confirmed" — Payment Follow-up's dialog, for this renewal.
     R-2422: it, Nudge and Voice note sit behind the row's ONE next-step button + ⋯ (RenewalActions). */
  const followupFor = (sub: Subscription) => (sub.customer_id ? () => { const it = byId.get(sub.id); if (it) onFollowup(it); } : undefined);
  const lastPaidFor = (sub: Subscription, className?: string) => (
    <LastPaidLine paid={lastPaid?.get(sub.id)} loading={lastPaidLoading} canInvoices={canInvoices} canQuotes={canQuotes} className={className} />
  );

  return (
    <>
      {/* Cards — viewports < 1280px (phones and small laptops), two per row from md. */}
      <ul className="xl:hidden p-3 space-y-2 md:grid md:grid-cols-2 md:gap-2 md:space-y-0">
        {rows.map(({ sub, daysUntil: days, status, amount, contact, atRisk, riskReason, followup, decision }) => {
          const priorDue = priorTermDueText(sub);  // R-1703
          const action = renewalRowAction(sub, quoteStatus.get(sub.renewal_quote_id ?? "") ?? null);  // R-2232
          return (
            <li key={sub.id} className="bg-paper border border-hairline rounded-lg p-3">
              <div className="flex items-start gap-2.5 mb-2">
                <input
                  type="checkbox"
                  aria-label={`Select ${sub.customer_name} — ${sub.plan}`}
                  className="mt-1 cursor-pointer accent-amber"
                  checked={selected.has(sub.id)}
                  onChange={(e) => onSelect([sub.id], e.target.checked)}
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink truncate">{sub.customer_name}</p>
                  <p className="text-2xs text-ink-3 truncate mt-0.5">
                    {sub.plan} · {sub.seats} seats
                  </p>
                  <ContactLine contact={contact} />
                  {lastPaidFor(sub, "mt-0.5")}
                </div>
                <AmountCell amount={amount} frequency={renewalFrequency(sub)} className="text-right shrink-0" />
              </div>

              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <StatusChip status={status} size="sm" />
                  <FollowupLine followup={followup} decision={decision} names={names} />
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs text-ink-2">{sub.renewal_date ? formatDate(sub.renewal_date) : "—"}</p>
                  {atRisk && <AtRiskMark reason={riskReason} />}
                </div>
              </div>

              {/* R-1796: unpaid past the renewal date — the vendor renewal waits for the payment.
                  R-2401: grace over → it sits next to Cancel in the actions below. */}
              {!isGraceOver(sub, days, graceDays) && (
                <div className="mb-2 empty:hidden">
                  <VendorHoldBadge sub={sub} />
                </div>
              )}

              {priorDue && (
                <p role="status" className="mb-2 flex items-center gap-1 text-xs font-medium text-rose-600">
                  <Icon name="alert" size={12} className="shrink-0" />
                  {priorDue}
                </p>
              )}

              {/* R-2232: "Renewal sent Q-x · due …" — never a second Generate. */}
              <RowActionLine action={action} canQuotes={canQuotes} className="mb-2 text-xs" />

              <div className="pt-2 border-t border-hairline/60">
                <RenewalActions sub={sub} daysUntil={days} layout="card" strong={strong} onFollowup={followupFor(sub)} messaging />
              </div>
            </li>
          );
        })}
      </ul>

      {/* Desktop table — viewports >= 1280px. Column budget in queue.ts (QUEUE_TABLE_COLS) keeps it
          inside the ~944px card with the sidebar open, Actions always on screen (R-2403). */}
      <div className="hidden xl:block">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            {QUEUE_TABLE_COLS.map((c) => (
              <col key={c.key} style={c.width != null ? { width: c.width } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-hairline bg-muted/30">
              <th className="px-2 py-2.5">
                <input
                  type="checkbox"
                  aria-label="Select all renewals on screen"
                  className="cursor-pointer accent-amber"
                  checked={allOn}
                  ref={(el) => { if (el) el.indeterminate = someOn && !allOn; }}
                  onChange={(e) => onSelect(rows.map((r) => r.sub.id), e.target.checked)}
                />
              </th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-ink-3">Customer</th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-ink-3">Product</th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-ink-3">Renewal date</th>
              <th className="px-3 py-2.5 text-right text-xs font-medium text-ink-3">Renewal amount</th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-ink-3">Status</th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-ink-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ sub, daysUntil: days, status, amount, contact, atRisk, riskReason, followup, decision }) => {
              const priorDue = priorTermDueText(sub);  // R-1703
              const action = renewalRowAction(sub, quoteStatus.get(sub.renewal_quote_id ?? "") ?? null);  // R-2232
              return (
                <tr key={sub.id} className="border-b border-hairline last:border-0 align-top hover:bg-muted/20">
                  <td className="px-2 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${sub.customer_name} — ${sub.plan}`}
                      className="cursor-pointer accent-amber"
                      checked={selected.has(sub.id)}
                      onChange={(e) => onSelect([sub.id], e.target.checked)}
                    />
                  </td>

                  {/* Customer + contact */}
                  <td className="px-3 py-3 min-w-0">
                    {sub.customer_id ? (
                      <Link href={`/customers/${sub.customer_id}` as never} className="block truncate font-semibold text-ink hover:underline" title={sub.customer_name}>
                        {sub.customer_name}
                      </Link>
                    ) : (
                      <p className="truncate font-semibold text-ink" title={sub.customer_name}>{sub.customer_name}</p>
                    )}
                    <ContactLine contact={contact} />
                    {lastPaidFor(sub, "mt-0.5")}
                    {atRisk && <AtRiskMark reason={riskReason} />}
                  </td>

                  {/* Product · seats · vendor */}
                  <td className="px-3 py-3 min-w-0">
                    <p className="truncate text-ink" title={sub.plan ?? undefined}>{sub.plan}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink-3">
                      <span className="tabular-nums">{sub.seats} seats</span>
                      <VendorPill vendor={sub.vendor} />
                    </p>
                  </td>

                  {/* Renewal date + reminders sent */}
                  <td className="px-3 py-3">
                    <p className="text-ink">{sub.renewal_date ? formatDate(sub.renewal_date) : "—"}</p>
                    {sub.reminder_count > 0 && (
                      <p className="mt-1 text-2xs text-ink-3 tabular-nums">
                        {sub.reminder_count} email{sub.reminder_count === 1 ? "" : "s"} sent
                      </p>
                    )}
                  </td>

                  {/* Renewal amount for the term */}
                  <td className="px-3 py-3 text-right">
                    <AmountCell amount={amount} frequency={renewalFrequency(sub)} />
                    {priorDue && (
                      <p role="status" className="mt-1 text-2xs font-medium text-rose-600" title="Paying the renewal quote covers only the new term — record the earlier amount separately under Payments → Subscription dues.">
                        {priorDue}
                      </p>
                    )}
                  </td>

                  {/* ONE status */}
                  <td className="px-3 py-3">
                    <StatusChip status={status} />
                    <FollowupLine followup={followup} decision={decision} names={names} />
                  </td>

                  {/* Actions */}
                  <td className="px-3 py-3">
                    <div className="flex flex-col items-start gap-1.5">
                      <RowActionLine action={action} canQuotes={canQuotes} className="text-2xs" />
                      {!isGraceOver(sub, days, graceDays) && (
                        <div className="empty:hidden">
                          <VendorHoldBadge sub={sub} />
                        </div>
                      )}
                      <RenewalActions sub={sub} daysUntil={days} layout="table" strong={strong} onFollowup={followupFor(sub)} messaging />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const SELECT_CLS = "bg-paper border border-hairline rounded-md text-xs px-2.5 py-1.5 font-medium text-ink focus:outline-none focus:border-amber cursor-pointer";

export default function RenewalsPage() {
  const { data: subs, isLoading, error, refetch } = useSubscriptions();
  /* R-453: an open renewal quote whose link-back is missing still shows "Open quote". */
  const { data: openRenewals } = useOpenRenewalQuotes();
  const openRenewalMap = React.useMemo(() => openRenewalQuoteMap(openRenewals ?? []), [openRenewals]);
  const quoteStatusMap = React.useMemo(() => openRenewalQuoteStatus(openRenewals ?? []), [openRenewals]);
  const { data: me } = useCurrentUser();
  const qc = useQueryClient();
  const router = useRouter();
  /* R-118 / R-2403: ?bucket= holds the tab; the old values (urgent / upcoming / future / risk —
     the sidebar badge opens ?bucket=urgent) still open the right tab (queue.ts resolveBucket). */
  const [bucketRaw, setBucketTab] = useUrlChoice<string>("bucket", RENEWAL_BUCKETS, "urgent");
  const [bulkSending, setBulkSending] = React.useState(false);
  const confirm = useConfirm();
  /* R-239: customer / domain search across the tabs (KPIs stay whole-book). */
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState<QueueSort>("date");
  const [filters, setFilters] = React.useState<QueueFilters>(NO_FILTERS);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const graceDays = me?.tenantGracePeriodDays ?? 0;
  const today = new Date();
  /* R-2405: the pressed tile (null = the tabs) and this IST month's paid renewals. */
  const [tile, setTile] = React.useState<TileKey | null>(null);
  const month = monthOf(istToday(today));
  const { data: monthQuotes } = useRenewalPaymentsForMonth(month);

  /* Rows on the page within 90 days: their contacts and renewal quotes (hooks run before any early return). */
  const listed = React.useMemo(() => (subs ?? [])
    .filter(onRenewalsPage)
    .map((s) => withRenewalQuote(s, openRenewalMap))
    .filter((s) => daysUntilRenewal(s.renewal_date!) <= RENEWAL_FUTURE_DAYS), [subs, openRenewalMap]);
  const { data: contacts } = useRenewalContacts(listed.map((s) => s.customer_id ?? "").filter(Boolean));
  const { data: quoteInfo } = useRenewalQuoteInfo(listed.map((s) => s.renewal_quote_id));
  /* R-2404: owner / next follow-up / promise per renewal — Payment Follow-up's rows for these subscriptions. */
  const { data: fuData } = useRenewalFollowups(listed.map((s) => s.id), listed.map((s) => s.customer_id ?? ""));
  const { data: names } = useUserNames();
  const [fuFilters, setFuFilters] = React.useState<FollowupFilters>(NO_FOLLOWUP_FILTERS);
  const [followupFor, setFollowupFor] = React.useState<QueueItem | null>(null);
  const [assignOpen, setAssignOpen] = React.useState(false);
  const [assigning, setAssigning] = React.useState(false);
  const canReassign = mayReassignFollowup(me?.role);
  const team = React.useMemo(
    () => [...(names?.values() ?? [])].filter((u) => !u.inactive).sort((a, b) => a.label.localeCompare(b.label)),
    [names],
  );

  if (isLoading) {
    return (
      <div className="p-8 space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon="alert"
        title="Could not load renewals"
        body={loadErrorBody(error)}
        action={
          <Button variant="default" icon="refresh" onClick={() => void refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  const all = subs ?? [];

  // Top-level empty state — a tenant with zero subscriptions saw an all-zeros
  // StatStrip + three empty buckets (and on mobile, fully blank buckets). Give
  // them a single clear "nothing to renew yet" state that points at how
  // subscriptions get created (a paid quote converts a lead into a subscription).
  if (all.length === 0) {
    return (
      <div className="mx-auto max-w-[1800px] px-4 md:px-8 pb-20 pt-7">
        <div className="mb-6">
          <h1 className="font-serif text-2xl md:text-3xl text-ink">Renewals</h1>
          <p className="text-sm text-ink-3 mt-1">Stay ahead of every subscription renewal — before service lapses.</p>
        </div>
        <Card>
          <EmptyState
            icon="refresh"
            title="No subscriptions to renew yet"
            body="Renewals show up here automatically once you have active subscriptions. A subscription is created when a customer pays for a recurring quote — so send a quote and record the payment to get started."
            action={canOpenQuotes(me?.role)
              ? <Button variant="primary" icon="send" onClick={() => router.push("/quotes/new" as never)}>Create a quote</Button>
              : undefined}
            secondary={<Button variant="default" icon="users" onClick={() => router.push("/customers" as never)}>View customers</Button>}
          />
        </Card>
      </div>
    );
  }

  // Enrich with days-until-renewal (skip cancelled / no-date)
  /* R-1541: the bucket rules live in lib/renewals/buckets.ts — the sidebar's Renewals badge
     (nav_badges) counts Overdue + ≤7 days with the same numbers and opens ?bucket=urgent. */
  const enriched = all
    .filter(onRenewalsPage)
    .map((s) => ({
      sub: withRenewalQuote(s, openRenewalMap),
      daysUntil: daysUntilRenewal(s.renewal_date!, today),
    }));

  /* R-1124: ONE classification (./classify.ts) feeds every number and list on this page.
     R-2403: a renewal whose quote is paid leaves Overdue (renewedPaid). */
  const quoteOf = (sub: Subscription) => quoteInfo?.get(sub.renewal_quote_id ?? "");
  const paid = (r: { sub: Subscription }) => isPaidRenewalQuote(r.sub, quoteOf(r.sub));
  const groups   = classifyRenewals(enriched, (r) => renewalRisk(r.sub).level === "high", today, paid);
  const tabs     = queueTabs(groups);

  /* Forecast (audit B7): agle 6 mahine, mahina-war — "is quarter kitna aayega?"
     ab list jodne se nahi, curve se dikhta hai. Flex alag (12x-sabak: forecast.ts). */
  /* R-2225: a Won't renew subscription brings no renewal money. */
  const forecast = renewalForecast(all.filter(chasedRenewal), new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));

  /* R-2225: the renewals pipeline export leaves out Won't renew subscriptions. */
  /* R-2232: nor a flex subscription's next monthly part (a billing part, not a renewal). */
  const upcoming90   = enriched.filter((r) => r.daysUntil >= 0 && r.daysUntil <= 90 && chasedRenewal(r.sub) && !isFlexNextPart(r.sub, r.daysUntil));
  const highRiskSubs = groups.atRisk;
  const atRiskIds    = new Set(highRiskSubs.map((r) => r.sub.id));

  /* R-2403: each listed row gets its ONE status, its renewal amount and its contact. */
  const todayIst = istToday(today);
  const toItem = (r: { sub: Subscription; daysUntil: number }): QueueItem => {
    const risk = renewalRisk(r.sub);
    const status = renewalRowStatus(r.sub, r.daysUntil, { tenantGraceDays: graceDays, today, renewalPaid: paid(r) });
    /* R-2404: the renewal's follow-up state + where the decision stands. */
    const customerOwnerId = r.sub.customer_id ? fuData?.ownerByCustomer.get(r.sub.customer_id) ?? null : null;
    const followup = renewalFollowup(r.sub.id, fuData?.rows ?? [], { customerOwnerId, today: todayIst, paid: status.key === "renewed" });
    const linkedQuote = quoteOf(r.sub);
    return {
      sub: r.sub,
      daysUntil: r.daysUntil,
      status,
      followup,
      customerOwnerId,
      decision: renewalDecision(r.sub, {
        statusKey: status.key,
        /* the draft/sent status from the open renewal quotes, else the linked quote's own */
        quote: r.sub.renewal_quote_id
          ? { id: r.sub.renewal_quote_id, status: quoteStatusMap.get(r.sub.renewal_quote_id) ?? linkedQuote?.status ?? null, payment_status: linkedQuote?.payment_status ?? null }
          : null,
        followup,
      }),
      amount: renewalAmount(r.sub, quoteOf(r.sub)),
      contact: r.sub.customer_id ? contacts?.get(r.sub.customer_id) : undefined,
      atRisk: atRiskIds.has(r.sub.id),
      riskReason: [
        ...(isNonRenewing(r.sub) ? ["Customer said they won't renew"] : []),
        ...(r.daysUntil < 0 ? [`Renewal ${Math.abs(r.daysUntil)}d overdue, not paid`] : []),
        ...risk.reasons.filter((x) => x !== "Seat usage not checked"),
      ].join(" · ") || "High renewal risk",
    };
  };
  const items = {} as Record<QueueTab, QueueItem[]>;
  for (const t of QUEUE_TABS) items[t] = tabs[t].map(toItem);
  const allItems = QUEUE_TABS.flatMap((t) => items[t]);

  /* R-2405: the tiles add up the rows' own renewal amounts; a pressed tile lists those rows. */
  const tileRowOf = new Map<string, TileRow>(QUEUE_TABS.flatMap((t) => items[t].map((i) => [i.sub.id, {
    id: i.sub.id, tab: t, statusKey: i.status.key, amount: i.amount.value, renewalDate: i.sub.renewal_date,
  }] as const)));
  const tileFigures = renewalTiles([...tileRowOf.values()], monthQuotes ?? [], month);
  const paidSubs = new Set(paidRenewalsInMonth(monthQuotes ?? [], month).map((q) => q.renewal_subscription_id ?? ""));

  const counts = Object.fromEntries(QUEUE_TABS.map((t) => [t, tabs[t].length])) as Record<QueueTab, number>;
  const resolved = (LEGACY_BUCKETS as readonly string[]).includes(bucketRaw)
    ? resolveBucket(bucketRaw as LegacyBucket, counts)
    : resolveBucket(bucketRaw as QueueTab, counts);
  const bucketTab = resolved.tab;
  const atRiskOn = filters.atRisk || resolved.atRisk;
  const activeFilters: QueueFilters = { ...filters, atRisk: atRiskOn };

  /* R-239: the search narrows the tabs (and their counts) only; R-2403: so do the filters. */
  const asQueueRow = (i: QueueItem) => ({
    id: i.sub.id, daysUntil: i.daysUntil, amount: i.amount.value, plan: i.sub.plan, vendor: i.sub.vendor,
    statusKey: i.status.key, atRisk: i.atRisk, customer: i.sub.customer_name, item: i,
  });
  /* R-2404: Mine · Follow-up due · Promise broken narrow the tabs the same way. */
  const narrow = (list: QueueItem[]): QueueItem[] =>
    sortQueue(filterQueue(filterByFollowup(list, fuFilters, me?.userId).filter((i) => matchesRenewalSearch(i.sub, search)).map(asQueueRow), activeFilters), sort)
      .map((r) => r.item);
  const shown = Object.fromEntries(QUEUE_TABS.map((t) => [t, narrow(items[t])])) as Record<QueueTab, QueueItem[]>;
  /* R-2405: a pressed tile lists its rows from every tab (search / filters / sort still apply). */
  const tileShown = narrow(tile ? allItems.filter((i) => tileMatches(tile, tileRowOf.get(i.sub.id)!, month, paidSubs)) : []);

  const productOptions = filterOptions(allItems.map((i) => i.sub.plan));
  const vendorOptions  = filterOptions(allItems.map((i) => i.sub.vendor));
  const statusOptions  = (Object.keys(STATUS_FILTER_LABEL) as RowStatusKey[]).filter((k) => allItems.some((i) => i.status.key === k));
  const fuOn = fuFilters.mine || fuFilters.followUpDue || fuFilters.promiseBroken;
  const filtered = !!(filters.product || filters.status || filters.vendor || atRiskOn || fuOn);
  /* R-2404: chip counts — whole queue, so a person sees "Mine (12)" before pressing it. */
  const fuCount = (f: Partial<FollowupFilters>) => filterByFollowup(allItems, { ...NO_FOLLOWUP_FILTERS, ...f }, me?.userId).length;
  const mineCount = fuCount({ mine: true });
  const dueCount = fuCount({ followUpDue: true });
  const brokenCount = fuCount({ promiseBroken: true });

  const activeSubs    = all.filter((s) => s.status === "active").length;
  const topHighRisk   = highRiskSubs[0]?.sub.customer_name ?? "a key customer";
  // Real, computed reasons for the top high-risk sub — never fabricate signals
  // (NPS/logins) we don't collect on a money screen.
  const topReasons    = highRiskSubs[0]
    ? [
        ...(isNonRenewing(highRiskSubs[0].sub) ? ["Customer said they won't renew"] : []),
        ...(highRiskSubs[0].daysUntil < 0 ? [`Renewal ${Math.abs(highRiskSubs[0].daysUntil)}d overdue, not paid`] : []),
        ...renewalRisk(highRiskSubs[0].sub).reasons,
      ]
    : [];

  const openTab = (t: string) => { setSelected(new Set()); setTile(null); setBucketTab(t); };
  /* R-2405: press a tile → its rows; press it again → back to the tabs. */
  const pickTile = (k: TileKey) => { setSelected(new Set()); setTile((cur) => (cur === k ? null : k)); };
  const setAtRisk = (on: boolean) => {
    if (bucketRaw === "risk") setBucketTab(bucketTab);   // the old ?bucket=risk link → a plain tab + the chip
    setFilters((f) => ({ ...f, atRisk: on }));
  };
  const onSelect = (ids: string[], on: boolean) => setSelected((prev) => {
    const next = new Set(prev);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  });
  const selectedRows = allItems.filter((i) => selected.has(i.sub.id));

  // Real CSV export of the renewals pipeline (next 90 days) — raw integer ₹ so
  // Excel/Tally treat amounts as numbers. Replaces the old "coming soon" stub.
  const handleExport = () => {
    if (upcoming90.length === 0) {
      toast.info("No renewals to export in the next 90 days");
      return;
    }
    const rows = upcoming90
      .slice()
      .sort((a, b) => a.daysUntil - b.daysUntil)
      .map(({ sub, daysUntil }) => {
        const risk = renewalRisk(sub);
        return [
          sub.customer_name,
          sub.plan,
          sub.vendor,
          sub.seats,
          sub.used,
          sub.mrr,
          sub.mrr * 12,
          sub.renewal_date ? formatDate(sub.renewal_date) : "",
          daysUntil,
          sub.outstanding_amount,
          risk.label,
        ];
      });
    downloadCSV(
      "renewals-next-90-days.csv",
      ["Customer", "Plan", "Vendor", "Seats", "Used", "MRR (₹)", "ARR (₹)", "Renewal date", "Days until", "Outstanding (₹)", "Risk"],
      rows,
    );
    toast.success(`Exported ${rows.length} renewal${rows.length === 1 ? "" : "s"}`);
  };

  // Real bulk reminder — actually calls the per-sub send-now endpoint for every
  // subscription renewing within 30 days, then reports the true count (and
  // honestly flags stub email-mode). No fake "sent" toast.
  async function handleBulkReminder() {
    if (bulkSending) return;
    /* R-239: renewed / suspended customers are never reminded, and nobody is emailed
       until the operator has seen the count and the names. */
    /* R-1124: lapsed rows still in grace are included (and named apart in the confirm). */
    /* R-2225: a Won't renew row is left out inside bulkReminderTargets. */
    const targets = bulkReminderTargets(enriched, today, graceDays);
    if (targets.length === 0) { toast.info("No renewals due in the next 30 days, and none lapsed in grace"); return; }
    await sendReminders(targets);
  }

  /* R-2403: Send reminder on the ticked rows — the same rule (≤30 days or in grace) and confirm. */
  async function handleSelectedReminder() {
    if (bulkSending) return;
    const targets = bulkReminderTargets(selectedRows, today, graceDays);
    if (targets.length === 0) {
      toast.info("None of the selected renewals is due for a reminder", {
        description: "A reminder goes to renewals due in the next 30 days, or past the date and still in grace. Use Send renewal quote for the others.",
      });
      return;
    }
    await sendReminders(targets);
  }

  /* R-1642: names who failed and why, and "Retry failed" re-sends only those (after the
     same confirm — R-239: nobody is emailed without seeing the names first). */
  async function sendReminders<T extends (typeof enriched)[number]>(targets: T[]) {
    const ok = await confirm({ ...bulkReminderConfirm(targets), confirmLabel: `Email ${targets.length}`, icon: "mail" });
    if (!ok) return;
    await runSend(targets, undefined, (failed) => void sendReminders(failed));
  }

  /* R-2403: Send renewal quote on the ticked rows — each through the row's own send-now route,
     only rows whose button is Send renewal quote; the rest are named in the confirm. */
  async function handleSelectedQuote() {
    if (bulkSending) return;
    const { send, skipped } = bulkQuoteTargets(selectedRows, (id) => quoteStatusMap.get(id ?? "") ?? null, graceDays);
    if (send.length === 0) {
      toast.info("Nothing to send for the selected renewals", {
        description: skipped.slice(0, 3).map((s) => `${s.row.sub.customer_name} — ${s.reason}`).join("; "),
      });
      return;
    }
    await sendQuotes(send, skipped);
  }

  async function sendQuotes(send: QueueItem[], skipped: ReturnType<typeof bulkQuoteTargets<QueueItem>>["skipped"]) {
    const ok = await confirm({ ...bulkQuoteConfirm(send, skipped), confirmLabel: `Send ${send.length}`, icon: "mail" });
    if (!ok) return;
    await runSend(send, RENEWAL_QUOTE_VERBS, (failed) => void sendQuotes(failed, []));
  }

  async function runSend<T extends RenewalRowLike>(
    targets: T[],
    verbs: { done: string; failed: string } | undefined,
    retryFailed: (failed: T[]) => void,
  ) {
    setBulkSending(true);
    const result = await sendBulkReminders(targets, async (subscriptionId) => {
      const res = await fetch("/api/renewals/send-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription_id: subscriptionId }),
      });
      return { ok: res.ok, json: await readJsonSafe(res) };
    });
    setBulkSending(false);
    qc.invalidateQueries({ queryKey: ["subscriptions"] });
    qc.invalidateQueries({ queryKey: ["quotes"] });
    if (result.failed.length === 0) setSelected(new Set());
    const m = bulkReminderReport(result, verbs);
    const failedRows = result.failed.map((f) => f.row);
    const retry = { label: "Retry failed", onClick: () => retryFailed(failedRows) };
    if (m.tone === "success") toast.success(m.title);
    else if (m.tone === "warning") toast.warning(m.title, { description: m.description, action: retry, duration: 15_000 });
    else toast.error(m.title, { description: m.description, action: retry, duration: 15_000 });
  }

  /* R-2404: bulk Assign owner — one follow-up per ticked renewal through the same API as the
     Follow-up dialog (it and the DB re-check who may give work to someone else). */
  async function assignOwner(rows: QueueItem[], person: UserName) {
    if (assigning) return;
    const { requests, skipped } = bulkAssignRequests(rows, { id: person.id, name: person.label }, todayIst);
    setAssigning(true);
    const failed: { row: QueueItem; name: string; error: string }[] = skipped.map((s) => ({ row: s.row, name: s.row.sub.customer_name, error: s.reason }));
    let done = 0;
    for (const r of requests) {
      try { await postFollowup(r.body); done += 1; }
      catch (e) { failed.push({ row: r.row, name: r.row.sub.customer_name, error: e instanceof FollowupSaveError ? e.message : "not saved — check your internet" }); }
    }
    setAssigning(false);
    setAssignOpen(false);
    void qc.invalidateQueries({ queryKey: ["collections"] });
    void qc.invalidateQueries({ queryKey: ["payment-followups"] });
    if (failed.length === 0) setSelected(new Set());
    const m = bulkAssignReport(done, failed, person.label);
    const retryRows = failed.filter((f) => f.row.sub.customer_id).map((f) => f.row);
    const retry = retryRows.length > 0 ? { label: "Retry failed", onClick: () => void assignOwner(retryRows, person) } : undefined;
    if (m.tone === "success") toast.success(m.title);
    else if (m.tone === "warning") toast.warning(m.title, { description: m.description, action: retry, duration: 15_000 });
    else toast.error(m.title, { description: m.description, action: retry, duration: 15_000 });
  }

  const tabEmpty = filtered || search.trim()
    ? "No renewals in this window match the search or filters."
    : "No subscriptions in this window.";

  return (
    <div className="mx-auto max-w-[1800px] px-4 md:px-8 pb-20 pt-7">
      {/* ── Page header ── */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="mb-0.5 text-xs font-medium uppercase tracking-widest text-ink-3">
            Revenue
          </p>
          <h1 className="font-serif text-3xl text-ink">Renewals</h1>
          <p className="mt-1 text-sm text-ink-3">
            {activeSubs} active subscription{activeSubs !== 1 ? "s" : ""}
            {/* R-2266: the at-risk ARR figure lived here AND in the strip — it is only on the
                strip line now, and the At risk chip below filters the list. */}
          </p>
        </div>

        {/* Header actions — hidden on mobile (replaced by FAB) to avoid overflow */}
        <div className="hidden md:flex shrink-0 items-center gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={handleExport}
          >
            <Icon name="download" size={14} />
            Export
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={bulkSending}
            onClick={handleBulkReminder}
          >
            <Icon name="mail" size={14} />
            {bulkSending ? "Sending…" : "Bulk reminder"}
          </Button>
        </div>
      </div>

      {/* R-2405: the tiles — count + renewal ₹ in the table's own money; a press lists those rows. */}
      <RenewalTileRow tiles={tileFigures} month={month} active={tile} onPick={pickTile} />

      {/* R-2266: ONE strip, closed by default (remembered per user). R-2405: the tiles above carry
          the money and counts (one fact, one place) — the strip keeps the forecast and the
          Renewal AI top pick, a link on its line. */}
      <CollapsibleKpiStrip
        stripId="renewals"
        userId={me?.userId}
        title="Forecast"
        className="mb-4"
        summary={<StripFact label="Next 6 months" value={rupee(forecast.totalAmount, { compact: true })} />}
        extras={highRiskSubs.length > 0 ? (
          <StripLink
            tone="rose"
            title="Renewal AI · next best action — the top renewal at risk"
            onClick={() => {
              const cid = highRiskSubs[0]?.sub.customer_id;
              router.push((cid ? `/customers/${cid}` : "/customers") as never);
            }}
          >
            Top risk: {topHighRisk}
          </StripLink>
        ) : undefined}
      >
        <ForecastPanel
          forecast={forecast}
          atRiskCount={highRiskSubs.length}
          atRiskArr={groups.atRiskArr}
          topName={topHighRisk}
          topCustomerId={highRiskSubs[0]?.sub.customer_id ?? null}
          topReasons={topReasons}
        />
      </CollapsibleKpiStrip>

      {/* R-1621: grace ended unpaid → the owner stops the service or gives more days. */}
      <GraceOverCard />

      {/* ── The renewal queue — tabs by time window (R-2403) ── */}
      <Card flush>
        <div className="px-3 pt-3 sm:px-4">
          {tile ? (
            <TileViewBar tile={tile} count={tileShown.length} onClear={() => pickTile(tile)} />
          ) : (
            <TabBar
              value={bucketTab}
              onChange={openTab}
              items={QUEUE_TABS.map((t) => ({
                id: t,
                label: QUEUE_TAB_LABEL[t],
                count: shown[t].length || undefined,
                dot: t === "overdue" || t === "due7" ? "rose" : t === "d30" ? "amber" : undefined,
              })) satisfies TabBarItem[]}
            />
          )}
          <div className="mt-2 mb-2 flex flex-wrap items-center gap-2">
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search customer or domain"
              aria-label="Search renewals by customer or domain"
              className="w-full sm:w-56"
            />
            <select value={sort} onChange={(e) => setSort(e.target.value as QueueSort)} aria-label="Sort renewals" className={SELECT_CLS}>
              <option value="date">Sort: renewal date</option>
              <option value="amount">Sort: amount (high first)</option>
            </select>
            <select value={filters.product} onChange={(e) => setFilters((f) => ({ ...f, product: e.target.value }))} aria-label="Filter by product" className={cn(SELECT_CLS, "max-w-[11rem]")}>
              <option value="">All products</option>
              {productOptions.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as RowStatusKey | "" }))} aria-label="Filter by status" className={SELECT_CLS}>
              <option value="">All statuses</option>
              {statusOptions.map((k) => <option key={k} value={k}>{STATUS_FILTER_LABEL[k]}</option>)}
            </select>
            <select value={filters.vendor} onChange={(e) => setFilters((f) => ({ ...f, vendor: e.target.value }))} aria-label="Filter by vendor" className={SELECT_CLS}>
              <option value="">All vendors</option>
              {vendorOptions.map((v) => <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>)}
            </select>
            <button
              type="button"
              aria-pressed={atRiskOn}
              onClick={() => setAtRisk(!atRiskOn)}
              title="Overdue and unpaid, marked high risk within 90 days, or won't renew"
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                atRiskOn ? "border-rose-300 bg-rose-50 text-rose-700" : "border-hairline bg-paper text-ink-2 hover:border-rose-300",
              )}
            >
              <Icon name="alert" size={12} />
              At risk{highRiskSubs.length > 0 ? ` (${highRiskSubs.length})` : ""}
            </button>
            {/* R-2404: the follow-up person's own lists. */}
            {([
              { key: "mine", label: "Mine", count: mineCount, icon: "user", title: "Renewals whose owner is you" },
              { key: "followUpDue", label: "Follow-up due", count: dueCount, icon: "clock", title: "Next follow-up is today or already past" },
              { key: "promiseBroken", label: "Promise broken", count: brokenCount, icon: "alert", title: "The customer promised to pay by a date that has passed, and the renewal is not paid" },
            ] as const).map((c) => (
              <button
                key={c.key}
                type="button"
                aria-pressed={fuFilters[c.key]}
                onClick={() => setFuFilters((f) => ({ ...f, [c.key]: !f[c.key] }))}
                title={c.title}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                  fuFilters[c.key] ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline bg-paper text-ink-2 hover:border-amber/60",
                )}
              >
                <Icon name={c.icon} size={12} />
                {c.label}{c.count > 0 ? ` (${c.count})` : ""}
              </button>
            ))}
            {filtered && (
              <button type="button" onClick={() => { setFilters(NO_FILTERS); setFuFilters(NO_FOLLOWUP_FILTERS); if (bucketRaw === "risk") setBucketTab(bucketTab); }} className="text-xs text-ink-3 underline underline-offset-2 hover:text-ink">
                Clear filters
              </button>
            )}
          </div>
          {/* R-2232: Renewals = end of commitment only — say where the flex months went. */}
          {groups.flexParts.length > 0 && (
            <p className="mb-2 text-xs text-ink-3">
              {groups.flexParts.length} flex {groups.flexParts.length === 1 ? "subscription is" : "subscriptions are"} not listed: each month is a billing part — its payment request is raised on its date (see the subscription&apos;s billing schedule).
            </p>
          )}
          {groups.renewedPaid.length > 0 && (
            <p className="mb-2 text-xs text-ink-3">
              {groups.renewedPaid.length} paid {groups.renewedPaid.length === 1 ? "renewal is" : "renewals are"} not listed as overdue: the renewal quote is paid, the renewal date moves on with it.
            </p>
          )}
        </div>
        <div className="border-t border-hairline">
          <RenewalQueue
            rows={tile ? tileShown : shown[bucketTab]}
            graceDays={graceDays}
            strong={tile ? tile === "overdue" || tile === "due30" : bucketTab === "overdue" || bucketTab === "due7"}
            selected={selected}
            onSelect={onSelect}
            emptyText={tabEmpty}
            onFollowup={setFollowupFor}
            names={names}
          />
        </div>
      </Card>

      {/* R-2404: Payment Follow-up's own dialog, about this renewal (its history = the renewal's activity log). */}
      {followupFor?.sub.customer_id && (
        <FollowupDialog
          open
          onOpenChange={(o) => { if (!o) setFollowupFor(null); }}
          customerId={followupFor.sub.customer_id}
          customerName={followupFor.sub.customer_name}
          ownerId={followupFor.customerOwnerId}
          items={[{ kind: "subscription", id: followupFor.sub.id, label: `${followupFor.sub.plan ?? "subscription"} · renews ${followupFor.sub.renewal_date ? formatDate(followupFor.sub.renewal_date) : "—"}`, quoteId: followupFor.sub.renewal_quote_id }]}
          stillOwes={followupFor.status.key !== "renewed"}
          amountDue={followupFor.amount.value}
          renewal={{ subscriptionId: followupFor.sub.id }}
        />
      )}
      <AssignOwnerDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        count={selectedRows.length}
        team={team}
        busy={assigning}
        onAssign={(p) => void assignOwner(selectedRows, p)}
      />

      {/* R-2403: tick rows → the existing send-now route, after the existing kind of confirm. */}
      <BulkActionBar count={selectedRows.length} noun="renewal" onClear={() => setSelected(new Set())}>
        <BulkBarButton icon="mail" onClick={() => void handleSelectedQuote()} disabled={bulkSending}>
          Send renewal quote
        </BulkBarButton>
        <BulkBarButton icon="mail" onClick={() => void handleSelectedReminder()} disabled={bulkSending}>
          Send reminder
        </BulkBarButton>
        <BulkBarButton
          icon="user"
          disabled={assigning}
          onClick={() => {
            if (canReassign) setAssignOpen(true);
            else toast.info("You cannot assign renewals", { description: ASSIGN_NEEDS_ROLE });
          }}
        >
          Assign owner
        </BulkBarButton>
      </BulkActionBar>

      {/* Mobile FAB — Bulk reminder action (header buttons hidden on phone) */}
      <FAB
        icon="mail"
        label={bulkSending ? "Sending…" : "Bulk reminder"}
        onClick={handleBulkReminder}
      />
    </div>
  );
}
