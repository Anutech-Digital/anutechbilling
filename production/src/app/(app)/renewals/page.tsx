/**
 * Renewals — ONE work queue (R-2403, 3 Nov 2026; was the prototype C8 bucket cards).
 *
 * Layout:
 *   - Page header (eyebrow/title/subtitle + Export / Remind — R-2753: the ticked rows, else the open tab)
 *   - Tiles (R-2405, tiles.ts): Overdue · Due in 30 / 31–60 / 61–90 days · Won't renew ·
 *     Renewed this month — count + renewal ₹; a press shows exactly those rows in the queue
 *   - Forecast strip (closed by default, R-2266): 6-month forecast, Renewal AI top pick
 *   - Grace over list (R-1621)
 *   - The queue: tabs Overdue · ≤7 days · 8–30 · 31–60 · 61–90 (every row in exactly one —
 *     queue.ts queueTabs); search, sort (date / amount), filters (product, status, vendor, At
 *     risk chip); a table from 1280px (cards on smaller screens) with customer + contact,
 *     product + seats, renewal date, the renewal AMOUNT for the term, ONE status chip
 *     (queue.ts renewalRowStatus) and the shared RenewalActions (R-2401); tick rows → bulk
 *     Send renewal quote / Assign owner (the reminder is the header's one Remind button, R-2753).
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
import { RENEWAL_BUCKETS, drillHref } from "@/lib/navigation/drilldown";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSubscriptions, useOpenRenewalQuotes } from "@/lib/queries/subscriptions";
import { useProjectReceivablesByCustomer } from "@/lib/queries/projects";
import { toChaseSummary, subscriptionDuesLine, subscriptionDue } from "@/lib/accounting/receivables-due";
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
import { BulkActionBar, BulkBarButton } from "@/components/ui/bulk-action-bar";
import { rupee, formatDate } from "@/lib/utils";
import { daysUntilRenewal, isFlexSubscription, onRenewalsPage } from "@/lib/renewals/buckets";
import { cn } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import type { Subscription } from "@/lib/supabase/database.types";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canOpenQuotes } from "@/lib/quotes/access";
import { useQueryClient } from "@tanstack/react-query";
import { useConfirm } from "@/components/providers/confirm-provider";
import { Input } from "@/components/ui/input";
import {
  reminderPlan,
  reminderScope,
  reminderButtonLabel,
  type BulkReminderResult,
  matchesRenewalSearch,
  readJsonSafe,
  sendBulkReminders,
  bulkReminderReport,
  RENEWAL_QUOTE_VERBS,
  type RenewalRowLike,
} from "./reminders";
import { renewalRisk } from "./risk";
import { priorTermDue, priorTermDueText } from "./prior-due";
import { openRenewalQuoteMap, openRenewalQuoteStatus, withRenewalQuote } from "./open-renewal-quotes";
import { renewalRowAction, type RowAction } from "./row-action";
import { GraceOverCard } from "./grace-over-card";
import { NoRenewalDateCard } from "./no-date-card";
import { classifyRenewals, chasedRenewal } from "./classify";
import {
  QUEUE_TABS, QUEUE_TAB_LABEL, QUEUE_TABLE_COLS, LEGACY_BUCKETS, STAGE_FILTER_LABEL, STAGE_FILTER_ORDER, NO_FILTERS, TILE_TABS,
  queueTabs, noRenewalDate, resolveBucket, renewalRowStatus, renewalAmount, isPaidRenewalQuote,
  sortQueue, filterQueue, filterOptions, bulkStageTargets, bulkQuoteConfirm,
  type QueueTab, type LegacyBucket, type QueueFilters, type QueueSort, type RowStatus, type RenewalAmount,
} from "./queue";
import { useRenewalContacts, useRenewalQuoteInfo, useRenewalFollowups, useRenewalPaymentsForMonth, type RowContact } from "./queue-data";
import { monthOf, renewalTiles, tileMatches, paidRenewalsInMonth, forecastWithThisMonth, TILE_LABEL, type TileKey, type TileRow } from "./tiles";
import { RenewalReminderDialog, type ReminderDialogState } from "./reminder-dialog";
import { RenewalTileRow, TileViewBar } from "./tiles-card";
import { ForecastPanel } from "./forecast-panel";
import { renewalFrequency, renewalCommitment, type Commitment } from "./frequency";
import { useRenewalLastPaid } from "./last-paid-data";
import { LastPaidLine } from "./last-paid-cell";
import type { LastPaid } from "./last-paid";
import { useRenewalLastDocs } from "./last-docs-data";
import { LastDocsLines, SentDueLines } from "./last-docs-cell";
import { paidInvoiceOf, type LastDocs } from "./last-docs";
import { canOpenInvoices } from "@/lib/invoices/access";
import {
  renewalFollowup, renewalDecision, filterByFollowup, bulkAssignRequests, bulkAssignReport,
  NO_FOLLOWUP_FILTERS, ASSIGN_NEEDS_ROLE,
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
import { RenewalActions } from "@/components/features/renewals/renewal-actions";
import { CollapsibleKpiStrip, StripFact, StripLink } from "@/components/shared/collapsible-kpi-strip";
import { renewalStage, type RenewalStage, type StageFlag, type FlagKey, type StageKey } from "@/lib/renewals/stage";
import { vendorHoldState } from "@/lib/renewals/vendor-hold";
import { stageInputFor, payHref as stagePayHref } from "./stage-input";
import { CustomerCell, ProductCell, DueCell, LastInvoiceCell, nextTermWords, nextTermShort, compactStage, quoteExpiryShort } from "./row-cells";

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

/** R-2758 (R-2738): the row's ONE chip = its stage; facts (at risk, vendor hold, previous term unpaid,
    promise broken, follow-up due) are small icons after it — never a second chip. null = documents
    still loading: a placeholder, so the chip never flips from a guess (userAudit14Nov). */
const FLAG_ICON: Record<FlagKey, React.ComponentProps<typeof Icon>["name"]> = {
  atRisk: "alert", vendorHold: "lock", priorTermUnpaid: "rupee", promiseBroken: "x_circle", followUpDue: "phone",
};

function StageChip({ stage, size, compact = false, canQuotes = false }: { stage: RenewalStage | null; size?: "sm"; compact?: boolean; canQuotes?: boolean }) {
  if (!stage) return <Skeleton className="h-5 w-24" aria-label="Loading status" data-testid="stage-chip-loading" />;
  /* R-2759: in the table the chip drops the period (Product & period says it); its day count / amount is
     line 2 — two lines, nothing only in a tooltip. */
  const c = compact ? compactStage(stage) : { chip: stage.label, line2: stage.note };
  /* R-2760 (R-2728 owner ask "clickable link"): a quote stage's chip opens THAT quote. */
  const quoteHref = compact && canQuotes && stage.quoteId && stage.quoteStatus !== "unknown"
    && (stage.key === "sent" || stage.key === "draft" || stage.key === "quote-closed") ? `/quotes/${encodeURIComponent(stage.quoteId)}` : null;
  const badge = <Badge kind={stage.tone} size={size} dot className={compact ? "max-w-full whitespace-normal text-left" : undefined}>{c.chip}</Badge>;
  return (
    <div className="min-w-0" data-testid="stage-chip" data-stage={stage.key} title={compact ? [stage.label, stage.note, stage.quoteId].filter(Boolean).join(" · ") : undefined}>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {quoteHref
          ? <Link href={quoteHref as never} className="max-w-full rounded-full hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber" aria-label={`${stage.label} — open ${stage.quoteId}`} data-testid="stage-chip-quote">{badge}</Link>
          : badge}
        {stage.flags.map((f) => <StageFlagIcon key={f.key} flag={f} />)}
      </div>
      {c.line2 && <p className="mt-1 break-words text-2xs text-ink-3 tabular-nums" data-testid="stage-line2">{c.line2}</p>}
    </div>
  );
}

function StageFlagIcon({ flag }: { flag: StageFlag }) {
  return (
    <span role="img" aria-label={flag.reason} title={flag.reason} data-flag={flag.key}
      className={cn("inline-flex h-5 w-5 items-center justify-center rounded-full", flag.key === "followUpDue" ? "bg-amber-50 text-amber-700" : "bg-rose-50 text-rose-600")}>
      <Icon name={FLAG_ICON[flag.key]} size={11} />
    </span>
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
      {/* R-2751: a sent renewal quote's total incl. GST is a note, never the figure. */}
      {amount.quoteNote && <p className="text-2xs text-ink-3">{amount.quoteNote}</p>}
      {frequency && <p className="text-2xs text-ink-2">{frequency}</p>}
    </div>
  );
}

/**
 * R-2404: where the customer's decision stands, who works the renewal and when they follow up
 * next, the promise to pay. Under the ONE status chip; "Paid" / "Won't renew" are that chip already.
 */
/** R-2760: the Due column shows a renewal quote's validity only while it is with the customer (sent / viewed) —
    a part proforma has none, an accepted quote no longer expires for the customer. */
function showsExpiry(item: { stage: RenewalStage | null; docs?: LastDocs }): boolean {
  const sent = item.docs?.sent;
  return !!sent && sent.kind === "renewal" && (sent.status === "sent" || sent.status === "viewed")
    && item.stage?.key === "sent" && item.stage.quoteId === sent.quoteId;
}

/** R-2759: the table row's owner / next follow-up / promise, as the customer name's tooltip (the drawer, R-2740, will show them). */
function followupWords(followup: RenewalFollowup, names: Map<string, UserName> | undefined): string {
  const owner = followup.ownerId ? names?.get(followup.ownerId)?.label ?? "a colleague" : null;
  return [
    owner ? `Owner: ${owner}` : "No owner yet",
    followup.nextFollowUpOn ? `Next follow-up ${formatDate(followup.nextFollowUpOn)}` : null,
    followup.promisedOn && followup.promiseStatus !== "kept"
      ? `${followup.promiseBroken ? "Promise broken" : "Promised"} ${formatDate(followup.promisedOn)}${followup.promisedAmount ? ` · ${rupee(followup.promisedAmount)}` : ""}`
      : null,
  ].filter(Boolean).join(" · ");
}

function FollowupLine({ followup, names }: { followup: RenewalFollowup; names: Map<string, UserName> | undefined }) {
  const owner = followup.ownerId ? names?.get(followup.ownerId)?.label ?? "a colleague" : null;
  /* R-2758 (R-2738): the stage chip is the ONE status — no second "decision" chip; a follow-up that is
     due and a broken promise are the chip's flag icons. */
  return (
    <div className="mt-1.5 space-y-0.5 text-2xs">
      <p className={cn("truncate", owner ? "text-ink-2" : "text-ink-3")} title={owner ? `Owner: ${owner}` : "No owner yet"}>
        <Icon name="user" size={10} className="mr-0.5 inline shrink-0" />{owner ?? "No owner"}
      </p>
      {followup.nextFollowUpOn && !followup.followUpDue && (
        <p className="tabular-nums text-ink-3">
          Next: {formatDate(followup.nextFollowUpOn)}
        </p>
      )}
      {followup.promisedOn && followup.promiseStatus !== "kept" && !followup.promiseBroken && (
        <p className="tabular-nums text-ink-2">
          Promised · {formatDate(followup.promisedOn)}
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
  /** R-2422: worked out once per row (frequency.ts) — the amount cell's words and the Commitment filter. */
  frequency: string | null;
  commitment: Commitment;
  /** R-2728: last quote sent / last invoice / the renewal quote with the customer (last-docs.ts). */
  docs: LastDocs | undefined;
  /** R-2758 (R-2738): the row's ONE stage (chip + button); null while its documents load. */
  stage: RenewalStage | null;
  /** R-2758: where Record payment goes (the open quote's dialog, else the invoice's). */
  payHref: string | null;
}

interface RenewalQueueProps {
  rows: QueueItem[];
  strong: boolean;
  selected: ReadonlySet<string>;
  onSelect: (ids: string[], on: boolean) => void;
  emptyText: string;
  /** R-2404: open the renewal's Follow-up dialog. */
  onFollowup: (item: QueueItem) => void;
  names: Map<string, UserName> | undefined;
  /** R-2422: Last paid per subscription (one read for the whole list — last-paid-data.ts). */
  lastPaid: { data: Map<string, LastPaid> | undefined; loading: boolean; failed: boolean };
  /** R-2728: the last-docs read's state (the rows carry their own `docs`). */
  docsState: { loading: boolean; failed: boolean };
}

function RenewalQueue({ rows, strong, selected, onSelect, emptyText, onFollowup, names, lastPaid, docsState }: RenewalQueueProps) {
  /* R-237: billing + support see Renewals but cannot open /quotes (middleware sends them
     home) — no "Open quote" link for them. */
  const { data: me } = useCurrentUser();
  const canQuotes = canOpenQuotes(me?.role);
  /* R-2232: draft vs sent for the row's "Renewal sent Q-x" line (same cached query as the page). */
  const { data: openRenewals } = useOpenRenewalQuotes();
  const quoteStatus = React.useMemo(() => openRenewalQuoteStatus(openRenewals ?? []), [openRenewals]);
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
  /* R-2752: paid facts agree — an invoice the row shows as Paid is never next to "never paid" (wait
     for the docs too before saying "never paid") */
  const lastPaidFor = (item: QueueItem, className?: string) => {
    const paid = lastPaid.data?.get(item.sub.id);   // no receipt → it waits for (or says it lost) the docs, never a false "never paid"
    return <LastPaidLine paid={paid} paidInvoice={paidInvoiceOf(item.docs, todayIst)} loading={lastPaid.loading || (!paid && docsState.loading)} failed={lastPaid.failed || (!paid && docsState.failed)} canInvoices={canInvoices} canQuotes={canQuotes} className={className} />;
  };
  /* R-2728: the last quote sent + last invoice, clickable. A draft renewal quote keeps R-2232's
     "Renewal quote Q-x not sent yet" line; otherwise these lines replace "Renewal sent Q-x · due …". */
  const todayIst = istToday();
  const docsFor = (item: QueueItem, action: RowAction, className: string) => {
    /* R-2232's line stays when it says something the docs lines do not: a draft ("not sent yet"),
       the docs still loading / unread, or a linked renewal quote that is not the newest quote sent. */
    const keepActionLine = action.kind === "send" || docsState.loading || docsState.failed
      || (!!action.quoteId && item.docs?.quote?.id !== action.quoteId);
    return (
      <>
        {keepActionLine && <RowActionLine action={action} canQuotes={canQuotes} className={className} />}
        <LastDocsLines docs={item.docs} loading={docsState.loading} failed={docsState.failed} canQuotes={canQuotes} canInvoices={canInvoices} todayIst={todayIst} priorDue={priorTermDue(item.sub)} className={className} />
      </>
    );
  };
  const sentDue = (item: QueueItem, className?: string) => (
    item.status.key === "quote-sent" && item.docs?.sent
      ? <SentDueLines sent={item.docs.sent} daysUntil={item.daysUntil} todayIst={todayIst} className={className} />
      : null
  );

  return (
    <>
      {/* Cards — viewports < 1260px (phones and small laptops), two per row from md. */}
      <ul className="min-[1260px]:hidden p-3 space-y-2 md:grid md:grid-cols-2 md:gap-2 md:space-y-0">
        {rows.map((item) => {
          const { sub, daysUntil: days, amount, frequency, contact, followup, stage } = item;
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
                  {lastPaidFor(item, "mt-0.5")}
                </div>
                <AmountCell amount={amount} frequency={frequency} className="text-right shrink-0" />
              </div>

              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <StageChip stage={stage} size="sm" />
                  <FollowupLine followup={followup} names={names} />
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs text-ink-2">{sub.renewal_date ? formatDate(sub.renewal_date) : "—"}</p>
                  {sentDue(item)}
                </div>
              </div>

              {/* R-2758: vendor hold, previous term unpaid and at risk are the stage chip's flag icons;
                  Renew anyway (grace over) is in the row's ⋯. */}
              {/* R-2232: "Renewal quote Q-x not sent yet" — never a second Generate. R-2728: last quote / invoice. */}
              {docsFor(item, action, "mb-2 text-xs")}

              <div className="pt-2 border-t border-hairline/60">
                <RenewalActions sub={sub} daysUntil={days} layout="card" strong={strong} onFollowup={followupFor(sub)} messaging stage={stage} payHref={item.payHref} />
              </div>
            </li>
          );
        })}
      </ul>

      {/* Desktop table — R-2759: from a 1260px window (QUEUE_TABLE_MIN_VIEWPORT_PX; a 1280 laptop's inner width
          is 1264–1276), eight columns on the queue.ts budget, every cell at most two lines (row-cells.tsx). */}
      <div className="hidden min-[1260px]:block" data-testid="renewals-table">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            {QUEUE_TABLE_COLS.map((c) => (
              <col key={c.key} style={c.width != null ? { width: c.width } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-hairline bg-muted/30">
              {QUEUE_TABLE_COLS.map((c) => c.key === "select" ? (
                <th key={c.key} className="px-2 py-2.5">
                  <input
                    type="checkbox"
                    aria-label="Select all renewals on screen"
                    className="cursor-pointer accent-amber"
                    checked={allOn}
                    ref={(el) => { if (el) el.indeterminate = someOn && !allOn; }}
                    onChange={(e) => onSelect(rows.map((r) => r.sub.id), e.target.checked)}
                  />
                </th>
              ) : (
                <th key={c.key} className={cn("px-2 py-2.5 text-xs font-medium text-ink-3", c.align === "right" ? "text-right" : "text-left")}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => {
              const { sub, daysUntil: days, amount, frequency, contact, stage } = item;
              return (
                <tr key={sub.id} className="border-b border-hairline last:border-0 align-top hover:bg-muted/20" data-testid="renewal-row">
                  <td className="px-2 py-2.5">
                    <input
                      type="checkbox"
                      aria-label={`Select ${sub.customer_name} — ${sub.plan}`}
                      className="cursor-pointer accent-amber"
                      checked={selected.has(sub.id)}
                      onChange={(e) => onSelect([sub.id], e.target.checked)}
                    />
                  </td>
                  <td className="min-w-0 px-2 py-2.5"><CustomerCell name={sub.customer_name} customerId={sub.customer_id} contact={contact} more={followupWords(item.followup, names)} /></td>
                  <td className="min-w-0 px-2 py-2.5">
                    <ProductCell plan={sub.plan} seats={sub.seats} vendor={sub.vendor} term={nextTermWords(sub)} termShort={nextTermShort(sub)} frequency={frequency} />
                  </td>
                  <td className="px-2 py-2.5"><DueCell date={sub.renewal_date} days={days} note={showsExpiry(item) ? quoteExpiryShort(item.docs?.sent?.expiresDate, todayIst) : null} /></td>
                  <td className="px-2 py-2.5 text-right">
                    <p className="break-words font-medium tabular-nums text-ink">{amount.text}</p>
                    <p className="mt-0.5 truncate text-2xs text-ink-3" title={amount.quoteNote ? `${amount.gst} · ${amount.quoteNote}` : amount.gst}>{amount.quoteNote ? `${amount.gst} · quote sent` : amount.gst}</p>
                  </td>
                  <td className="min-w-0 px-2 py-2.5"><StageChip stage={stage} size="sm" compact canQuotes={canQuotes} /></td>
                  <td className="min-w-0 px-2 py-2.5">
                    <LastInvoiceCell docs={item.docs} loading={docsState.loading} failed={docsState.failed} canInvoices={canInvoices} canQuotes={canQuotes} todayIst={todayIst} priorDue={priorTermDue(sub)} />
                  </td>
                  <td className="min-w-0 px-2 py-2.5">
                    <RenewalActions sub={sub} daysUntil={days} layout="table" strong={strong} onFollowup={followupFor(sub)} messaging stage={stage} payHref={item.payHref} />
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
  const { data: openRenewals, isLoading: openRenewalsLoading } = useOpenRenewalQuotes();
  const openRenewalMap = React.useMemo(() => openRenewalQuoteMap(openRenewals ?? []), [openRenewals]);
  const quoteStatusMap = React.useMemo(() => openRenewalQuoteStatus(openRenewals ?? []), [openRenewals]);
  const { data: me } = useCurrentUser();
  /* R-1473 (7 Nov 2026, Pawan's ✗ Galat): the rows' "Unpaid balance" badges add up to subscription
     dues only; the dashboard and Companies "To collect" also count project invoices. One line under
     the title says both figures, from the same rule (lib/accounting/receivables-due). */
  const projRecvQ = useProjectReceivablesByCustomer();
  /* R-2562: "unread" = failed with nothing to show — a failed background refetch keeps the last good
     figure, as on Companies (collectLineState) and the dashboard (loadView). */
  const projectsUnread = projRecvQ.isError && projRecvQ.data === undefined;
  const duesLine = React.useMemo(() => {
    if (!subs || projRecvQ.isPending) return null;
    // The page's own rows (onRenewalsPage) — what their "Unpaid balance" badges add up to.
    const renewalDues = subs.filter(onRenewalsPage).reduce((t, s) => t + subscriptionDue(s), 0);
    return subscriptionDuesLine(toChaseSummary(subs, projRecvQ.data ?? {}), renewalDues, projectsUnread);
  }, [subs, projRecvQ.data, projRecvQ.isPending, projectsUnread]);
  const qc = useQueryClient();
  const router = useRouter();
  /* R-118 / R-2403: ?bucket= holds the tab; the old values (urgent / upcoming / future / risk —
     the sidebar badge opens ?bucket=urgent) still open the right tab (queue.ts resolveBucket). */
  const [bucketRaw, setBucketTab] = useUrlChoice<string>("bucket", RENEWAL_BUCKETS, "urgent");
  const [bulkSending, setBulkSending] = React.useState(false);
  /* R-2753: the one reminder dialog (null = closed) — who is emailed / skipped, then the result. */
  const [reminder, setReminder] = React.useState<ReminderDialogState<QueueItem> | null>(null);
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

  /* Rows on the page: their contacts and renewal quotes (hooks run before any early return).
     R-2586: every dated row — the Later (91+ days) tab lists the annual book past 90 days. */
  const listed = React.useMemo(() => (subs ?? [])
    .filter(onRenewalsPage)
    .map((s) => withRenewalQuote(s, openRenewalMap)), [subs, openRenewalMap]);
  /* R-2753: isLoading — the Remind button waits for the contacts, so a customer with no email is never counted in "Email N". */
  const { data: contacts, isLoading: contactsLoading } = useRenewalContacts(listed.map((s) => s.customer_id ?? "").filter(Boolean));
  const { data: quoteInfo, isLoading: quoteInfoLoading } = useRenewalQuoteInfo(listed.map((s) => s.renewal_quote_id));
  /* R-2404: owner / next follow-up / promise per renewal — Payment Follow-up's rows for these subscriptions. */
  const { data: fuData } = useRenewalFollowups(listed.map((s) => s.id), listed.map((s) => s.customer_id ?? ""));
  const { data: names } = useUserNames();
  /* R-2422: Last paid for every listed renewal — one batched, paged read (last-paid-data.ts). */
  const lastPaidQ = useRenewalLastPaid(listed);
  const lastPaid = { data: lastPaidQ.data, loading: lastPaidQ.isLoading, failed: lastPaidQ.isError };
  /* R-2728: last quote sent / last invoice / "Renewal quote sent" for every listed renewal — one batched read. */
  const lastDocsQ = useRenewalLastDocs(listed);
  const docsState = { loading: lastDocsQ.isLoading, failed: lastDocsQ.isError && !lastDocsQ.data };
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
     ab list jodne se nahi, curve se dikhta hai. */
  /* R-2225: a Won't renew subscription brings no renewal money.
     R-2431: each renewal at its term amount before GST (termAmountOf — the tiles' amount for a row
     without a renewal quote), flex parts included, one per month. */
  const forecastByDate = renewalForecast(
    enriched.map((r) => r.sub).filter(chasedRenewal),
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()),
  );

  /* R-2225: the renewals pipeline export leaves out Won't renew subscriptions. */
  /* R-2422: a flex (monthly-commitment) subscription is a renewal too (owner, 3 Nov). */
  const upcoming90   = enriched.filter((r) => r.daysUntil >= 0 && r.daysUntil <= 90 && chasedRenewal(r.sub));
  const highRiskSubs = groups.atRisk;
  const atRiskIds    = new Set(highRiskSubs.map((r) => r.sub.id));

  /* R-2403: each listed row gets its ONE status, its renewal amount and its contact. */
  const todayIst = istToday(today);
  const toItem = (r: { sub: Subscription; daysUntil: number }): QueueItem => {
    const risk = renewalRisk(r.sub);
    const docs = lastDocsQ.data?.get(r.sub.id);
    /* R-2728: a renewal quote / part bill with the customer, unpaid → "Renewal quote sent" (stays listed). */
    const status = renewalRowStatus(r.sub, r.daysUntil, { tenantGraceDays: graceDays, today, renewalPaid: paid(r), quoteSent: docs?.sent ?? null });
    /* R-2404: the renewal's follow-up state + where the decision stands. */
    const customerOwnerId = r.sub.customer_id ? fuData?.ownerByCustomer.get(r.sub.customer_id) ?? null : null;
    const followup = renewalFollowup(r.sub.id, fuData?.rows ?? [], { customerOwnerId, today: todayIst, paid: status.key === "renewed" });
    const linkedQuote = quoteOf(r.sub);
    /* R-2758 (R-2738): ONE stage per row — only once the documents are read (no flip after load),
       only this renewal's quote / invoice (stage-input.ts). */
    const input = stageInputFor({
      /* code-review: also wait for the paid / linked-quote facts, and never guess when the documents read failed. */
      sub: r.sub, todayIst, docs, docsLoading: lastDocsQ.isLoading || docsState.failed || quoteInfoLoading || openRenewalsLoading,
      linkedStatus: r.sub.renewal_quote_id ? quoteStatusMap.get(r.sub.renewal_quote_id) ?? null : null,
      linkedQuote: linkedQuote ?? null,
      renewalPaid: paid(r),
      flags: {
        atRisk: atRiskIds.has(r.sub.id) ? { reasons: risk.reasons.filter((x) => x !== "Seat usage not checked") } : null,
        vendorHold: vendorHoldState(r.sub, today),
        priorTermUnpaid: priorTermDueText(r.sub),
        promiseBroken: followup.promiseBroken ? { promisedOn: followup.promisedOn } : null,
        followUpDue: followup.followUpDue ? { nextFollowUpOn: followup.nextFollowUpOn } : null,
      },
    });
    const stage = input ? renewalStage(input) : null;
    return {
      stage,
      payHref: stage ? stagePayHref(stage, docs, canOpenQuotes(me?.role)) : null,
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
      frequency: renewalFrequency(r.sub),
      commitment: renewalCommitment(r.sub),
      docs,
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

  /* R-2405: the tiles add up the rows' own renewal amounts; a pressed tile lists those rows.
     R-2586: the tiles stay on the 90-day window (TILE_TABS) — Later is a look-ahead list. */
  const tileRowOf = new Map<string, TileRow>(TILE_TABS.flatMap((t) => items[t].map((i) => [i.sub.id, {
    id: i.sub.id, tab: t, statusKey: i.status.key, amount: i.amount.value, renewalDate: i.sub.renewal_date,
  }] as const)));
  const tileFigures = renewalTiles([...tileRowOf.values()], monthQuotes ?? [], month);
  /* R-2751: this month's Forecast bar = the Renewed tile's "of ₹X due in <month>" (paid + still due, before GST). */
  const forecast = forecastWithThisMonth(forecastByDate, tileFigures.renewedMonth, month);
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
    statusKey: i.status.key, stageKey: i.stage?.key ?? null, atRisk: i.atRisk, customer: i.sub.customer_name, commitment: i.commitment, item: i,
  });
  /* R-2404: Mine · Follow-up due · Promise broken narrow the tabs the same way. */
  const narrow = (list: QueueItem[]): QueueItem[] =>
    sortQueue(filterQueue(filterByFollowup(list, fuFilters, me?.userId).filter((i) => matchesRenewalSearch(i.sub, search)).map(asQueueRow), activeFilters), sort)
      .map((r) => r.item);
  const shown = Object.fromEntries(QUEUE_TABS.map((t) => [t, narrow(items[t])])) as Record<QueueTab, QueueItem[]>;
  /* R-2405: a pressed tile lists its rows from every tab (search / filters / sort still apply). */
  /* R-2586: Later rows are not tile rows (no tileRowOf entry) — a pressed tile never lists them. */
  const tileShown = narrow(tile ? allItems.filter((i) => {
    const tr = tileRowOf.get(i.sub.id);
    return !!tr && tileMatches(tile, tr, month, paidSubs);
  }) : []);

  const productOptions = filterOptions(allItems.map((i) => i.sub.plan));
  const vendorOptions  = filterOptions(allItems.map((i) => i.sub.vendor));
  /* R-2760: the status filter is the row's ONE stage — the chip's words, with counts. */
  const stageCounts    = new Map<StageKey, number>();
  for (const i of allItems) if (i.stage) stageCounts.set(i.stage.key, (stageCounts.get(i.stage.key) ?? 0) + 1);
  const statusCount    = (k: StageKey) => stageCounts.get(k) ?? 0;
  const statusOptions  = STAGE_FILTER_ORDER.filter((k) => statusCount(k) > 0 || filters.status === k);
  const fuOn = fuFilters.mine || fuFilters.followUpDue || fuFilters.promiseBroken;
  const filtered = !!(filters.product || filters.status || filters.vendor || filters.commitment !== "all" || atRiskOn || fuOn);
  /* R-2404: chip counts — whole queue, so a person sees "Mine (12)" before pressing it. */
  const fuCount = (f: Partial<FollowupFilters>) => filterByFollowup(allItems, { ...NO_FOLLOWUP_FILTERS, ...f }, me?.userId).length;
  const mineCount = fuCount({ mine: true });
  const dueCount = fuCount({ followUpDue: true });
  const brokenCount = fuCount({ promiseBroken: true });

  /* R-2751: the header counts the rows on the tabs (each row is on exactly one tab), so it equals the tabs added up. */
  const queueCount    = allItems.length;
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
        const amount = renewalAmount(sub, quoteOf(sub));
        return [
          sub.customer_name,
          sub.plan,
          sub.vendor,
          sub.seats,
          sub.used,
          sub.mrr,
          amount.value,   // R-2431: the row's renewal amount (the tiles' money), not mrr × 12
          sub.renewal_date ? formatDate(sub.renewal_date) : "",
          daysUntil,
          sub.outstanding_amount,
          risk.label,
          /* R-2431: new columns at the END, so a template reading by position still lines up. */
          "Term amount, + GST",   // R-2751: one basis — a renewal quote never changes the amount
          isFlexSubscription(sub) ? "Monthly (flex)" : renewalCommitment(sub) === "monthly" ? "Monthly" : "Annual",
        ];
      });
    downloadCSV(
      "renewals-next-90-days.csv",
      ["Customer", "Plan", "Vendor", "Seats", "Used", "MRR (₹)", "Renewal amount (₹)", "Renewal date", "Days until", "Outstanding (₹)", "Risk", "Amount basis", "Commitment"],
      rows,
    );
    toast.success(`Exported ${rows.length} renewal${rows.length === 1 ? "" : "s"}`);
  };

  /* R-2753: ONE reminder button. It acts on the ticked rows, else on the rows of the open tab (or
     pressed tile) as they show — never on rows from another tab (14 Nov audit: on Overdue it
     offered two 8–30 customers). The dialog lists who is emailed and who is skipped with the
     reason; nobody is emailed before "Email N" (R-239), and the result stays in the dialog. */
  const visibleRows = tile ? tileShown : shown[bucketTab];
  /* only ticked rows still on screen — a tick hidden by a later search / filter is not reminded */
  const tickedShown = visibleRows.filter((i) => selected.has(i.sub.id));
  const scope = reminderScope(tickedShown.length, tile ? TILE_LABEL[tile] : QUEUE_TAB_LABEL[bucketTab], visibleRows.length);
  /* undefined = contacts not read yet (the send route still checks); null = no email on file. */
  const emailOf = (i: QueueItem): string | null | undefined =>
    !i.sub.customer_id ? null : contacts ? contacts.get(i.sub.customer_id)?.email ?? null : undefined;
  function openReminder() {
    if (bulkSending) return;
    const scopeRows = tickedShown.length > 0 ? tickedShown : visibleRows;
    /* R-1124 in grace → emailed; R-2225 Won't renew, R-2431 flex, R-808 split-billed, past grace,
       no email, reminded today → skipped and named (reminders.ts reminderPlan). */
    const plan = reminderPlan(scopeRows, { today, tenantGraceDays: graceDays, emailOf, isPaid: (i) => i.status.key === "renewed" });
    setReminder({ scope, ...plan });
  }


  /* R-2403: Send renewal quote on the ticked rows — each through the row's own send-now route,
     only rows whose button is Send renewal quote; the rest are named in the confirm. */
  async function handleSelectedQuote() {
    if (bulkSending) return;
    /* R-2760: the rows whose stage says "send the renewal" and that have an email (bulkStageTargets). */
    const { send, skipped } = bulkStageTargets(selectedRows, emailOf, docsState.failed);
    if (send.length === 0) {
      toast.info("Nothing to send for the selected renewals", {
        description: skipped.slice(0, 3).map((s) => `${s.row.sub.customer_name} — ${s.reason}`).join("; "),
      });
      return;
    }
    await sendQuotes(send, skipped);
  }

  async function sendQuotes(send: QueueItem[], skipped: ReturnType<typeof bulkStageTargets<QueueItem>>["skipped"]) {
    const ok = await confirm({ ...bulkQuoteConfirm(send, skipped), confirmLabel: `Send ${send.length}`, icon: "mail" });
    if (!ok) return;
    await runSend(send, RENEWAL_QUOTE_VERBS, (failed) => void sendQuotes(failed, []));
  }

  /* Each row through the existing send-now route, one after another; then the lists refresh and,
     when every row went, the ticks clear. */
  async function sendAll<T extends RenewalRowLike>(targets: T[]): Promise<BulkReminderResult<T>> {
    setBulkSending(true);
    try {
      const result = await sendBulkReminders(targets, async (subscriptionId) => {
        const res = await fetch("/api/renewals/send-now", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription_id: subscriptionId }),
        });
        return { ok: res.ok, json: await readJsonSafe(res) };
      });
      if (result.failed.length === 0) setSelected(new Set());
      return result;
    } finally {
      setBulkSending(false);
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
    }
  }

  async function runSend<T extends RenewalRowLike>(
    targets: T[],
    verbs: { done: string; failed: string } | undefined,
    retryFailed: (failed: T[]) => void,
  ) {
    const result = await sendAll(targets);
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
            {queueCount} subscription{queueCount !== 1 ? "s" : ""} to renew
            {duesLine && (
              <>
                {" · "}
                <Link href={drillHref("customersUnpaid") as Route} className="text-rose hover:underline" data-testid="renewals-dues-line">
                  {duesLine}
                </Link>
                {/* R-2562: the project read failed — the line says so; this retries just that read. */}
                {projectsUnread && (
                  <>
                    {" "}
                    <Button size="sm" variant="ghost" icon="refresh" className="align-middle" loading={projRecvQ.isFetching} onClick={() => void projRecvQ.refetch()}>
                      Try again
                    </Button>
                  </>
                )}
              </>
            )}
            {/* R-2266: the at-risk ARR figure lived here AND in the strip — it is only on the
                strip line now, and the At risk chip below filters the list. */}
          </p>
        </div>

        {/* Header actions. R-2753: no floating email button on a phone (it was the biggest control
            over the Forecast) — the one Remind button stays here, small, on every size; Export is
            desktop only. */}
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="default"
            size="sm"
            className="hidden md:inline-flex"
            onClick={handleExport}
          >
            <Icon name="download" size={14} />
            Export
          </Button>
          {/* R-2753: the ONE reminder button — the ticked rows, else the open tab's rows (label says which). */}
          <Button
            variant="primary"
            size="sm"
            disabled={bulkSending || contactsLoading || scope.count === 0}
            title={contactsLoading ? "Reading each customer's email…" : undefined}
            onClick={openReminder}
            data-testid="renewals-remind"
          >
            <Icon name="mail" size={14} />
            {bulkSending ? "Sending…" : reminderButtonLabel(scope)}
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

      {/* R-2586: subscriptions with no renewal date are on no tab — named here, not dropped. */}
      <NoRenewalDateCard subs={noRenewalDate(all)} />

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
            <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as StageKey | "" }))} aria-label="Filter by status" className={SELECT_CLS}>
              <option value="">All statuses</option>
              {/* R-2728: each status with its count across the queue (e.g. "Renewal quote sent (3)"). */}
              {statusOptions.map((k) => <option key={k} value={k}>{STAGE_FILTER_LABEL[k]} ({statusCount(k)})</option>)}
            </select>
            <select value={filters.vendor} onChange={(e) => setFilters((f) => ({ ...f, vendor: e.target.value }))} aria-label="Filter by vendor" className={SELECT_CLS}>
              <option value="">All vendors</option>
              {vendorOptions.map((v) => <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>)}
            </select>
            {/* R-2422: Annual vs Monthly (flex) commitment — both are renewals. */}
            <select value={filters.commitment} onChange={(e) => setFilters((f) => ({ ...f, commitment: e.target.value as QueueFilters["commitment"] }))} aria-label="Filter by commitment" className={SELECT_CLS}>
              <option value="all">All commitments</option>
              <option value="annual">Annual</option>
              <option value="monthly">Monthly (flex)</option>
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
          {groups.renewedPaid.length > 0 && (
            <p className="mb-2 text-xs text-ink-3">
              {groups.renewedPaid.length} paid {groups.renewedPaid.length === 1 ? "renewal is" : "renewals are"} not listed as overdue: the renewal quote is paid, the renewal date moves on with it.
            </p>
          )}
        </div>
        <div className="border-t border-hairline">
          <RenewalQueue
            rows={tile ? tileShown : shown[bucketTab]}
            strong={tile ? tile === "overdue" || tile === "due30" : bucketTab === "overdue" || bucketTab === "due7"}
            selected={selected}
            onSelect={onSelect}
            emptyText={tabEmpty}
            onFollowup={setFollowupFor}
            names={names}
            lastPaid={lastPaid}
            docsState={docsState}
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

      {/* R-2403: tick rows → the existing send-now route, after the existing kind of confirm.
          R-2753: the reminder for ticked rows is the header's one button ("Remind N selected"). */}
      <BulkActionBar count={selectedRows.length} noun="renewal" onClear={() => setSelected(new Set())}>
        <BulkBarButton icon="mail" onClick={() => void handleSelectedQuote()} disabled={bulkSending}>
          Send renewal
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

      {/* The dialog's send = the existing send-now route per row (R-1642 reasons per failure). */}
      <RenewalReminderDialog state={reminder} onClose={() => setReminder(null)} onSend={(rows) => sendAll(rows)} emailOf={emailOf} />
    </div>
  );
}
