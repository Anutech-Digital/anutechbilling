/**
 * R-2425 — a foreign inward remittance on a bank line.
 *
 * Pardeep (3 Nov, staging HDFC 4523): export receipts (≈₹14 L) could not be booked because the
 * bank line and the Zoho plan treated everything as INR. HDFC writes the foreign amount and its
 * own conversion rate into the narration: "INW 070826I049902623 USD1024.0@93.6" = $1,024 converted
 * at ₹93.60 = ₹95,846.40 credited. Pure, no I/O.
 *
 * The books stay in INR (lib/currency.ts): the bank credit IS the rupee value of the receipt; the
 * foreign amount and rate say what was billed and at what rate the bank converted it.
 */
import { formatForeign } from "@/lib/currency";
import { exportLutRefusal, legacyLutRows, type TenantLut } from "@/lib/gst/export-lut";

export interface InwardRemittance {
  /** ISO code, upper case, never INR. */
  currency: string;
  /** The foreign amount as the bank wrote it (its own precision). */
  amount: number;
  /** INR per 1 unit — the rate the bank converted at. */
  rate: number;
}

/** Codes a remittance narration is read for (the billing currencies + a few common ones).
 *  R-2440: reconcile_bank_credit_new_sale_fx (migration 20261103163318) holds the same list twice — change all three together. */
const CODES = ["USD", "EUR", "GBP", "AED", "SGD", "AUD", "CAD", "CHF", "JPY", "NZD", "HKD", "SAR"];
const RE = new RegExp(`(?:^|[^A-Z])(${CODES.join("|")})\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*@\\s*([0-9]+(?:\\.[0-9]+)?)`, "i");

/** "INW … USD1024.0@93.6" → {USD, 1024, 93.6}; null when the narration carries no foreign amount + rate. */
export function parseInwardRemittance(narration: string | null | undefined): InwardRemittance | null {
  const m = RE.exec(narration ?? "");
  if (!m) return null;
  const amount = Number(m[2].replace(/,/g, ""));
  const rate = Number(m[3]);
  if (!(amount > 0) || !(rate > 0) || !Number.isFinite(amount) || !Number.isFinite(rate)) return null;
  return { currency: m[1].toUpperCase(), amount, rate };
}

/** amount × rate in rupees and paise (what the bank should have credited). */
export function remittanceInr(r: InwardRemittance): number {
  return Math.round(r.amount * r.rate * 100) / 100;
}

/** The bank credit is amount × rate (±₹1) — the narration really describes this credit. */
export function remittanceFitsCredit(r: InwardRemittance, credit: number): boolean {
  return Math.abs(remittanceInr(r) - credit) <= 1 + 1e-9;
}

/** "$1,024 @ ₹93.60" — whole foreign amounts without decimals; the rate with at least 2 decimals. */
export function formatRemittance(r: InwardRemittance): string {
  const whole = Number.isInteger(r.amount);
  const decimals = (String(r.rate).split(".")[1] ?? "").length;
  const rate = r.rate.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: Math.max(2, decimals) });
  return `${formatForeign(r.amount, r.currency, whole ? 0 : 2)} @ ₹${rate}`;
}

/** R-2440: the company's Letter of Undertaking. R-2444: one per financial year — the list from
 *  tenant_luts (Settings → Company → LUT). The old single LUT (tenants.lut_number / lut_valid_upto)
 *  is still accepted and read as the LUT of its "valid up to" FY. */
export type ExportLut =
  | readonly TenantLut[]
  | { number: string | null | undefined; validUpto: string | null | undefined };

/** The LUT rows of either shape. */
export function exportLutRows(lut: ExportLut | null | undefined): readonly TenantLut[] {
  if (!lut) return [];
  if (Array.isArray(lut)) return lut as readonly TenantLut[];
  const one = lut as { number: string | null | undefined; validUpto: string | null | undefined };
  return legacyLutRows(one.number, one.validUpto);
}

/**
 * R-2440 (tax memo 3 Nov §1; independent review 2 of R-2425): an export sale at 0% GST needs an LUT
 * for the receipt's financial year. R-2444: the LUT OF THAT FY (tenant_luts), so an FY 2025-26
 * receipt books under the FY 2025-26 LUT. Null = covered. Same rule (and words) as
 * export_lut_refusal in SQL (migration 20261104023601), which every 0% export invoice passes too.
 */
export function exportLutProblem(lut: ExportLut | null | undefined, txnDate: string): string | null {
  return exportLutRefusal(exportLutRows(lut), txnDate);
}
