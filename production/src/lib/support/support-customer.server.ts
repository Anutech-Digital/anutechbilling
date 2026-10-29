/**
 * R-2102 — the support-desk customer behind a /buy/support link, read on the server.
 *
 * The desk's Upgrade button opens /buy/support?email=…&billing_customer_id=…. Both the page
 * (to show the current plan and offer only higher ones) and POST /api/public/checkout/support
 * (to attach the order) use the SAME rule: the customer is used only when it is the selling
 * company's, active, AND has this email. A mismatch looks exactly like "no customer" — the
 * page never tells a visitor anything about someone else's id.
 *
 * R-2108: "this email" is the one the desk was sent — customer_primary_email (contact_email,
 * else the primary contact's) — and the page also gets what the form can fill in.
 */
import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import { primaryContactFor } from "@/lib/contacts/primary";
import { supportBuyPrefill, type PrefillCustomerRow, type SupportBuyPrefill } from "./desk-prefill";
import { currentSupportPlan, isUuid, sameEmail, type SupportSubRow } from "./public-checkout";
import type { SupportTierId } from "./tiers";

type Admin = ReturnType<typeof createAdminClient>;
type CustomerRow = PrefillCustomerRow & { id: string; contact_email: string | null; is_active: boolean };
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/** The customer's one email (R-2108) — SQL customer_primary_email, service_role only. */
async function primaryEmail(admin: Admin, customerId: string): Promise<string | null> {
  const call = admin.rpc as unknown as Rpc;
  const { data, error } = await call.call(admin, "customer_primary_email", { p_customer_id: customerId });
  if (error) {
    console.error("[support-customer] customer_primary_email failed:", error.message);
    return null;
  }
  return typeof data === "string" ? data : null;
}

/** DSP's customer, only when it is this company's, active, and the same email. Else null. */
export async function attachableCustomer(admin: Admin, tenantId: string, billingCustomerId: string, email: string) {
  if (!billingCustomerId || !email) return null;
  const q = admin.from("customers")
    .select("id, name, contact_email, is_active, contact_name, contact_mobile, contact_phone, state, state_code, gstin")
    .eq("tenant_id", tenantId);
  /* The id is [A-Za-z0-9-] only (schema / parseSupportBuyParams), so it is safe inside the or() filter. */
  const { data, error } = await (isUuid(billingCustomerId)
    ? q.or(`id.eq.${billingCustomerId},customer_number.eq.${billingCustomerId}`)
    : q.eq("customer_number", billingCustomerId)
  ).limit(2);
  if (error) {
    console.error("[support-customer] customer lookup failed:", error.message);
    return null;
  }
  for (const c of ((data ?? []) as CustomerRow[]).filter((r) => r.is_active)) {
    if (sameEmail(c.contact_email, email) || sameEmail(await primaryEmail(admin, c.id), email)) return c;
  }
  return null;
}

/** The support plan the desk's customer is on now and what the form can fill in (R-2108),
 *  or null when the link names no customer we can attach. */
export async function deskCustomerPlan(
  tenantId: string, billingCustomerId: string, email: string,
): Promise<{ tier: SupportTierId; paidUntil: string | null; prefill: SupportBuyPrefill } | null> {
  if (!tenantId) return null;
  const admin = createAdminClient();
  const customer = await attachableCustomer(admin, tenantId, billingCustomerId, email);
  if (!customer) return null;
  const [{ data, error }, primary] = await Promise.all([
    admin
      .from("subscriptions")
      .select("item_id, plan, status, renewal_date")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customer.id)
      .eq("vendor", "support"),
    primaryContactFor(admin, customer.id).catch(() => null),
  ]);
  if (error) {
    console.error("[support-customer] subscriptions lookup failed:", error.message);
    return null;
  }
  return { ...currentSupportPlan((data ?? []) as SupportSubRow[]), prefill: supportBuyPrefill(customer, primary) };
}

/** The support desk's address (DSP_SUPPORT_URL), without a trailing slash; null when unset. */
export function supportDeskUrl(): string | null {
  return (process.env.DSP_SUPPORT_URL ?? "").trim().replace(/\/+$/, "") || null;
}
