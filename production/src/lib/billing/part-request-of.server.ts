/**
 * R-2044 — which part of a subscription billed in parts a quote is the payment request for
 * (quotes.subscription_billing_id, migration 20261028025317). Its own file so a test that mocks
 * sync-instalments.server still reads it for real.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type Admin = SupabaseClient<Database>;
/** R-2044: the part (subscription_billings row) a quote is the payment request for, or null. */
export async function partRequestOf(
  supabase: Admin,
  quoteId: string,
  tenantId: string,
): Promise<{ billingId: string; subscriptionId: string; periodIndex: number } | null> {
  const { data: q } = await supabase
    .from("quotes").select("subscription_billing_id").eq("id", quoteId).eq("tenant_id", tenantId).maybeSingle();
  const billingId = (q as { subscription_billing_id?: string | null } | null)?.subscription_billing_id ?? null;
  if (!billingId) return null;
  const { data: b } = await supabase
    .from("subscription_billings").select("subscription_id, period_index").eq("id", billingId).maybeSingle();
  if (!b) return null;
  return { billingId, subscriptionId: b.subscription_id, periodIndex: b.period_index };
}
