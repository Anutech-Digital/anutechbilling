/**
 * R-2338 (1 Nov 2026, owner + CA): "Remember for this vendor" outside Reconcile (Expenses) — saves
 * ONLY the vendor's default TDS section, and only when the owner ticked it. Never called by
 * itself: the app does not set a section the owner did not choose. Reconcile saves it inside its
 * own transaction instead (reconcile_bank_debit_to_vendor, remember_tds_section).
 * A plain function (not a hook) so the expense dialog stays usable without a query client.
 * Returns null when saved, else the error in words.
 */
import { createClient } from "@/lib/supabase/client";

export async function saveVendorTdsSection(vendorId: string, section: string): Promise<string | null> {
  const sec = section.trim().toUpperCase();
  if (!vendorId || !sec) return null;
  const patch = { default_tds_section: sec } as Record<string, unknown>;
  const { error } = await createClient().from("vendors").update(patch as never).eq("id", vendorId);
  return error ? error.message : null;
}
