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
import { isNonRenewing } from "@/lib/subscriptions/non-renewing";
import { renewalStage, type RenewalStage } from "@/lib/renewals/stage";
import { vendorHoldState } from "@/lib/renewals/vendor-hold";
import { canOpenQuotes } from "@/lib/quotes/access";
import { renewalRisk } from "./risk";
import { priorTermDueText } from "./prior-due";
import { withRenewalQuote } from "./open-renewal-quotes";
import { classifyRenewals, type RenewalGroups } from "./classify";
import {
  QUEUE_TABS, queueTabs, renewalRowStatus, renewalAmount, isPaidRenewalQuote,
  type QueueTab, type RowStatus, type RenewalAmount, type RenewalQuoteInfo,
} from "./queue";
import type { RowContact } from "./queue-data";
import { renewalFollowup, renewalDecision, type RenewalFollowup, type RenewalDecision, type RenewalFollowupRow } from "./followup";
import { renewalFrequency, renewalCommitment, type Commitment } from "./frequency";
import type { LastDocs } from "./last-docs";
import { stageInputFor, payHref as stagePayHref } from "./stage-input";

export interface QueueItem {
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
}

export interface QueueBuild {
  enriched: { sub: Subscription; daysUntil: number }[];
  groups: RenewalGroups<{ sub: Subscription; daysUntil: number }>;
  tabs: Record<QueueTab, { sub: Subscription; daysUntil: number }[]>;
  items: Record<QueueTab, QueueItem[]>;
  allItems: QueueItem[];
  atRiskIds: Set<string>;
}

export function buildQueueItems(f: QueueBuildInput): QueueBuild {
  const { today, todayIst } = f;
  const enriched = f.subs
    .filter(onRenewalsPage)
    .map((s) => ({ sub: withRenewalQuote(s, f.openRenewalMap), daysUntil: daysUntilRenewal(s.renewal_date!, today) }));
  const quoteOf = (sub: Subscription) => f.quoteInfo?.get(sub.renewal_quote_id ?? "");
  const paid = (r: { sub: Subscription }) => isPaidRenewalQuote(r.sub, quoteOf(r.sub));
  const groups = classifyRenewals(enriched, (r) => renewalRisk(r.sub).level === "high", today, paid);
  const tabs     = queueTabs(groups);
  const atRiskIds = new Set(groups.atRisk.map((r) => r.sub.id));
  const canQuotes = canOpenQuotes(f.role ?? undefined);

  const toItem = (r: { sub: Subscription; daysUntil: number }): QueueItem => {
    const risk = renewalRisk(r.sub);
    const docs = f.docs?.get(r.sub.id);
    /* R-2728: a renewal quote / part bill with the customer, unpaid → "Renewal quote sent" (stays listed). */
    const status = renewalRowStatus(r.sub, r.daysUntil, { tenantGraceDays: f.graceDays, today, renewalPaid: paid(r), quoteSent: docs?.sent ?? null });
    /* R-2404: the renewal's follow-up state + where the decision stands. */
    const customerOwnerId = r.sub.customer_id ? f.fuData?.ownerByCustomer.get(r.sub.customer_id) ?? null : null;
    const followup = renewalFollowup(r.sub.id, f.fuData?.rows ?? [], { customerOwnerId, today: todayIst, paid: status.key === "renewed" });
    const linkedQuote = quoteOf(r.sub);
    /* R-2758 (R-2738): ONE stage per row — only once the documents are read (no flip after load),
       only this renewal's quote / invoice (stage-input.ts). */
    const input = stageInputFor({
      sub: r.sub, todayIst, docs, docsLoading: f.docsLoading,
      linkedStatus: r.sub.renewal_quote_id ? f.quoteStatusMap.get(r.sub.renewal_quote_id) ?? null : null,
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
      payHref: stage ? stagePayHref(stage, docs, canQuotes) : null,
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
      amount: renewalAmount(r.sub, quoteOf(r.sub)),
      frequency: renewalFrequency(r.sub),
      commitment: renewalCommitment(r.sub),
      docs,
      contact: r.sub.customer_id ? f.contacts?.get(r.sub.customer_id) : undefined,
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
  return { enriched, groups, tabs, items, allItems: QUEUE_TABS.flatMap((t) => items[t]), atRiskIds };
}

/** R-2764: rows a queue shows before "Show more" — a tab of 300 rows mounted 300 action menus at once. */
export const QUEUE_PAGE_ROWS = 50;

/** R-2764: the first `limit` rows + how many are left (pure, for tests). */
export function firstRows<T>(rows: readonly T[], limit: number): { shown: readonly T[]; more: number } {
  return rows.length <= limit ? { shown: rows, more: 0 } : { shown: rows.slice(0, limit), more: rows.length - limit };
}
