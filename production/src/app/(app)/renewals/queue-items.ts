/**
 * R-2764 (R-2742 PERF-1): the Renewals queue's rows, worked out ONCE per data change.
 *
 * 14 Nov 2026: a tab click on /renewals froze Chrome 45–60 s (owner). The page rebuilt every row of
 * all six tabs (stage, follow-up, decision, amount, risk …) on EVERY render — a tab click, a tick, a
 * keystroke in the search. This file is that build as a pure function, so the page can keep it in a
 * useMemo keyed on the data only: a tab click re-uses the rows and re-renders only the open tab.
 *
 * Same rules, same order as before (moved, not changed): R-1124 classifyRenewals, R-2403 queueTabs +
 * renewalRowStatus, R-2404 follow-up/decision, R-2422 frequency/commitment, R-2728 docs, R-2758 stage.
 */
import type { Subscription } from "@/lib/supabase/database.types";
import { daysUntilRenewal, onRenewalsPage } from "@/lib/renewals/buckets";
import { renewalStage, type RenewalStage, type RenewalHeld } from "@/lib/renewals/stage";
import { vendorHoldState } from "@/lib/renewals/vendor-hold";
import { canOpenQuotes } from "@/lib/quotes/access";
import { renewalRisk, riskChased } from "./risk";
import { priorTermOwedOf, priorTermOwedText, subscriptionOwedOf } from "./prior-due";
import type { SubscriptionOwed } from "@/lib/renewals/owed";
import { withRenewalQuote } from "./open-renewal-quotes";
import { classifyRenewals, type RenewalGroups } from "./classify";
import { dueDaysOf, duePeriodFacts, rowDue, type DuePeriod, type RowDue } from "./due-anchor";
import {
  QUEUE_TABS, queueTabs, renewalRowStatus, renewalAmount, isPaidRenewalQuote,
  type QueueTab, type RowStatus, type RenewalAmount, type RenewalQuoteInfo,
} from "./queue";
import type { RowContact } from "./queue-data";
import { renewalFollowup, renewalDecision, type RenewalFollowup, type RenewalDecision, type RenewalFollowupRow } from "./followup";
import { renewalFrequency, renewalCommitment, commitmentChip, type Commitment, type CommitmentChip } from "./frequency";
import type { LastDocs } from "./last-docs";
import { stageInputFor, payHref as stagePayHref } from "./stage-input";

/** A row before its item is built. R-2858: `dueDays` = the Due column's day count — the tab is picked by it. */
export interface QueueRow {
  sub: Subscription;
  /** IST days to renewal_date (grace, Won't renew and the status words are judged on it). */
  daysUntil: number;
  dueDays: number;
}

export interface QueueItem {
  sub: Subscription;
  daysUntil: number;
  /**
   * R-2858: IST days to the date the Due column shows (due-anchor.ts) — the row's tab is windowTab(dueDays),
   * so "Overdue 5d · part due 11 Nov" sits in Overdue even when the renewal date is today.
   */
  dueDays: number;
  /**
   * R-2858: the period the row is about — the unpaid part the Due date refers to (its own stored period), else
   * the next term. The Product line shows `period.short` (tooltip `period.words`) and, when set,
   * `period.running` ("Oct unpaid · Nov running"). null = no renewal date.
   */
  period: DuePeriod | null;
  /**
   * R-2862: the row's ONE "due date + amount due" (due-anchor.ts rowDue) — `due.days` is `dueDays`; the tiles add
   * `due.amount` (a late part's own value, not the whole term) and the drawer names `due.unpaidPart`.
   */
  due: RowDue;
  status: RowStatus;
  amount: RenewalAmount;
  contact: RowContact | undefined;
  atRisk: boolean;
  /** R-2404 */
  followup: RenewalFollowup;
  decision: RenewalDecision;
  customerOwnerId: string | null;
  /** R-2422: worked out once per row (frequency.ts) — the amount cell's words and the Commitment filter. */
  frequency: string | null;
  commitment: Commitment;
  /** R-2887: the row chip ("Annual · paid yearly", "Flexible (monthly)") — same rule as `commitment`; null = term unknown. */
  commitmentChip: CommitmentChip | null;
  /** R-2728: last quote sent / last invoice / the renewal quote with the customer (last-docs.ts). */
  docs: LastDocs | undefined;
  /** R-2758 (R-2738): the row's ONE stage (chip + button); null while its documents load. */
  stage: RenewalStage | null;
  /** R-2758: where Record payment goes (the open quote's dialog, else the invoice's). */
  payHref: string | null;
  /** R-2818: what the previous term still owes by the one owed rule (lib/renewals/owed.ts); null = documents not read. */
  prior: SubscriptionOwed | null;
  /** R-2818 (review #2): everything its documents still owe — risk reason, follow-up "Still owes", CSV Outstanding. */
  owed: SubscriptionOwed | null;
}

export interface QueueBuildInput {
  subs: readonly Subscription[];
  openRenewalMap: Map<string, string>;
  quoteInfo: Map<string, RenewalQuoteInfo> | undefined;
  quoteStatusMap: Map<string, string>;
  docs: Map<string, LastDocs> | undefined;
  /** documents / linked quote facts not read yet (or the read failed) → stage null, never a guess. */
  docsLoading: boolean;
  fuData: { rows: RenewalFollowupRow[]; ownerByCustomer: Map<string, string | null> } | undefined;
  contacts: Map<string, RowContact> | undefined;
  role: string | null | undefined;
  graceDays: number;
  today: Date;
  todayIst: string;
  /** R-2761: open 'held' renewal undos per subscription (held-data.ts) → the row's "Renewal held" flag; undefined = not read yet. */
  holds?: Map<string, RenewalHeld> | undefined;
}

export interface QueueBuild {
  enriched: QueueRow[];
  groups: RenewalGroups<QueueRow>;
  tabs: Record<QueueTab, QueueRow[]>;
  items: Record<QueueTab, QueueItem[]>;
  allItems: QueueItem[];
}

export function buildQueueItems(f: QueueBuildInput): QueueBuild {
  const { today, todayIst } = f;
  const quoteOf = (sub: Subscription) => f.quoteInfo?.get(sub.renewal_quote_id ?? "");
  const paid = (r: { sub: Subscription }) => isPaidRenewalQuote(r.sub, quoteOf(r.sub));
  /* R-2758 (R-2738): the stage's facts — only once the documents are read (no flip after load), only this
     renewal's quote / invoice (stage-input.ts). Read once per row; the flags are added in toItem. */
  const stageFacts = new Map<string, ReturnType<typeof stageInputFor>>();
  const stageFactsOf = (sub: Subscription) => {
    if (!stageFacts.has(sub.id)) {
      const linkedQuote = quoteOf(sub);
      stageFacts.set(sub.id, stageInputFor({
        sub, todayIst, docs: f.docs?.get(sub.id), docsLoading: f.docsLoading,
        linkedStatus: sub.renewal_quote_id ? f.quoteStatusMap.get(sub.renewal_quote_id) ?? null : null,
        linkedQuote: linkedQuote ?? null,
        renewalPaid: paid({ sub }),
      }));
    }
    return stageFacts.get(sub.id) ?? null;
  };
  /* R-2858: the Due column's day count BEFORE the rows are grouped — the stage's anchor (flags never move it),
     so the tab and At risk are picked by the same date the row shows. Not read yet → the renewal date. */
  const enriched: QueueRow[] = f.subs
    .filter(onRenewalsPage)
    .map((s) => {
      const sub = withRenewalQuote(s, f.openRenewalMap);
      const daysUntil = daysUntilRenewal(s.renewal_date!, today);
      const facts = stageFactsOf(sub);
      return { sub, daysUntil, dueDays: dueDaysOf(facts ? renewalStage(facts) : null, daysUntil) };
    });
  /* R-2818 (review #2): the risk score's "Unpaid balance" reads the one owed rule; null while the documents load */
  const owedOf = (sub: Subscription) => subscriptionOwedOf(sub, f.docs?.get(sub.id))?.total ?? null;
  const groups = classifyRenewals(enriched, (r) => renewalRisk(r.sub, { owed: owedOf(r.sub) }).level === "high", today, paid);
  const tabs     = queueTabs(groups);   // R-2858: by dueDays — the Due column's window
  const atRiskIds = new Set(groups.atRisk.map((r) => r.sub.id));
  const canQuotes = canOpenQuotes(f.role ?? undefined);

  const toItem = (r: QueueRow): QueueItem => {
    const risk = renewalRisk(r.sub, { owed: owedOf(r.sub) });
    const docs = f.docs?.get(r.sub.id);
    /* R-2728: a renewal quote / part bill with the customer, unpaid → "Renewal quote sent" (stays listed). */
    const status = renewalRowStatus(r.sub, r.daysUntil, { tenantGraceDays: f.graceDays, today, renewalPaid: paid(r), quoteSent: docs?.sent ?? null });
    /* R-2404: the renewal's follow-up state + where the decision stands. */
    const customerOwnerId = r.sub.customer_id ? f.fuData?.ownerByCustomer.get(r.sub.customer_id) ?? null : null;
    const followup = renewalFollowup(r.sub.id, f.fuData?.rows ?? [], { customerOwnerId, today: todayIst, paid: status.key === "renewed" });
    const linkedQuote = quoteOf(r.sub);
    /* R-2758 (R-2738): ONE stage per row — the facts read above (stageFactsOf) + this row's flags. */
    const facts = stageFactsOf(r.sub);
    const input = facts && {
      ...facts,
      flags: {
        /* R-2756: a Won't renew / stopped row is not a renewal to chase — no at-risk flag on it. */
        atRisk: atRiskIds.has(r.sub.id) && riskChased(r.sub) ? { reasons: risk.reasons.filter((x) => x !== "Seat usage not checked") } : null,
        vendorHold: vendorHoldState(r.sub, today),
        vendor: r.sub.vendor,   // R-2823: "Hold at Google — unpaid"
        priorTermUnpaid: priorTermOwedText(r.sub, docs),   // R-2818: the one owed rule, never outstanding_amount alone
        promiseBroken: followup.promiseBroken ? { promisedOn: followup.promisedOn } : null,
        followUpDue: followup.followUpDue ? { nextFollowUpOn: followup.nextFollowUpOn } : null,
        renewalHeld: f.holds?.get(r.sub.id) ?? null,
      },
    };
    const stage = input ? renewalStage(input) : null;
    const item: Omit<QueueItem, "due"> = {
      stage,
      dueDays: r.dueDays,
      period: duePeriodFacts(stage, docs, r.sub, todayIst),
      payHref: stage ? stagePayHref(stage, docs, canQuotes) : null,
      prior: priorTermOwedOf(r.sub, docs),
      owed: subscriptionOwedOf(r.sub, docs),
      sub: r.sub,
      daysUntil: r.daysUntil,
      status,
      followup,
      customerOwnerId,
      decision: renewalDecision(r.sub, {
        statusKey: status.key,
        /* the draft/sent status from the open renewal quotes, else the linked quote's own */
        quote: r.sub.renewal_quote_id
          ? { id: r.sub.renewal_quote_id, status: f.quoteStatusMap.get(r.sub.renewal_quote_id) ?? linkedQuote?.status ?? null, payment_status: linkedQuote?.payment_status ?? null }
          : null,
        followup,
      }),
      amount: renewalAmount(r.sub, quoteOf(r.sub), r.sub.quote_id ? f.quoteInfo?.get(r.sub.quote_id) : null),   // R-2767: sale quote's currency
      frequency: renewalFrequency(r.sub),
      commitment: renewalCommitment(r.sub),
      commitmentChip: commitmentChip(r.sub),
      docs,
      contact: r.sub.customer_id ? f.contacts?.get(r.sub.customer_id) : undefined,
      atRisk: atRiskIds.has(r.sub.id),
    };
    /* R-2862: the row's one due date + amount due, from the stage, period and amount just built */
    return { ...item, due: rowDue(stage, item.period, r.sub, r.daysUntil, item.amount.value, docs) };
  };
  const items = {} as Record<QueueTab, QueueItem[]>;
  for (const t of QUEUE_TABS) items[t] = tabs[t].map(toItem);
  return { enriched, groups, tabs, items, allItems: QUEUE_TABS.flatMap((t) => items[t]) };
}

/** R-2764: rows a queue shows before "Show more" — a tab of 300 rows mounted 300 action menus at once. */
export const QUEUE_PAGE_ROWS = 50;

/** R-2764: the first `limit` rows + how many are left (pure, for tests). */
export function firstRows<T>(rows: readonly T[], limit: number): { shown: readonly T[]; more: number } {
  return rows.length <= limit ? { shown: rows, more: 0 } : { shown: rows.slice(0, limit), more: rows.length - limit };
}
