/**
 * R-1532 — read a tenant's GST registration on the SERVER (renewal / auto quotes, quote PDF,
 * accept page, quote email). Read on its own, like readTenantUdyam: before R-1529's migration
 * the column does not exist and a combined tenant select would fail — here that, or any other
 * error, answers null ("not chosen" = registered behaviour), never a broken document.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { toGstRegistration, type GstRegistration } from "./gst-registration";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any, any, any>;

export async function readTenantGstRegistration(client: AnyClient, tenantId: string | null | undefined): Promise<GstRegistration | null> {
  if (!tenantId) return null;
  try {
    const { data, error } = await (client as SupabaseClient)
      .from("tenants")
      .select("gst_registration")
      .eq("id", tenantId)
      .maybeSingle();
    if (error) return null;
    return toGstRegistration((data as { gst_registration?: unknown } | null)?.gst_registration);
  } catch {
    return null;
  }
}
