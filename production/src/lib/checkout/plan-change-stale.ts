/**
 * R-2596: is a PLAN-CHANGE quote still payable? record_payment (migration 20261108051500, R-2589 /
 * R-2227) refuses a payment on a plan-change quote once its subscription no longer matches what
 * the quote was priced on. Taking the customer's money online first and refusing it in the webhook
 * leaves captured money unbooked — so the pay start asks the same question before a Razorpay order
 * exists. Same rules as the SQL, in the same order:
 *   - no subscription links the quote (renewal_quote_id)     → link lost (R-2227)
 *   - the line names another subscription                     → R-2227
 *   - the subscription is not active                          → R-2589
 *   - from_seats / from_mrr missing, or seats / ₹/month differ → R-2589
 *   - from_plan stored and the plan differs                   → R-2589
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { isPlanChangeQuote } from "@/lib/subscriptions/change-plan";

export interface PlanChangeSubNow {
  id: string;
  status: string | null;
  seats: number | null;
  mrr: number | null;
  plan: string | null;
}

interface StoredPlanChange {
  subscription_id?: unknown;
  from_seats?: unknown;
  from_mrr?: unknown;
  from_plan?: unknown;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const planText = (v: unknown): string | null => {
  const t = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  return t === "" ? null : t;
};

/** Why this plan-change line can no longer be paid against `sub` (null = it still matches). */
export function planChangeStaleReason(lineItems: unknown, sub: PlanChangeSubNow | null): string | null {
  const first = Array.isArray(lineItems) ? (lineItems[0] as { plan_change?: StoredPlanChange } | undefined) : undefined;
  const pc = first?.plan_change;
  if (!pc || typeof pc !== "object") return null;
  if (!sub) return "link_lost";
  if (String(pc.subscription_id ?? "") !== sub.id) return "other_subscription";
  if (sub.status !== "active") return "not_active";
  const fromSeats = num(pc.from_seats);
  const fromMrr = num(pc.from_mrr);
  if (fromSeats === null || fromMrr === null) return "changed";
  if (fromSeats !== num(sub.seats) || fromMrr !== num(sub.mrr)) return "changed";
  if ("from_plan" in pc && planText(pc.from_plan) !== planText(sub.plan)) return "changed";
  return null;
}

/**
 * The pay-start check: null when the quote is not a plan-change quote or still matches its
 * subscription; otherwise a customer-facing refusal. A failed read → "retry" (no order is made).
 */
export async function planChangePayRefusal(
  admin: ReturnType<typeof createAdminClient>,
  quote: { id: string; tenant_id: string; extension_months?: number | null; line_items: unknown },
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  if (!isPlanChangeQuote(quote)) return null;
  const { data, error } = await admin
    .from("subscriptions")
    .select("id, status, seats, mrr, plan")
    .eq("tenant_id", quote.tenant_id)
    .eq("renewal_quote_id", quote.id)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(`[plan-change-stale] ${quote.id}: subscription read failed: ${error.message}`);
    return { status: 500, body: { error: "Could not start payment. Please retry." } };
  }
  const reason = planChangeStaleReason(quote.line_items, (data as PlanChangeSubNow | null) ?? null);
  if (!reason) return null;
  return {
    status: 409,
    body: {
      error: "This plan-change quote is out of date — the subscription changed after it was made, so it can't be paid.",
      nextStep: "Please ask the reseller for a new quote for the plan change. Nothing has been charged.",
      planChangeStale: reason,
    },
  };
}
