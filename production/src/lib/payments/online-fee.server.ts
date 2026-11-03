/**
 * R-2416 — on a captured online (Razorpay) payment, record WHO bore the online fee under the
 * policy in force (company setting → customer "We absorb" → bill waiver; lib/payments/online-fee.ts).
 *
 * fee_charged is 0: nothing is added to the order amount yet (R-2417 does that), so even when the
 * policy says "customer pays" the customer paid no fee on THIS payment. fee_bearer records the
 * policy's answer so R-2418's report can tell "absorbed by choice" from "should have been charged".
 *
 * Written once: only a row whose fee_bearer is still NULL is touched, so a retry, the later
 * payment.captured, or a changed setting never rewrites the decision taken at capture.
 * Best-effort, like recordGatewayFee: the payment is committed either way; before the migration
 * the columns are missing and this is a quiet no-op.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { createAdminClient } from "@/lib/supabase/server";
import { logDbError } from "@/lib/errors/db-error";
import {
  BILL_ONLINE_FEE_COLUMNS,
  CUSTOMER_ONLINE_FEE_COLUMNS,
  TENANT_ONLINE_FEE_COLUMNS,
  isOnlineFeeColumnMissing,
  onlineFeeFor,
  parseOnlineFeeCustomer,
  parseOnlineFeeSettings,
  type OnlineFeeResult,
} from "./online-fee";

type Row = Record<string, unknown>;
type Res = { data: Row | null; error: { code?: string; message?: string } | null };

/** The policy's answer for one quote (its invoice's waiver counts too). null = columns missing / quote not found. */
export async function onlineFeeForQuote(
  admin: ReturnType<typeof createAdminClient>,
  tenantId: string,
  quoteId: string,
): Promise<OnlineFeeResult | null> {
  /* The online_fee_* columns are newer than the generated types. */
  const db = admin as unknown as SupabaseClient;
  const [tenantRes, quoteRes] = (await Promise.all([
    db.from("tenants").select(TENANT_ONLINE_FEE_COLUMNS).eq("id", tenantId).maybeSingle(),
    db.from("quotes").select(`amount, customer_id, invoice_id, ${BILL_ONLINE_FEE_COLUMNS}`)
      .eq("id", quoteId).eq("tenant_id", tenantId).maybeSingle(),
  ])) as [Res, Res];
  if (isOnlineFeeColumnMissing(tenantRes.error) || isOnlineFeeColumnMissing(quoteRes.error)) return null;
  if (tenantRes.error || quoteRes.error || !quoteRes.data) {
    if (tenantRes.error) logDbError("online-fee:tenant", tenantRes.error);
    if (quoteRes.error) logDbError("online-fee:quote", quoteRes.error);
    return null;
  }
  const quote = quoteRes.data;

  let waived = quote.online_fee_waived === true;
  let waiveReason = typeof quote.online_fee_waive_reason === "string" ? quote.online_fee_waive_reason : null;
  if (!waived && typeof quote.invoice_id === "string" && quote.invoice_id) {
    const inv = (await db.from("invoices").select(BILL_ONLINE_FEE_COLUMNS)
      .eq("id", quote.invoice_id).eq("tenant_id", tenantId).maybeSingle()) as Res;
    if (inv.data?.online_fee_waived === true) {
      waived = true;
      waiveReason = typeof inv.data.online_fee_waive_reason === "string" ? inv.data.online_fee_waive_reason : null;
    }
  }

  let customer: Row | null = null;
  if (typeof quote.customer_id === "string" && quote.customer_id) {
    const c = (await db.from("customers").select(CUSTOMER_ONLINE_FEE_COLUMNS)
      .eq("id", quote.customer_id).eq("tenant_id", tenantId).maybeSingle()) as Res;
    customer = c.data;
  }

  return onlineFeeFor(
    { billTotal: Number(quote.amount) || 0, waived, waiveReason },
    parseOnlineFeeCustomer(customer),
    parseOnlineFeeSettings(tenantRes.data),
  );
}

/** Stamp fee_bearer (and fee_charged = 0) on the captured payment row(s) of this reference. */
export async function recordFeeBearer(
  admin: ReturnType<typeof createAdminClient>,
  tenantId: string,
  quoteId: string,
  reference: string,
): Promise<void> {
  try {
    const policy = await onlineFeeForQuote(admin, tenantId, quoteId);
    if (!policy) return;
    const db = admin as unknown as SupabaseClient;
    const { error } = await db
      .from("payments")
      .update({ fee_bearer: policy.bearer, fee_charged: 0 })
      .eq("tenant_id", tenantId)
      .eq("quote_id", quoteId)
      .eq("reference", reference)
      .is("fee_bearer", null);
    if (error && !isOnlineFeeColumnMissing(error)) logDbError("online-fee:fee_bearer", error);
  } catch (err) {
    console.error("[online-fee] fee_bearer not recorded:", (err as Error).message);
  }
}
