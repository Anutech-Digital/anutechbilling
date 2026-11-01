/**
 * R-2229 (Zoho Billing audit A5, 1 Nov 2026) — ONE rule for "what does this subscription add to MRR".
 *
 * SaaS Metrics showed two MRR figures on one page (card ₹2,04,322, waterfall ending ₹2,05,012):
 * the card summed `status = active`, the waterfall summed every row not cancelled/expired, so a
 * PAUSED subscription counted in one and not the other. Both also counted "T-M5 Email migration
 * (one-time)" — a one-time line filed as a subscription before R-1688 — as ₹417 of monthly
 * recurring revenue it will never bring in again.
 *
 * Every MRR total (Subscriptions Insights strip and Active MRR tile, SaaS Metrics card, vendor and
 * tier split, waterfall, dashboard MRR tile, company section, v1 analytics, the monthly snapshot)
 * now reads these two functions:
 *
 *   recurringMrr(sub) — the stored `mrr` when the subscription is RECURRING, else 0. Status-blind,
 *                       so the waterfall can still weigh a churned row.
 *   mrrOf(sub)        — what it adds to MRR today: recurringMrr, and only while status = active.
 *
 * Not recurring = no recurring term (term_months missing or ≤ 0) or a one-time charge by name
 * ("one-time" / "one time" / "onetime" in the plan, the R-1668/R-1688 marker the builder writes
 * into such lines). Reporting only: the stored `subscriptions.mrr`, prices, invoices and payments
 * are not touched.
 */

export interface MrrSubLike {
  status: string;
  mrr: number | null;
  /** Absent when the caller did not select it — then the term says nothing either way. */
  term_months?: number | null;
  /** Absent when the caller did not select it — then the name says nothing either way. */
  plan?: string | null;
}

const ONE_TIME_NAME = /\bone[\s-]?time\b|\bonetime\b/i;

/** True when the subscription is a recurring charge — the only kind MRR may count. */
export function isRecurringSub(s: Pick<MrrSubLike, "term_months" | "plan">): boolean {
  if (s.term_months !== undefined && !(Number(s.term_months) > 0)) return false;
  if (s.plan != null && ONE_TIME_NAME.test(s.plan)) return false;
  return true;
}

/** Monthly recurring amount, whole ₹, ignoring status. 0 for a one-time or no-term row. */
export function recurringMrr(s: MrrSubLike): number {
  if (!isRecurringSub(s)) return 0;
  const m = Number(s.mrr ?? 0);
  return Number.isFinite(m) ? Math.max(0, Math.round(m)) : 0;
}

/** What this subscription adds to MRR today: recurring, and status active. */
export function mrrOf(s: MrrSubLike): number {
  return s.status === "active" ? recurringMrr(s) : 0;
}

/** MRR of a list — the one sum every MRR figure uses. */
export function totalMrr(subs: readonly MrrSubLike[]): number {
  let t = 0;
  for (const s of subs) t += mrrOf(s);
  return t;
}
