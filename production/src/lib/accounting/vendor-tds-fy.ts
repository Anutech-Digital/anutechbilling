/**
 * R-2335: a vendor's TDS year so far — the value before GST of this FY's earlier payments that
 * count toward the section's yearly limit (tdsDecision's fyBaseSoFar / fyBaseWithoutTds).
 *
 *   - expense bills: amount − GST (as before, useVendorTdsThisFy);
 *   - COGS bills (vendor_bills) PAID at least in part this FY: their value before GST (in rupees).
 *     Before R-2335 these were left out, so a COGS vendor showed "within the limit" too often.
 *     An unpaid COGS bill is not counted: Reconcile and Bills → Pay add the bill being paid
 *     themselves (it would count twice).
 *
 * A row counts when it carries no TDS section, or one with the same yearly limit (R-2338: 194J(a) /
 * 194J(b) / royalty share 194J's). A COGS bill's TDS lives on bank_vendor_payment_lines (R-1891 /
 * R-2320 / R-2335) — a bill whose TDS is of another family (194Q on goods) is left out.
 */
import { sameTdsThreshold } from "@/lib/accounting/tds-rates";

export interface FyExpenseRow {
  id: string; amount: number | null; gst_paid: number | null; tds_amount: number | null; tds_section: string | null;
}
export interface FyCogsBillRow {
  id: string; subtotal: number | null; paid_amount: number | null; currency?: string | null; fx_rate?: number | null;
}
export interface FyCogsTdsRow { vendor_bill_id: string | null; tds_amount: number | null; tds_section: string | null }
export interface VendorFyTds { base: number; baseWithoutTds: number }

export function vendorFyTdsTotal(i: {
  section: string;
  expenses: readonly FyExpenseRow[];
  cogsBills: readonly FyCogsBillRow[];
  cogsTds: readonly FyCogsTdsRow[];
  /** The expense being edited (it is "this payment", not an earlier one). */
  excludeId?: string | null;
  /** COGS bills being paid now. */
  excludeBillIds?: readonly string[] | null;
}): VendorFyTds {
  const sec = i.section.trim();
  let base = 0;
  let baseWithoutTds = 0;
  for (const r of i.expenses) {
    if (r.id === i.excludeId || (r.tds_section && !sameTdsThreshold(r.tds_section, sec))) continue;
    const b = Math.max(0, (r.amount ?? 0) - (r.gst_paid ?? 0));
    base += b;
    if (!(r.tds_amount && r.tds_amount > 0)) baseWithoutTds += b;
  }
  const tdsSecs = new Map<string, string[]>();
  for (const t of i.cogsTds) {
    if (!t.vendor_bill_id || !(t.tds_amount && t.tds_amount > 0)) continue;
    tdsSecs.set(t.vendor_bill_id, [...(tdsSecs.get(t.vendor_bill_id) ?? []), t.tds_section ?? ""]);
  }
  const skip = new Set(i.excludeBillIds ?? []);
  for (const b of i.cogsBills) {
    if (skip.has(b.id) || !((b.paid_amount ?? 0) > 0)) continue;
    const secs = tdsSecs.get(b.id) ?? [];
    const withTds = secs.some((s) => sameTdsThreshold(s, sec));
    if (secs.length > 0 && !withTds) continue;
    const inr = (b.currency ?? "INR").toUpperCase() === "INR" ? 1 : (b.fx_rate && b.fx_rate > 0 ? b.fx_rate : 1);
    const v = Math.max(0, Math.round((b.subtotal ?? 0) * inr));
    base += v;
    if (!withTds) baseWithoutTds += v;
  }
  return { base, baseWithoutTds };
}
