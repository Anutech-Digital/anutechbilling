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
function billableNow(stage: Row["stage"], termMonths: number | null | undefined): boolean {
  if (!stage) return false;
  if (!stage.split) {
    /* R-2849: a yearly row whose renewal is due (no renewal quote made yet — not even a draft) and inside its first
       reminder window (the renewal quote's own time, cadence.ts) — or past it. Never a renewal months away. */
    return stage.key === "due" && !stage.quoteId && stage.renewalDays != null && stage.renewalDays <= firstReminderDaysOut(termMonths);
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
    billable: billableNow(stage, sub.term_months),
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
