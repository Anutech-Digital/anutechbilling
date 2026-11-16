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
import { isFlexSubscription, onRenewalsPage } from "@/lib/renewals/buckets";
import { cn } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import type { Subscription } from "@/lib/supabase/database.types";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canOpenQuotes } from "@/lib/quotes/access";
import { canRecordMoney } from "@/lib/auth/roles";
import { useQueryClient } from "@tanstack/react-query";
import { useConfirm } from "@/components/providers/confirm-provider";
import { Input } from "@/components/ui/input";
import {
  reminderPlan,
  reminderScope,
  type BulkReminderResult,
  matchesRenewalSearch,
  readJsonSafe,
  sendBulkReminders,
  bulkReminderReport,
  RENEWAL_QUOTE_VERBS,
  type RenewalRowLike,
} from "./reminders";
import { renewalRisk, topRiskPick, topRiskReasons } from "./risk";
import { subscriptionOwedOf } from "./prior-due";
import { openRenewalQuoteMap, openRenewalQuoteStatus, withRenewalQuote } from "./open-renewal-quotes";
import { renewalRowAction, type RowAction } from "./row-action";
import { GraceOverCard } from "./grace-over-card";
import { NoRenewalDateCard } from "./no-date-card";
import { chasedRenewal } from "./classify";
import {
  QUEUE_TABS, QUEUE_TAB_LABEL, QUEUE_TABLE_COLS, matchesElsewhere, LEGACY_BUCKETS, STAGE_FILTER_LABEL, STAGE_FILTER_ORDER, NO_FILTERS, TILE_TABS,
  noRenewalDate, resolveBucket, renewalAmount, QUEUE_TABLE_MIN_VIEWPORT_PX, queueColCss,
  sortQueue, filterQueue, filterOptions, bulkStageTargets, bulkQuoteConfirm,
  type QueueTab, type LegacyBucket, type QueueFilters, type QueueSort, type RenewalAmount,
} from "./queue";
import { buildQueueItems, firstRows, QUEUE_PAGE_ROWS, type QueueItem } from "./queue-items";
import { planSeatsWords } from "./plan-seats";
import { useRenewalContacts, useRenewalQuoteInfo, useRenewalFollowups, useRenewalPaymentsForMonth, type RowContact } from "./queue-data";
import { monthOf, renewalTiles, tileMatches, renewedRowMatches, reconcileWindows, paidRenewalsInMonth, forecastWithThisMonth, TILE_LABEL, type TileKey, type TileRow } from "./tiles";
import { RenewalReminderDialog, RenewalRemindButton, type ReminderDialogState } from "./reminder-dialog";
import { RenewalTileRow, TileViewBar } from "./tiles-card";
import { ForecastPanel } from "./forecast-panel";
import { renewalCommitment } from "./frequency";
import { useRenewalLastPaid } from "./last-paid-data";
import { LastPaidLine } from "./last-paid-cell";
import type { LastPaid } from "./last-paid";
import { useRenewalLastDocs } from "./last-docs-data";
import { useRenewalHolds } from "./held-data";
import { LastDocsLines, SentDueLines } from "./last-docs-cell";
import { cardDocQuote, paidInvoiceOf, type LastDocs } from "./last-docs";
import { canOpenInvoices } from "@/lib/invoices/access";
import {
  filterByFollowup, bulkAssignRequests, bulkAssignReport,
  NO_FOLLOWUP_FILTERS, ASSIGN_NEEDS_ROLE,
  type RenewalFollowup, type FollowupFilters,
} from "./followup";
import { FollowupDialog } from "@/components/features/collections/followup-dialog";
import { postFollowup, FollowupSaveError } from "@/lib/queries/payment-followups";
import { mayReassignFollowup } from "@/lib/collections/followup-rules";
import { useUserNames, type UserName } from "@/lib/hooks/useUserNames";
import { istToday } from "@/lib/dates/ist";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { RenewalActions } from "@/components/features/renewals/renewal-actions";
import { CollapsibleKpiStrip, StripFact, StripLink } from "@/components/shared/collapsible-kpi-strip";
import { type RenewalStage, type StageKey } from "@/lib/renewals/stage";
import { StageFlagLine } from "./stage-flag";
import { RenewalQuoteLine } from "./row-quote";
import { useRowQuotePeek } from "./quote-peek-dialog";
import { dueCellFacts } from "./due-anchor";
import { AmountTableCell, CustomerCell, ProductCell, DueCell, HistoryButton, LastInvoiceCell, nextTermWords, nextTermShort, compactStage, quoteExpiryShort, subscriptionDomain } from "./row-cells";
import { RenewalDrawer, useRenewalDrawerSub } from "./renewal-drawer";
import type { DrawerView } from "./drawer";
import { BillTogetherGroups, togetherHint, togetherRowButton, useBillTogether } from "@/components/features/renewals/bill-together";
import type { TogetherRowAction } from "@/components/features/renewals/stage-actions";
import { BILL_TOGETHER, useBillTogetherProbe } from "@/components/features/renewals/bill-together-dialog";
import { canOfferBillTogether } from "@/lib/renewals/bill-together";
import { groupsShown, togetherIndex, togetherRowOf } from "./bill-together-rows";

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
    still loading: a placeholder, so the chip never flips from a guess (userAudit14Nov).
    R-2823: the vendor hold reads in words ("Hold at Google — unpaid") — StageFlagIcon, ./stage-flag. */
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
      </div>
      {/* R-2854: ONE line under the chip — its flag in words (never an icon-only pill; "+N more" for the rest), else the
          chip's note. In the table a flagged row's note stays in the tooltip (the Due column shows the same day count). */}
      {stage.flags.length > 0 && <div className="mt-1"><StageFlagLine flags={stage.flags} all={!compact} /></div>}
      {c.line2 && !(compact && stage.flags.length > 0) && <p className="mt-1 break-words text-2xs leading-4 text-ink-3 tabular-nums" data-testid="stage-line2">{c.line2}</p>}
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
  /* R-2767: the row never says there is no owner (drawer only) — the owner is named when there is one */
  return [
    owner ? `Owner: ${owner}` : null,
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
      {/* R-2767: "No owner" never on the row (drawer only) */}
      {owner && (
        <p className="truncate text-ink-2" title={`Owner: ${owner}`}>
          <Icon name="user" size={10} className="mr-0.5 inline shrink-0" />{owner}
        </p>
      )}
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

// ─── The queue (table ≥1260px, cards below) ───────────────────────────────────

/** R-2764: ONE layout in the DOM — the table from a 1260px window, else the cards. Before, both were
    mounted and one hidden by CSS: every row's buttons and menus twice (14 Nov freeze). The server and
    the first client frame assume the table (most reseller laptops); the queue only renders once its
    data is read on the client anyway. */
const TABLE_QUERY = `(min-width: ${QUEUE_TABLE_MIN_VIEWPORT_PX}px)`;
function useTableLayout(): boolean {
  /* one MediaQueryList per queue (banking useIsWide's pattern); no matchMedia (old browser / jsdom) → the table */
  const [mq] = React.useState(() => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(TABLE_QUERY) : null));
  const subscribe = React.useCallback((cb: () => void) => {
    mq?.addEventListener?.("change", cb);
    return () => mq?.removeEventListener?.("change", cb);
  }, [mq]);
  return React.useSyncExternalStore(subscribe, () => (mq ? mq.matches : true), () => true);
}

interface RenewalQueueProps {
  rows: QueueItem[];
  strong: boolean;
  selected: ReadonlySet<string>;
  onSelect: (ids: string[], on: boolean) => void;
  emptyText: string;
  /** R-2755: the other tabs that match the search / filters — offered on an empty tab ("1 match in 8–30 — show"). */
  elsewhere: ReturnType<typeof matchesElsewhere>;
  onOpenTab: (tab: QueueTab) => void;
  /** R-2404: open the renewal's Follow-up dialog. */
  onFollowup: (item: QueueItem) => void;
  names: Map<string, UserName> | undefined;
  /** R-2422: Last paid per subscription (one read for the whole list — last-paid-data.ts). */
  lastPaid: { data: Map<string, LastPaid> | undefined; loading: boolean; failed: boolean };
  /** R-2728: the last-docs read's state (the rows carry their own `docs`). */
  docsState: { loading: boolean; failed: boolean };
  /** R-2740 / R-2839: open the row drawer — the product name plain (a real button, no mouse-only row click, R-1658),
      the History button with view "history". */
  onOpen: (subId: string, view?: DrawerView) => void;
  /** R-2808: billed together last cycle → the row's "Bills with <other plan>" (opens Bill together); null = none. */
  togetherOf?: (subId: string) => { text: string; title?: string; onClick: () => void } | null;
  /** R-2859: such a row (2+ of its group still ticked) → its ONE button is Bill together, not its own Bill next part; null = its own button. */
  togetherButtonOf?: (subId: string) => TogetherRowAction | null;
}

function RenewalQueue({ rows, strong, selected, onSelect, emptyText, elsewhere, onOpenTab, onFollowup, names, lastPaid, docsState, onOpen, togetherOf, togetherButtonOf }: RenewalQueueProps) {
  /* R-237: billing + support see Renewals but cannot open /quotes (middleware sends them
     home) — no "Open quote" link for them. */
  const { data: me } = useCurrentUser();
  const canQuotes = canOpenQuotes(me?.role);
  /* R-2232: draft vs sent for the row's "Renewal sent Q-x" line (same cached query as the page). */
  const { data: openRenewals } = useOpenRenewalQuotes();
  const quoteStatus = React.useMemo(() => openRenewalQuoteStatus(openRenewals ?? []), [openRenewals]);
  const canInvoices = canOpenInvoices(me?.role);
  /* R-2764: the row buttons read the viewer from here — no user / open-quotes read per row. */
  /* null while the user is read: the row buttons show but stay disabled (R-2710: no click before the role is known). */
  const viewer = React.useMemo(() => (me ? { role: me.role, tenantGracePeriodDays: me.tenantGracePeriodDays ?? 0 } : null), [me]);
  const table = useTableLayout();
  /* R-2764: 50 rows, then "Show N more" (the parent remounts this per tab / tile, so it starts at 50 again). */
  const [limit, setLimit] = React.useState(QUEUE_PAGE_ROWS);
  /* R-2866: the quote number opens a pop-up here; its hover lists the quote's products (ONE read for the rows on screen) */
  const quotePeek = useRowQuotePeek(firstRows(rows, limit).shown, canQuotes);
  if (rows.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-ink-3">
        <p>{emptyText}</p>
        {elsewhere.length > 0 && (
          <p className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1" data-testid="renewals-matches-elsewhere">
            {elsewhere.map((m) => (
              <button key={m.tab} type="button" onClick={() => onOpenTab(m.tab)}
                className="rounded-sm font-medium text-ink underline underline-offset-2 hover:text-amber focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">
                {m.words} — show
              </button>
            ))}
          </p>
        )}
      </div>
    );
  }

  const page = firstRows(rows, limit);
  /* R-2764: "Select all renewals on screen" = the rows shown (not the ones behind Show more). */
  const allOn = page.shown.every((r) => selected.has(r.sub.id));
  const someOn = page.shown.some((r) => selected.has(r.sub.id));
  const showMore = page.more > 0 && (
    <div className="border-t border-hairline px-3 py-3 text-center">
      <Button variant="default" size="sm" onClick={() => setLimit((n) => n + QUEUE_PAGE_ROWS)} data-testid="renewals-show-more">
        Show {Math.min(page.more, QUEUE_PAGE_ROWS)} more
        <span className="text-ink-3">· {page.shown.length} of {rows.length} shown</span>
      </Button>
    </div>
  );

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
       the docs still loading / unread, or a linked renewal quote the docs lines do not show (R-2841: cardDocQuote). */
    const keepActionLine = action.kind === "send" || docsState.loading || docsState.failed
      || (!!action.quoteId && cardDocQuote(item.docs)?.id !== action.quoteId);
    return (
      <>
        {keepActionLine && <RowActionLine action={action} canQuotes={canQuotes} className={className} />}
        <LastDocsLines docs={item.docs} loading={docsState.loading} failed={docsState.failed} canQuotes={canQuotes} canInvoices={canInvoices} todayIst={todayIst} prior={item.prior} className={className} />
      </>
    );
  };
  /* R-2817: the Due date / day count = the chip's own anchor (stage.ts rowAnchor); renewal_date while the stage loads. */
  const dueMemo = new Map<QueueItem, ReturnType<typeof dueCellFacts>>();
  const dueOf = (item: QueueItem) => {
    let f = dueMemo.get(item);
    if (!f) { f = dueCellFacts(item.stage, item.sub, item.daysUntil); dueMemo.set(item, f); }
    return f;
  };
  /* R-2817: once the stage is read, the line under the date counts from the same anchor as the chip
     (the part's own date is then already in the anchor — not counted a second time). */
  const sentDue = (item: QueueItem, className?: string) => {
    const sent = item.docs?.sent;
    if (item.status.key !== "quote-sent" || !sent) return null;
    const anchored = item.stage?.days != null;
    return <SentDueLines sent={anchored ? { ...sent, dueDate: null, kind: item.stage!.anchorKind === "part" ? "part" : "renewal" } : sent} daysUntil={anchored ? item.stage!.days! : item.daysUntil} todayIst={todayIst} className={className} />;
  };

  return (
    <>
      {/* Cards — viewports < 1260px (phones and small laptops), two per row from md. R-2764: only one layout is mounted. */}
      {!table && (
      <ul className="p-3 space-y-2 md:grid md:grid-cols-2 md:gap-2 md:space-y-0" data-testid="renewals-cards">
        {page.shown.map((item) => {
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
                  {/* R-2740: the product opens the row drawer (the renewal's documents, payments, follow-ups) */}
                  <button type="button" onClick={() => onOpen(sub.id)} data-testid="renewal-open-drawer"
                    className="mt-0.5 block max-w-full truncate rounded-sm text-left text-2xs text-ink-3 underline-offset-2 hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                    aria-label={`Open details — ${sub.customer_name} · ${sub.plan}`}>
                    {planSeatsWords(sub.plan, sub.seats)}
                  </button>
                  {/* R-2755: the subscription's domain (nothing when it has none) */}
                  {subscriptionDomain(sub) && (
                    <p className="mt-0.5 truncate text-2xs text-ink-2" title={subscriptionDomain(sub) ?? undefined} data-testid="renewal-card-domain">{subscriptionDomain(sub)}</p>
                  )}
                  {/* R-2808: billed together last cycle — opens Bill together */}
                  {(() => {
                    const t = togetherOf?.(sub.id);
                    return t ? (
                      <button type="button" onClick={t.onClick} data-testid="renewal-bills-with" title={t.title}
                        className="mt-0.5 block max-w-full truncate rounded-sm text-left text-2xs font-medium text-amber-ink underline underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">
                        {t.text}
                      </button>
                    ) : null;
                  })()}
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
                  {/* R-2817: the row's ONE anchor date — the chip's own date (due-anchor.ts) */}
                  <p className="text-xs text-ink-2" title={dueOf(item).title ?? undefined}>{dueOf(item).date ? formatDate(dueOf(item).date!) : "—"}</p>
                  {sentDue(item)}
                </div>
              </div>

              {/* R-2758: vendor hold, previous term unpaid and at risk are the stage chip's flag icons;
                  Renew anyway (grace over) is in the row's ⋯. */}
              {/* R-2232: "Renewal quote Q-x not sent yet" — never a second Generate. R-2728: last quote / invoice. */}
              {docsFor(item, action, "mb-2 text-xs")}
              {/* R-2839: History — the row drawer on its History section */}
              {/* R-2842: the ONE history way on a card — Payments tab when the row has a payment (R-2422's popover is gone) */}
              <HistoryButton onOpen={() => onOpen(sub.id, lastPaid.data?.get(sub.id) ? "payments" : "history")} name={`${sub.customer_name} · ${sub.plan}`} className="mb-2 block" />

              <div className="pt-2 border-t border-hairline/60">
                <RenewalActions sub={sub} daysUntil={days} layout="card" strong={strong} onFollowup={followupFor(sub)} messaging stage={stage} payHref={item.payHref} viewer={viewer} together={togetherButtonOf?.(sub.id) ?? null} />
              </div>
            </li>
          );
        })}
      </ul>
      )}

      {/* Desktop table — R-2759: from a 1260px window (QUEUE_TABLE_MIN_VIEWPORT_PX; a 1280 laptop's inner width
          is 1264–1276), eight columns on the queue.ts budget; R-2854: their widths grow with the window (queueColCss) and a cell is at most three short lines. */}
      {table && (
      <div data-testid="renewals-table">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            {QUEUE_TABLE_COLS.map((c) => (
              <col key={c.key} style={{ width: queueColCss(c) }} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-hairline bg-muted/30">
              {QUEUE_TABLE_COLS.map((c) => c.key === "select" ? (
                <th key={c.key} className="px-1.5 py-1.5">
                  <input
                    type="checkbox"
                    aria-label="Select all renewals on screen"
                    className="cursor-pointer accent-amber"
                    checked={allOn}
                    ref={(el) => { if (el) el.indeterminate = someOn && !allOn; }}
                    onChange={(e) => onSelect(page.shown.map((r) => r.sub.id), e.target.checked)}
                  />
                </th>
              ) : (
                <th key={c.key} className={cn("px-1.5 py-1.5 text-xs font-medium text-ink-3", c.align === "right" ? "text-right" : "text-left")}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.shown.map((item) => {
              const { sub, daysUntil: days, amount, frequency, contact, stage } = item;
              const paid = lastPaid.data?.get(sub.id);
              return (
                <tr key={sub.id} className="border-b border-hairline last:border-0 align-top hover:bg-muted/20" data-testid="renewal-row">
                  <td className="px-1.5 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`Select ${sub.customer_name} — ${sub.plan}`}
                      className="cursor-pointer accent-amber"
                      checked={selected.has(sub.id)}
                      onChange={(e) => onSelect([sub.id], e.target.checked)}
                    />
                  </td>
                  <td className="min-w-0 px-1.5 py-1.5 leading-[1.125rem]"><CustomerCell name={sub.customer_name} customerId={sub.customer_id} contact={contact} more={followupWords(item.followup, names)} /></td>
                  <td className="min-w-0 px-1.5 py-1.5 leading-[1.125rem]">
                    <ProductCell plan={sub.plan} seats={sub.seats} vendor={sub.vendor} term={nextTermWords(sub)} termShort={nextTermShort(sub)} frequency={frequency} period={item.period} domain={subscriptionDomain(sub)} onOpen={() => onOpen(sub.id)} together={togetherOf?.(sub.id) ?? null}
                      quoteLine={<RenewalQuoteLine docs={item.docs} stage={stage} loading={docsState.loading || (!stage && !docsState.failed)} failed={docsState.failed} canQuotes={canQuotes} todayIst={todayIst} lines={quotePeek.linesOf} onPeek={quotePeek.open} linesFailed={quotePeek.failed} />} />
                  </td>
                  <td className="px-1.5 py-1.5"><DueCell date={dueOf(item).date} days={dueOf(item).days} title={dueOf(item).title} note={showsExpiry(item) ? quoteExpiryShort(item.docs?.sent?.expiresDate, todayIst) : null} /></td>
                  <td className="px-1.5 py-1.5 text-right">
                    <AmountTableCell text={amount.text} gst={amount.gst} title={amount.quoteNote ? `${amount.gst} · ${amount.quoteNote}` : undefined} />
                  </td>
                  <td className="min-w-0 px-1.5 py-1.5"><StageChip stage={stage} size="sm" compact canQuotes={canQuotes} /></td>
                  <td className="min-w-0 px-1.5 py-1.5">
                    {/* R-2840 / R-2854: Last bill = the invoice → the last payment (same Last paid read as the cards); the quote is Product's quote line */}
                    <LastInvoiceCell docs={item.docs} loading={docsState.loading} failed={docsState.failed} canInvoices={canInvoices} todayIst={todayIst} prior={item.prior}
                      paid={{ paid, loading: lastPaid.loading || docsState.loading, failed: lastPaid.failed || (!paid && docsState.failed) }}
                      /* R-2839: History (replaced "+N earlier") — the row drawer on its History section */
                      historyButton={<HistoryButton onOpen={() => onOpen(sub.id, "history")} name={`${sub.customer_name} · ${sub.plan}`} />} />
                  </td>
                  <td className="min-w-0 px-1.5 py-1.5">
                    <RenewalActions sub={sub} daysUntil={days} layout="table" strong={strong} onFollowup={followupFor(sub)} messaging stage={stage} payHref={item.payHref} viewer={viewer} together={togetherButtonOf?.(sub.id) ?? null} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
      {showMore}
      {quotePeek.dialog}
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/** R-239 / R-2403: a row as the queue filters / sort read it (queue.ts filterQueue, sortQueue). */
const asQueueRow = (i: QueueItem) => ({
  id: i.sub.id, daysUntil: i.dueDays /* R-2858: the date sort = the Due column's order */, amount: i.amount.value, plan: i.sub.plan, vendor: i.sub.vendor,
  statusKey: i.status.key, stageKey: i.stage?.key ?? null, atRisk: i.atRisk, customer: i.sub.customer_name, commitment: i.commitment, item: i,
});

const SELECT_CLS = "bg-paper border border-hairline rounded-md text-xs px-2.5 py-1.5 font-medium text-ink focus:outline-none focus:border-amber cursor-pointer";

export default function RenewalsPage() {
  const { data: subs, isLoading, error, refetch } = useSubscriptions();
  /* R-453: an open renewal quote whose link-back is missing still shows "Open quote". */
  const { data: openRenewals, isLoading: openRenewalsLoading, isError: openRenewalsError } = useOpenRenewalQuotes();
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
  const { data: monthQuotes, isLoading: monthQuotesLoading, isError: monthQuotesError } = useRenewalPaymentsForMonth(month);

  /* Rows on the page: their contacts and renewal quotes (hooks run before any early return).
     R-2586: every dated row — the Later (91+ days) tab lists the annual book past 90 days. */
  const listed = React.useMemo(() => (subs ?? [])
    .filter(onRenewalsPage)
    .map((s) => withRenewalQuote(s, openRenewalMap)), [subs, openRenewalMap]);
  /* R-2753: isLoading — the Remind button waits for the contacts, so a customer with no email is never counted in "Email N". */
  const { data: contacts, isLoading: contactsLoading } = useRenewalContacts(listed.map((s) => s.customer_id ?? "").filter(Boolean));
  const { data: quoteInfo, isLoading: quoteInfoLoading, isError: quoteInfoError } = useRenewalQuoteInfo(listed.flatMap((s) => [s.renewal_quote_id, s.quote_id]));   // R-2767: + the sale quote (its currency)
  /* R-2404: owner / next follow-up / promise per renewal — Payment Follow-up's rows for these subscriptions. */
  const { data: fuData } = useRenewalFollowups(listed.map((s) => s.id), listed.map((s) => s.customer_id ?? ""));
  const { data: names } = useUserNames();
  /* R-2422: Last paid for every listed renewal — one batched, paged read (last-paid-data.ts). */
  const lastPaidQ = useRenewalLastPaid(listed);
  const lastPaid = { data: lastPaidQ.data, loading: lastPaidQ.isLoading, failed: lastPaidQ.isError };
  /* R-2728: last quote sent / last invoice / "Renewal quote sent" for every listed renewal — one batched read. */
  const lastDocsQ = useRenewalLastDocs(listed);
  /* R-2761: open "held" renewal undos (a paid part's payment undone, date kept) → a flag on the row. */
  const { data: holds } = useRenewalHolds(listed.map((s) => s.id));
  const docsState = { loading: lastDocsQ.isLoading, failed: lastDocsQ.isError && !lastDocsQ.data };
  const [fuFilters, setFuFilters] = React.useState<FollowupFilters>(NO_FOLLOWUP_FILTERS);
  const [followupFor, setFollowupFor] = React.useState<QueueItem | null>(null);
  /* R-2740: the row drawer — ?sub=<id> (shareable, Back closes it). */
  const [drawerSub, openDrawer, closeDrawer, drawerView] = useRenewalDrawerSub();
  const [assignOpen, setAssignOpen] = React.useState(false);
  const [assigning, setAssigning] = React.useState(false);
  const canReassign = mayReassignFollowup(me?.role);
  const team = React.useMemo(
    () => [...(names?.values() ?? [])].filter((u) => !u.inactive).sort((a, b) => a.label.localeCompare(b.label)),
    [names],
  );

  /* R-2764 (R-2742 PERF-1, 14 Nov freeze): every row of every tab is built ONCE per data change
     (queue-items.ts) — not on each tab click, tick or search keystroke. `todayDate` changes with the IST day. */
  const todayIst = istToday(today);
  /* noon IST of today — the rules read the IST day from it (same day as `new Date()`). */
  const todayDate = React.useMemo(() => new Date(`${todayIst}T12:00:00+05:30`), [todayIst]);
  const docsLoadingAll = lastDocsQ.isLoading || docsState.failed || quoteInfoLoading || openRenewalsLoading;
  const built = React.useMemo(() => (subs ? buildQueueItems({
    subs, openRenewalMap, quoteInfo, quoteStatusMap, docs: lastDocsQ.data, docsLoading: docsLoadingAll,
    fuData, contacts, role: me?.role, graceDays, today: todayDate, todayIst: todayIst, holds,
  }) : null), [subs, openRenewalMap, quoteInfo, quoteStatusMap, lastDocsQ.data, docsLoadingAll, fuData, contacts, me?.role, graceDays, todayDate, todayIst, holds]);
  /* The tab from ?bucket= (old values map through resolveBucket) and every tab's narrowed rows —
     kept until the search / filters / sort / data change, so a tab click only swaps the list shown. */
  /* R-2741 (audit 14 Nov: "₹4,82,128 unpaid" matched nothing): the header's figure is the rows' OWN owed amounts
     (R-2818's rule — invoices still due + an instalment not invoiced yet) added up, not subscriptions.outstanding_amount.
     Nothing shows while the documents are still being read, so the figure never flips after load. */
  const duesLine = React.useMemo(() => {
    if (!subs || projRecvQ.isPending || !built || docsLoadingAll) return null;
    const renewalDues = subs.filter(onRenewalsPage).reduce((t, s) => t + subscriptionDue(s), 0);
    const rowsOwed = built.allItems.reduce((t, i) => t + (i.owed?.total ?? 0), 0);
    return subscriptionDuesLine(toChaseSummary(subs, projRecvQ.data ?? {}), renewalDues, projectsUnread, rowsOwed);
  }, [subs, built, docsLoadingAll, projRecvQ.data, projRecvQ.isPending, projectsUnread]);
  const counts = React.useMemo(
    () => (built ? Object.fromEntries(QUEUE_TABS.map((t) => [t, built.tabs[t].length])) as Record<QueueTab, number> : null),
    [built],
  );
  const resolved = !counts
    ? { tab: "overdue" as QueueTab, atRisk: false }
    : (LEGACY_BUCKETS as readonly string[]).includes(bucketRaw)
      ? resolveBucket(bucketRaw as LegacyBucket, counts)
      : resolveBucket(bucketRaw as QueueTab, counts);
  const atRiskOn = filters.atRisk || resolved.atRisk;
  const narrowed = React.useMemo(() => {
    if (!built) return null;
    const active: QueueFilters = { ...filters, atRisk: atRiskOn };
    /* R-239: the search narrows the tabs (and their counts) only; R-2403: so do the filters.
       R-2404: Mine · Follow-up due · Promise broken narrow the tabs the same way. */
    const narrow = (list: QueueItem[]): QueueItem[] =>
      sortQueue(filterQueue(filterByFollowup(list, fuFilters, me?.userId).filter((i) => matchesRenewalSearch(i.sub, search)).map(asQueueRow), active), sort)
        .map((r) => r.item);
    return { narrow, tabs: Object.fromEntries(QUEUE_TABS.map((t) => [t, narrow(built.items[t])])) as Record<QueueTab, QueueItem[]> };
  }, [built, filters, atRiskOn, fuFilters, me?.userId, search, sort]);
  /* R-2404 chip counts — whole queue, so a person sees "Mine (12)" before pressing it. */
  const fuCounts = React.useMemo(() => {
    if (!built) return { mine: 0, due: 0, broken: 0 };
    const c = (f: Partial<FollowupFilters>) => filterByFollowup(built.allItems, { ...NO_FOLLOWUP_FILTERS, ...f }, me?.userId).length;
    return { mine: c({ mine: true }), due: c({ followUpDue: true }), broken: c({ promiseBroken: true }) };
  }, [built, me?.userId]);
  /* R-2808 Bill together: only once R-2807's route answers (404 before it lands → nothing shows). */
  /* R-2849: yearly rows bill together too (one renewal quote) — any row, not only split ones */
  const togetherProbe = useBillTogetherProbe(!!built && built.allItems.length > 0);
  const togetherOn = togetherProbe === "on";
  /* R-2832 F6: while the check is out the groups box already holds its place (nothing pressable), so it does not
     pop in and push the table down — only for the money roles the route allows (others get 403 → never shown) */
  const togetherPending = togetherProbe === "pending" && !!me?.role && canRecordMoney(me.role);
  const togetherVisible = togetherOn || togetherPending;
  const billTogether = useBillTogether({ canQuotes: canOpenQuotes(me?.role), canInvoices: canOpenInvoices(me?.role) });
  /* the groups + hints, once per data change (R-2764) — not on every tick / keystroke */
  const togetherIdx = React.useMemo(() => (togetherVisible && built ? togetherIndex(built.allItems) : null), [togetherVisible, built]);
  /* the group subscriptions the user unticked (every group starts all ticked — Pardeep 14 Nov) */
  const [togetherOff, setTogetherOff] = React.useState<Set<string>>(() => new Set());
  const toggleTogether = (id: string, on: boolean) => setTogetherOff((o) => {
    const n = new Set(o);
    if (on) n.delete(id); else n.add(id);
    return n;
  });

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
      <div className="mx-auto max-w-[1800px] px-4 2xl:px-8 pb-20 pt-4">
        <div className="mb-6">
          <h1 className="font-serif text-2xl text-ink">Renewals</h1>
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

  /* R-1124: ONE classification (./classify.ts) feeds every number and list on this page.
     R-2403: a renewal whose quote is paid leaves Overdue (renewedPaid). R-2764: worked out once per
     data change (buildQueueItems, in the useMemo above) — a tab click re-uses it. */
  if (!built || !narrowed || !counts) return null;
  const { enriched, groups, items, allItems } = built;
  const quoteOf = (sub: Subscription) => quoteInfo?.get(sub.renewal_quote_id ?? "");

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


  /* R-2405: the tiles add up the rows' own renewal amounts; a pressed tile lists those rows.
     R-2586: the tiles stay on the 90-day window (TILE_TABS) — Later is a look-ahead list. */
  const tileRowOf = new Map<string, TileRow>(TILE_TABS.flatMap((t) => items[t].map((i) => [i.sub.id, {
    id: i.sub.id, tab: t, statusKey: i.status.key, amount: i.amount.value, dueAmount: i.due.amount /* R-2862 */, renewalDate: i.sub.renewal_date,
  }] as const)));
  const tileFigures = renewalTiles([...tileRowOf.values()], monthQuotes ?? [], month);
  /* R-2751: this month's Forecast bar = the Renewed tile's "of ₹X due in <month>" (paid + still due, before GST). */
  const forecast = forecastWithThisMonth(forecastByDate, tileFigures.renewedMonth, month);
  const paidSubs = new Set(paidRenewalsInMonth(monthQuotes ?? [], month).map((q) => q.renewal_subscription_id ?? ""));
  /* R-2741: each tile's tab rows = tile rows + the closed rows it leaves out (tiles.ts reconcileWindows). */
  const windows = reconcileWindows([...tileRowOf.values()], month);
  /* R-2855: a row's status (Renewed / quote sent) is final only once its documents, linked quotes and this
     month's paid renewals are read — until then the tiles are placeholders (they showed ₹2.9L, then ₹5.4L).
     A read that FAILED with nothing to show is never final either: the tiles say "Couldn't load" (a failed
     background re-read keeps the last good rows, so the numbers stay). */
  const tilesLoading = lastDocsQ.isLoading || quoteInfoLoading || openRenewalsLoading || monthQuotesLoading;
  const tilesFailed = docsState.failed || (quoteInfoError && !quoteInfo) || (openRenewalsError && !openRenewals) || (monthQuotesError && !monthQuotes);

  const bucketTab = resolved.tab;
  const shown = narrowed.tabs;
  /* R-2405: a pressed tile lists its rows from every tab (search / filters / sort still apply). */
  /* R-2586: Later rows are not tile rows (no tileRowOf entry) — a pressed tile never lists them. */
  /* R-2741: the Renewed tile lists every renewed row — also one whose date moved on into Later (no tile row for it). */
  const renewedRowOf = (i: QueueItem): TileRow => ({ id: i.sub.id, tab: "later", statusKey: i.status.key, amount: 0, renewalDate: i.sub.renewal_date });
  const tileShown = narrowed.narrow(tile ? allItems.filter((i) => {
    const tr = tileRowOf.get(i.sub.id);
    if (tile === "renewedMonth") return renewedRowMatches(renewedRowOf(i), month, paidSubs);
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
  const { mine: mineCount, due: dueCount, broken: brokenCount } = fuCounts;

  /* R-2751: the header counts the rows on the tabs (each row is on exactly one tab), so it equals the tabs added up;
     with a search / filter on, it also says how many of them match (= the narrowed tab counts added up). */
  const queueCount    = allItems.length;
  const shownCount    = QUEUE_TABS.reduce((s, t) => s + shown[t].length, 0);
  /* R-2756: Top risk / the Renewal AI pick = the most overdue CHASED at-risk row (never a Won't renew,
     stopped, paused or expired one), and its day count is the row chip's own (stage.days), naming
     the date it counts from. Real, computed reasons only — never fabricated signals (NPS/logins).
     No pick while the stages are still being read — the name never flips after load (as the row chip, R-2758). */
  const topRisk       = lastDocsQ.isLoading || quoteInfoLoading || openRenewalsLoading ? null : topRiskPick(allItems);
  const topHighRisk   = topRisk?.sub.customer_name ?? "a key customer";
  const topReasons    = topRisk ? topRiskReasons(topRisk, todayIst) : [];

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
    const owedById = new Map(allItems.map((i) => [i.sub.id, i.owed?.total ?? null]));   // R-2818: the one owed rule, blank while not read
    const rows = upcoming90
      .slice()
      .sort((a, b) => a.daysUntil - b.daysUntil)
      .map(({ sub, daysUntil }) => {
        const risk = renewalRisk(sub, { owed: owedById.get(sub.id) ?? null });
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
          owedById.get(sub.id) ?? "",
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
  /* Urgent rows: the primary button is filled — the queue and the row drawer (R-2740) read the same value. */
  const queueStrong = tile ? tile === "overdue" || tile === "due30" : bucketTab === "overdue" || bucketTab === "due7";
  /* only ticked rows still on screen — a tick hidden by a later search / filter is not reminded */
  const tickedShown = visibleRows.filter((i) => selected.has(i.sub.id));
  /* R-2808: subscriptions billed together last cycle — a group per customer, ticked by default (Pardeep
     14 Nov), and each row's "Bills with <other plan>"; ticked rows of one customer → "Bill together". */
  const togetherGroups = togetherIdx ? groupsShown(togetherIdx, new Set(visibleRows.map((i) => i.sub.id))) : [];
  /* the hint opens the group as the box above shows it (an unticked one stays out) */
  const togetherOf = togetherOn && togetherIdx
    ? (id: string) => {
        const h = togetherIdx.hintOf.get(id);
        /* R-2832 F5: under two still ticked the hint says "tick at least two" instead of opening the dialog */
        return h ? togetherHint(h, togetherOff, billTogether.open) : null;
      }
    : undefined;
  /* R-2859: the same group, as the row’s ONE button — never Bill next part beside a box that bills the pair */
  /* from the first paint the box shows (check still out → shown, not pressable): the button never swaps under a click */
  const togetherButtonOf = togetherVisible && togetherIdx
    ? (id: string) => togetherRowButton(togetherIdx.hintOf.get(id), id, togetherOff, billTogether.open, !togetherOn)
    : undefined;
  /* only ticked rows still on screen (as the reminder) — a tick hidden by a search is never billed */
  const offerTicked = togetherOn && canOfferBillTogether(tickedShown.map(togetherRowOf));
  const scope = reminderScope(tickedShown.length, tile ? TILE_LABEL[tile] : QUEUE_TAB_LABEL[bucketTab], visibleRows.length);
  /* undefined = contacts not read yet (the send route still checks); null = no email on file. */
  const emailOf = (i: QueueItem): string | null | undefined =>
    !i.sub.customer_id ? null : contacts ? contacts.get(i.sub.customer_id)?.email ?? null : undefined;
  /* R-1124 in grace → emailed; R-2225 Won't renew, R-2431 flex, R-808 split-billed, past grace,
     no email, reminded today → skipped and named (reminders.ts reminderPlan). R-2820: the SAME plan
     gives the button its count — only rows it can really email; at 0 it is greyed with the reason. */
  const scopeRows = tickedShown.length > 0 ? tickedShown : visibleRows;
  const remindPlan = reminderPlan(scopeRows, { today, tenantGraceDays: graceDays, emailOf, isPaid: (i) => i.status.key === "renewed" });
  function openReminder() {
    if (bulkSending || remindPlan.send.length === 0) return;
    setReminder({ scope, ...remindPlan });
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
    <div className="mx-auto max-w-[1800px] px-4 2xl:px-8 pb-20 pt-4">
      {/* ── Page header ── */}
      {/* R-2878: the buttons float right of the title and the count / dues line runs on from the title (beside the buttons the line used to
          start on its own row under the title and wrap to two lines) — the second line only starts under the buttons, full width: the
          header is 52px, not 76 (24px of the three-rows-above-the-fold promise) */}
      <div className="mb-2 flow-root">
        {/* Header actions. R-2753: no floating email button on a phone (it was the biggest control
            over the Forecast) — the one Remind button stays here, small, on every size; Export is
            desktop only. */}
        <div className="float-right ml-4 flex items-center gap-2">
          <Button
            variant="default"
            size="sm"
            className="hidden md:inline-flex"
            onClick={handleExport}
          >
            <Icon name="download" size={14} />
            Export
          </Button>
          {/* R-2753: the ONE reminder button — the ticked rows, else the open tab's rows (label says which).
              R-2820: it counts only the rows it can send; at 0 greyed with the reason. Waits for the contacts. */}
          <RenewalRemindButton scope={scope} plan={remindPlan} busy={bulkSending} loading={contactsLoading} onClick={openReminder} />
        </div>
        {/* R-2821: no "Revenue" eyebrow — the breadcrumb above already says Billing › Renewals (20px back for the rows) */}
        <h1 className="inline font-serif text-2xl text-ink">Renewals</h1>
        <p className="ml-3 inline text-sm text-ink-3">
            {queueCount} subscription{queueCount !== 1 ? "s" : ""} in the queue
            {shownCount !== queueCount && <> · {shownCount} match the search / filters</>}
            {duesLine && (
              <>
                {" · "}
                {/* R-2855: the hover says what this figure is — and that it is not the tiles' renewal value */}
                <Link
                  href={drillHref("customersUnpaid") as Route}
                  className="text-rose hover:underline"
                  data-testid="renewals-dues-line"
                  title="Invoices already raised on these renewals that are not fully paid, plus an instalment that is due and not invoiced yet. The tiles below show renewal value (the next term's bill) — a different number."
                >
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

      {/* R-2405: the tiles — count + renewal ₹ in the table's own money; a press lists those rows. */}
      {/* R-2855: placeholders until the reads the tiles' numbers come from are in — a number never changes after it shows */}
      <RenewalTileRow tiles={tileFigures} month={month} active={tile} onPick={pickTile} windows={windows} narrowed={filtered || search.trim() !== ""} loading={tilesLoading} failed={tilesFailed} />

      {/* R-2266: ONE strip, closed by default (remembered per user). R-2405: the tiles above carry
          the money and counts (one fact, one place) — the strip keeps the forecast and the
          Renewal AI top pick, a link on its line. */}
      <CollapsibleKpiStrip
        stripId="renewals"
        userId={me?.userId}
        title="Forecast"
        className="mb-3"
        summary={<StripFact label="Next 6 months" value={tilesLoading ? "…" : rupee(forecast.totalAmount, { compact: true })} />}
        extras={topRisk ? (
          <StripLink
            tone="rose"
            title="Renewal AI · next best action — the top renewal at risk"
            onClick={() => {
              const cid = topRisk.sub.customer_id;
              router.push((cid ? `/customers/${cid}` : "/customers") as never);
            }}
          >
            Top risk: {topHighRisk}
          </StripLink>
        ) : undefined}
      >
        <ForecastPanel
          forecast={forecast}
          loading={tilesLoading}
          atRiskCount={highRiskSubs.length}
          atRiskArr={groups.atRiskArr}
          topName={topRisk ? topHighRisk : null}
          topCustomerId={topRisk?.sub.customer_id ?? null}
          topReasons={topReasons}
        />
      </CollapsibleKpiStrip>

      {/* R-1621: grace ended unpaid → the owner stops the service or gives more days. */}
      <GraceOverCard />

      {/* R-2586: subscriptions with no renewal date are on no tab — named here, not dropped. */}
      <NoRenewalDateCard subs={noRenewalDate(all)} />

      {/* ── The renewal queue — tabs by time window (R-2403) ── */}
      <Card flush>
        <div className="px-3 pt-2 sm:px-4">
          {tile ? (
            <TileViewBar
              tile={tile}
              count={tileShown.length}
              note={tile === "renewedMonth" && !(filtered || search.trim()) && tileFigures.renewedMonth.count > tileShown.length
                ? `· ${tileFigures.renewedMonth.count - tileShown.length} more renewed (paid, no longer on the list)` : undefined}
              onClear={() => pickTile(tile)}
            />
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
          <div className="mt-1.5 mb-1.5 flex flex-wrap items-center gap-2">
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search customer or domain"
              aria-label="Search renewals by customer or domain"
              wrapperClassName="w-full sm:w-56"
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
          {togetherIdx && (
            <BillTogetherGroups groups={togetherGroups} onBill={billTogether.open} subOf={(id) => togetherIdx.subOf.get(id)}
              off={togetherOff} onToggle={toggleTogether} pending={togetherPending} />
          )}
          <RenewalQueue
            key={tile ?? bucketTab}   /* R-2764: a new tab / tile starts at 50 rows again */
            rows={tile ? tileShown : shown[bucketTab]}
            strong={queueStrong}
            selected={selected}
            onSelect={onSelect}
            emptyText={tabEmpty}
            elsewhere={tile || !(filtered || search.trim()) ? [] : matchesElsewhere(bucketTab, Object.fromEntries(QUEUE_TABS.map((t) => [t, shown[t].length])) as Record<QueueTab, number>)}
            onOpenTab={openTab}
            onFollowup={setFollowupFor}
            names={names}
            lastPaid={lastPaid}
            docsState={docsState}
            onOpen={openDrawer}
            togetherOf={togetherOf}
            togetherButtonOf={togetherButtonOf}
          />
        </div>
      </Card>
      {billTogether.dialog}

      {/* R-2740: the row drawer — every quote + invoice, payments, follow-ups, flags explained (read-only). */}
      {(() => {
        const drawerItem = drawerSub ? allItems.find((i) => i.sub.id === drawerSub) ?? null : null;
        /* the same filled / outline button as the row it came from */
        return (
          <RenewalDrawer
            item={drawerItem && { ...drawerItem, contact: drawerItem.sub.customer_id ? contacts?.get(drawerItem.sub.customer_id) : undefined }}
            open={!!drawerSub}
            view={drawerView}
            onClose={closeDrawer}
            names={names}
            followupRows={fuData?.rows ?? []}
            onFollowup={drawerItem?.sub.customer_id ? () => setFollowupFor(drawerItem) : undefined}
            together={drawerItem ? togetherButtonOf?.(drawerItem.sub.id) ?? null : null}
            strong={queueStrong}
          />
        );
      })()}

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
          amountDue={subscriptionOwedOf(followupFor.sub, followupFor.docs)?.total ?? 0}   /* R-2818: what its documents still owe — never the renewal's price */
          renewal={{ subscriptionId: followupFor.sub.id }}
          contact={contacts?.get(followupFor.sub.customer_id)}
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
        {/* R-2808: 2+ ticked rows of ONE customer, billed in parts → one proforma for all of them */}
        {offerTicked && (
          <BulkBarButton icon="plus" onClick={() => billTogether.open(tickedShown.map((i) => i.sub.id), tickedShown[0].sub.customer_name ?? "")}>
            {BILL_TOGETHER}
          </BulkBarButton>
        )}
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
      <RenewalReminderDialog state={reminder} onClose={() => setReminder(null)} onSend={(rows) => sendAll(rows)} emailOf={emailOf}
        /* R-2856: a skipped row's next step — its drawer (Bill next part / Send renewal / Follow up), or the customer page for a contact */
        /* the drawer opens a moment after the dialog has handed focus back to the Remind button (Radix, 0 ms timer) — Esc in the drawer then returns there, not to <body> */
        onOpenRow={(row) => { setReminder(null); window.setTimeout(() => openDrawer(row.sub.id), 60); }}
        customerHref={(row) => (row.sub.customer_id ? `/customers/${row.sub.customer_id}` : null)}
      />
    </div>
  );
}
