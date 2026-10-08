/**
 * R-045 slice 2 — write the Razorpay-fee expense for one payment, at most once.
 *
 * Called from two places:
 *   - the Razorpay webhook, right after slice 1 saved gateway_fee on the payment (service
 *     role, tenant pinned by the payment row it just wrote);
 *   - POST /api/payments/gateway-fees (the "Book Razorpay fees" button) for payments
 *     captured before this existed — with the signed-in user's own client, so RLS keeps it
 *     inside their tenant.
 *
 * Idempotent by the primary key: the expense id is derived from the payment id
 * (feeExpenseId), and the insert is `on conflict (id) do nothing`. Two webhook deliveries
 * racing each other, or the button pressed twice, write one row.
 */
import type { createAdminClient, createClient } from "@/lib/supabase/server";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { feeExpenseId, gatewayFeeExpense, type FeeExpenseVendor } from "./fee-expense";

type Db = ReturnType<typeof createAdminClient> | ReturnType<typeof createClient>;

export type FeeBookingResult = "booked" | "already" | "no_fee" | "not_found" | "error";

/** The tenant's Razorpay vendor, if they added one — preferring one that carries a GSTIN. */
async function razorpayVendor(db: Db, tenantId: string): Promise<FeeExpenseVendor | null> {
  const { data } = await db
    .from("vendors")
    .select("id, gstin")
    .eq("tenant_id", tenantId)
    .ilike("name", "%razorpay%")
    .order("created_at", { ascending: true })
    .limit(5);
  const rows = (data ?? []) as FeeExpenseVendor[];
  return rows.find((v) => (v.gstin ?? "").trim()) ?? rows[0] ?? null;
}

async function ownStateCode(db: Db, tenantId: string): Promise<string | null> {
  const { data } = await db.from("tenants").select("state_code, gstin").eq("id", tenantId).maybeSingle();
  const row = data as { state_code: string | null; gstin: string | null } | null;
  if (row?.state_code?.trim()) return row.state_code.trim();
  return stateCodeFromGstin(row?.gstin ?? null);
}

export async function bookGatewayFeeExpense(db: Db, tenantId: string, paymentId: string): Promise<FeeBookingResult> {
  const { data: pay, error: payErr } = await db
    .from("payments")
    .select("id, tenant_id, quote_id, amount, reference, received_at, gateway_fee, gateway_fee_gst")
    .eq("tenant_id", tenantId)
    .eq("id", paymentId)
    .maybeSingle();
  if (payErr) {
    console.error("[razorpay/fee-expense] payment read failed:", payErr.code ?? "", payErr.message);
    return "error";
  }
  if (!pay) return "not_found";

  const [vendor, state] = await Promise.all([razorpayVendor(db, tenantId), ownStateCode(db, tenantId)]);
  const row = gatewayFeeExpense(pay, vendor, state);
  if (!row) return "no_fee";

  const { data: inserted, error } = await db
    .from("expenses")
    .upsert(row, { onConflict: "id", ignoreDuplicates: true })
    .select("id");
  if (error) {
    console.error("[razorpay/fee-expense] insert failed for", feeExpenseId(paymentId), error.code ?? "", error.message);
    return "error";
  }
  return inserted && inserted.length ? "booked" : "already";
}
