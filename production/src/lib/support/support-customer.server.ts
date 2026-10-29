/**
 * R-2102 — the support-desk customer behind a /buy/support link, read on the server.
 *
 * The desk's Upgrade button opens /buy/support?email=…&billing_customer_id=…. Both the page
 * (to show the current plan and offer only higher ones) and POST /api/public/checkout/support
 * (to attach the order) use the SAME rule: the customer is used only when it is the selling
 * company's, active, AND has this email. A mismatch looks exactly like "no customer" — the
 * page never tells a visitor anything about someone else's id.
 */
import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import { currentSupportPlan, isUuid, sameEmail, type SupportSubRow } from "./public-checkout";
import type { SupportTierId } from "./tiers";

type Admin = ReturnType<typeof createAdminClient>;

/** DSP's customer, only when it is this company's, active, and the same email. Else null. */
export async function attachableCustomer(admin: Admin, tenantId: string, billingCustomerId: string, email: string) {
  if (!billingCustomerId || !email) return null;
  const q = admin.from("customers").select("id, name, contact_email, is_active").eq("tenant_id", tenantId);
  /* The id is [A-Za-z0-9-] only (schema / parseSupportBuyParams), so it is safe inside the or() filter. */
  const { data, error } = await (isUuid(billingCustomerId)
    ? q.or(`id.eq.${billingCustomerId},customer_number.eq.${billingCustomerId}`)
    : q.eq("customer_number", billingCustomerId)
  ).limit(2);
  if (error) {
    console.error("[support-customer] customer lookup failed:", error.message);
    return null;
  }
  const rows = (data ?? []) as { id: string; name: string | null; contact_email: string | null; is_active: boolean }[];
  return rows.find((c) => c.is_active && sameEmail(c.contact_email, email)) ?? null;
}

/** The support plan the desk's customer is on now, or null when the link names no customer we can attach. */
export async function deskCustomerPlan(
  tenantId: string, billingCustomerId: string, email: string,
): Promise<{ tier: SupportTierId; paidUntil: string | null } | null> {
  if (!tenantId) return null;
  const admin = createAdminClient();
  const customer = await attachableCustomer(admin, tenantId, billingCustomerId, email);
  if (!customer) return null;
  const { data, error } = await admin
    .from("subscriptions")
    .select("item_id, plan, status, renewal_date")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customer.id)
    .eq("vendor", "support");
  if (error) {
    console.error("[support-customer] subscriptions lookup failed:", error.message);
    return null;
  }
  return currentSupportPlan((data ?? []) as SupportSubRow[]);
}

/** The support desk's address (DSP_SUPPORT_URL), without a trailing slash; null when unset. */
export function supportDeskUrl(): string | null {
  return (process.env.DSP_SUPPORT_URL ?? "").trim().replace(/\/+$/, "") || null;
}
