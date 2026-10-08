/**
 * R-368 — the company's OWN Udyam (MSME) registration number.
 *
 * Lives on tenants.udyam_number (migration 20261007123000_credit_annual_block_udyam.sql),
 * set in Settings → Company → Compliance profile, printed on quote and invoice PDFs when set:
 * "MSME Udyam: UDYAM-DL-01-0012345". A buyer who sees it knows MSMED Act s.15/16 apply
 * (45-day payment, interest on delay) and, if they claim business deductions, s.43B(h).
 *
 * No client imports: the PDF routes (server) and the settings card (client) both use this.
 * A "column does not exist" answer is not an error — before the migration it reads as "not
 * set", so every PDF keeps rendering exactly as before.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { UDYAM_RE } from "@/lib/accounting/msme";

export { UDYAM_RE };

/** Upper-case, trimmed; empty → null. */
export function normalizeUdyam(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().toUpperCase();
  return s ? s : null;
}

/** Empty is fine (not registered / not filled); anything else must match the Udyam format. */
export function udyamInputOk(v: string | null | undefined): boolean {
  const s = normalizeUdyam(v);
  return s === null || UDYAM_RE.test(s);
}

/** The PDF line, or null when there is no valid number to print. */
export function udyamPdfLine(v: string | null | undefined): string | null {
  const s = normalizeUdyam(v);
  return s && UDYAM_RE.test(s) ? `MSME Udyam: ${s}` : null;
}

interface PgErr { code?: string | null; message?: string | null }

export function isMissingUdyamColumn(err: PgErr | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  return /udyam_number/.test(err.message ?? "") && /(does not exist|could not find)/i.test(err.message ?? "");
}

/**
 * The tenant's Udyam number, or null (not set, not migrated, or unreadable). Never throws:
 * a PDF must not fail over an optional line.
 */
export async function readTenantUdyam(client: SupabaseClient, tenantId: string): Promise<string | null> {
  try {
    const { data, error } = await client.from("tenants").select("udyam_number").eq("id", tenantId).maybeSingle();
    if (error) return null;
    const v = (data as { udyam_number?: unknown } | null)?.udyam_number;
    return typeof v === "string" ? normalizeUdyam(v) : null;
  } catch {
    return null;
  }
}
