/**
 * POST /api/payments/gateway-fees   (signed in; owner / manager / billing / accountant)
 *
 * R-045 slice 2 — "Book Razorpay fees": books the Razorpay fee of every payment that has one
 * (payments.gateway_fee) but no fee expense yet. The webhook books new captures by itself;
 * this catches payments captured before that, and any the webhook could not book.
 *
 * Runs on the signed-in user's own client — RLS keeps every read and write inside their
 * tenant; no service role here. Idempotent: the expense id is derived from the payment id
 * (lib/razorpay/fee-expense), so pressing it twice books nothing new.
 */
import { withRoute, dbFail } from "@/lib/api/with-route";
import { bookGatewayFeeExpense, type FeeBookingResult } from "@/lib/razorpay/fee-expense.server";
import { feeExpenseId } from "@/lib/razorpay/fee-expense";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One press books at most this many — a long backlog takes a second press, never a timeout. */
const MAX_PER_CALL = 200;

export const POST = withRoute(
  {
    route: "api/payments/gateway-fees",
    roles: ["owner", "manager", "billing", "accountant"],
    roleHint: "Only Owner, Manager, Billing or Accountant can book Razorpay fees. Ask one of them.",
  },
  async ({ supabase, tenantId }) => {
    const { data: pays, error } = await supabase
      .from("payments")
      .select("id")
      .eq("tenant_id", tenantId)
      .gt("gateway_fee", 0)
      .order("received_at", { ascending: true })
      .limit(5000);
    dbFail(error, "Could not read payments. Refresh and try again.");

    const ids = ((pays ?? []) as { id: string }[]).map((p) => p.id);
    const booked = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200).map(feeExpenseId);
      const { data: have, error: exErr } = await supabase.from("expenses").select("id").eq("tenant_id", tenantId).in("id", chunk);
      dbFail(exErr, "Could not read expenses. Refresh and try again.");
      for (const e of (have ?? []) as { id: string }[]) booked.add(e.id);
    }
    const todo = ids.filter((id) => !booked.has(feeExpenseId(id)));

    const counts: Record<FeeBookingResult, number> = { booked: 0, already: 0, no_fee: 0, not_found: 0, error: 0 };
    for (const id of todo.slice(0, MAX_PER_CALL)) {
      counts[await bookGatewayFeeExpense(supabase, tenantId, id)] += 1;
    }
    return {
      booked: counts.booked,
      failed: counts.error,
      remaining: Math.max(0, todo.length - MAX_PER_CALL),
      alreadyBooked: booked.size + counts.already,
    };
  },
);
