/**
 * WORKSPACE FACTS for AI Help (R-189, 6 Oct 2026).
 *
 * Pardeep: "AI help ko problem solve karne ki power do taki wo problem ko wahi solve kar
 * paye". Most "why is this wrong" questions in this app come down to the company's own setup
 * (its GST state, GSTIN, bank/UPI for payments) or a customer missing a GST state — the
 * same causes R-165..R-176 kept finding. With those facts the AI can name the real cause and
 * offer the fix instead of guessing.
 *
 * Read with the PERSON's client, so RLS limits it to their own company exactly as their
 * screens are. Values that are personal or tax identifiers are given as "set / not set"
 * (the route's rule: GSTIN, PAN, emails and phones never reach the model); only the state
 * code is passed, because that is what decides CGST+SGST vs IGST.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { GST_STATE_BY_CODE } from "@/lib/utils";
import { missingInvoiceState, stateCodeFromGstin } from "@/lib/gst/gstin-state";

export interface HelpFacts {
  text: string;
  /** customers listed as missing a state — the only rows a set_customer_state may touch */
  customerIds: Set<string>;
}

const setOrNot = (v: unknown) => (typeof v === "string" && v.trim() ? "set" : "NOT SET");
const stateLabel = (code: string | null | undefined) =>
  code && GST_STATE_BY_CODE[code] ? `${GST_STATE_BY_CODE[code]} (${code})` : "NOT SET";

export async function helpFacts(client: SupabaseClient<Database>, tenantId: string): Promise<HelpFacts> {
  const lines: string[] = [];
  const customerIds = new Set<string>();

  const { data: t } = await client
    .from("tenants")
    .select("name, gstin, state, state_code, address, pin_code, email, phone, upi_vpa, remit_account_number, remit_ifsc, lut_number, setup_completed_at")
    .eq("id", tenantId)
    .maybeSingle();
  if (t) {
    const fromGstin = stateCodeFromGstin(t.gstin);
    lines.push(
      `Company: ${t.name ?? "—"}`,
      `Company GST state (decides CGST+SGST vs IGST): ${stateLabel(t.state_code)}${!t.state_code && fromGstin ? ` — but the company GSTIN starts with ${fromGstin} (${GST_STATE_BY_CODE[fromGstin] ?? "?"}), so that is probably it` : ""}`,
      `Company GSTIN: ${setOrNot(t.gstin)}${t.gstin && t.state_code && fromGstin && fromGstin !== t.state_code ? ` — its state code ${fromGstin} does NOT match the company state ${t.state_code}` : ""}`,
      `Company address: ${setOrNot(t.address)}, PIN: ${setOrNot(t.pin_code)}, email: ${setOrNot(t.email)}, phone: ${setOrNot(t.phone)}`,
      `Bank account for invoices: ${setOrNot(t.remit_account_number)} (IFSC ${setOrNot(t.remit_ifsc)}), UPI: ${setOrNot(t.upi_vpa)}, LUT (exports): ${setOrNot(t.lut_number)}`,
      `Company setup finished: ${t.setup_completed_at ? "yes" : "NO"} — company details are edited at /settings?tab=company`,
    );
  }

  const { data: custs } = await client
    .from("customers")
    .select("id, name, state_code, country")
    .order("name", { ascending: true })
    .limit(2000);
  const missing = (custs ?? []).filter((c) => missingInvoiceState(c));
  lines.push(
    `Customers: ${(custs ?? []).length}${(custs ?? []).length === 2000 ? "+" : ""}; missing a GST state (invoice cannot be made for them): ${missing.length}` +
      (missing.length ? ` — the Customers page has a "State missing" view` : ""),
  );
  for (const c of missing.slice(0, 10)) {
    customerIds.add(c.id);
    lines.push(`  - ${c.name} (id ${c.id}) — edit at /customers/${c.id}/edit`);
  }

  return { text: lines.join("\n"), customerIds };
}
