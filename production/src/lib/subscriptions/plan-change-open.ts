/**
 * R-2605 (8 Nov 2026, R-2589 follow-ups; money rule C3) — "a plan-change quote is open".
 *
 * A plan-change quote (Change plan, R-2227) is linked to its subscription through renewal_quote_id,
 * was priced on the seats, monthly amount and plan the subscription has now, and sets its own when
 * paid. While it is OPEN, nothing else may change them: a seat cut would be credited twice (R-2589),
 * Add seats / Correct details would be billed or recorded and then overwritten by that payment.
 *
 * Open = a plan-change quote that is not closed: status 'rejected' (Cancel quote, R-2519 — which now
 * also unlinks it) or 'expired' by date does not block any more. Expired because it was combined into
 * another quote (superseded_by, R-1527) still blocks: the plan change lives on there. The SAME rule as
 * public.r2605_open_plan_change_quote (migration 20261108181100_r2605_plan_change_freeze), which
 * reduce_subscription_seats and the subscriptions_r2605_plan_change_freeze trigger use under the row lock.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPlanChangeQuote } from "./change-plan";

export function isOpenPlanChangeQuote(q: {
  extension_months?: number | null; line_items?: unknown; status?: string | null; superseded_by?: string | null;
}): boolean {
  if (!isPlanChangeQuote(q)) return false;
  if (q.status === "rejected") return false;
  return !(q.status === "expired" && !q.superseded_by);
}

/** The id of the open plan-change quote linked to this subscription, or null. */
export async function loadOpenPlanChangeQuoteId(
  supabase: SupabaseClient | { from: SupabaseClient["from"] },
  sub: { tenant_id: string; renewal_quote_id?: string | null },
): Promise<string | null> {
  if (!sub.renewal_quote_id) return null;
  const { data } = await (supabase as SupabaseClient)
    .from("quotes")
    .select("id, extension_months, line_items, status, superseded_by")
    .eq("id", sub.renewal_quote_id)
    .eq("tenant_id", sub.tenant_id)
    .maybeSingle();
  const q = data as { id: string; extension_months: number | null; line_items: unknown; status: string | null; superseded_by: string | null } | null;
  return q && isOpenPlanChangeQuote(q) ? q.id : null;
}

/** Same words as the subscriptions_r2605_plan_change_freeze trigger (Add seats, Correct details). */
export function planChangeFreezeMessage(quoteId: string): string {
  return `Plan change quote ${quoteId} is open for this subscription — it was priced on today's seats, monthly amount and plan. Delete that quote (or record its payment) first, then change the seats or details.`;
}
