/**
 * GET /api/v1/analytics/mrr — MRR / ARR and margin by product line for the signed-in
 * company. Session + RLS scope it to the caller's tenant.
 *
 * Fixed 2 Oct 2026: the first version selected columns that do not exist and returned the
 * raw Postgres message to the browser. The rule lives in lib/subscriptions/mrr-analytics.ts.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeMrrAnalytics, type SubscriptionRow } from "@/lib/subscriptions/mrr-analytics";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  const { data, error } = await supabase
    .from("subscriptions")
    .select("id, status, vendor, seats, mrr, plan, term_months, vendor_cost_per_seat_month")
    .eq("status", "active");

  if (error) {
    /* Logged, not echoed: the database's own wording is not for the browser. */
    console.error("[api/v1/analytics/mrr]", error.message);
    return NextResponse.json({ error: "Could not read subscriptions. Try again in a moment." }, { status: 500 });
  }

  return NextResponse.json({ analytics: computeMrrAnalytics((data ?? []) as SubscriptionRow[]) });
}
