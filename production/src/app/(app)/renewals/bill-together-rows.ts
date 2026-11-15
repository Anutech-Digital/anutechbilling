/**
 * R-2808 — a Renewals row as suggestBillTogether / canOfferBillTogether read it (lib/renewals/bill-together.ts),
 * and the suggested groups the queue shows (ticked by default) with each row's "Bills with …" hint.
 */
import { billsWithText, suggestBillTogether, type BillTogetherGroup, type BillTogetherRow } from "@/lib/renewals/bill-together";
import { BILL_PART_WINDOW_DAYS } from "@/lib/renewals/stage";
import { firstReminderDaysOut } from "@/lib/renewals/cadence";
import { subscriptionDomain } from "./row-cells";
import type { QueueItem } from "./queue-items";

type Row = Pick<QueueItem, "sub" | "stage" | "docs">;

/**
 * A part is to bill NOW: "Part not billed" (part-due), or "due" with the next part inside the Bill next
 * part window (the row's own button, stage.ts) — never a part months away (code review R-2808).
 */
/**
 * R-2849: how far ahead a yearly row is offered for one renewal quote — 30 days BEFORE its first reminder (cadence.ts,
 * when the renewals cron makes and sends each subscription's own renewal quote): once a single quote exists the row is
 * no longer offered (cancel it first), so the together quote has to be possible before that (code review R-2849).
 */
export const YEARLY_TOGETHER_LEAD_DAYS = 30;

function billableNow(stage: Row["stage"], sub: Row["sub"]): boolean {
  if (!stage) return false;
  if (!stage.split) {
    /* R-2849: a one-year yearly row (create_renewal_quote_together's rule — never a 24/36-month term) whose renewal is
       due with no renewal quote made yet (not even a draft), from 30 days before its first reminder — or past it. */
    const oneYear = sub.billing_cycle === "yearly" && (sub.term_months ?? 12) === 12;
    return oneYear && stage.key === "due" && !stage.quoteId && stage.renewalDays != null
      && stage.renewalDays <= firstReminderDaysOut(sub.term_months) + YEARLY_TOGETHER_LEAD_DAYS;
  }
  if (stage.key === "part-due") return true;
  return stage.key === "due" && stage.partDays != null && stage.partDays <= BILL_PART_WINDOW_DAYS;
}

export function togetherRowOf(item: Row): BillTogetherRow {
  const { sub, stage, docs } = item;
  return {
    id: sub.id,
    customerId: sub.customer_id ?? null,
    customerName: sub.customer_name ?? "",
    plan: sub.plan ?? null,
    seats: sub.seats ?? null,
    domain: subscriptionDomain(sub),
    split: !!stage?.split,
    billable: billableNow(stage, sub),
    billingCycle: (sub.billing_cycle as string | null | undefined) ?? null,
    nextPartStart: sub.renewal_date ?? null,
    lastQuoteId: docs?.quote?.id ?? null,
    lastInvoiceId: docs?.invoice?.id ?? null,
  };
}

export interface TogetherIndex {
  groups: BillTogetherGroup[];
  /** Row id → its group and hint ("Bills with Business Starter"). */
  hintOf: Map<string, { group: BillTogetherGroup; text: string }>;
  /** Row id → plan + seats (the group box's labels). */
  subOf: Map<string, { id: string; plan: string | null; seats: number | null }>;
}

/** Built once per data change (the page memoises it on the queue items — R-2764: no per-keystroke work). */
export function togetherIndex(all: readonly Row[]): TogetherIndex {
  const groups = suggestBillTogether(all.map(togetherRowOf));
  const subOf = new Map<string, { id: string; plan: string | null; seats: number | null }>();
  for (const g of groups) for (const id of g.subIds) {
    const s = all.find((i) => i.sub.id === id)?.sub;
    if (s) subOf.set(id, { id, plan: s.plan ?? null, seats: s.seats ?? null });
  }
  const hintOf = new Map<string, { group: BillTogetherGroup; text: string }>();
  for (const g of groups) for (const id of g.subIds) hintOf.set(id, { group: g, text: billsWithText(g, id, (x) => subOf.get(x)?.plan ?? null) });
  return { groups, hintOf, subOf };
}

/** The groups with a row on screen (the tab / tile shown). */
export function groupsShown(index: TogetherIndex, shownIds: ReadonlySet<string>): BillTogetherGroup[] {
  return index.groups.filter((g) => g.subIds.some((id) => shownIds.has(id)));
}
