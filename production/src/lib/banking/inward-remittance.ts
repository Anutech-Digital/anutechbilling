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

export interface InwardRemittance {
  /** ISO code, upper case, never INR. */
  currency: string;
  /** The foreign amount as the bank wrote it (its own precision). */
  amount: number;
  /** INR per 1 unit — the rate the bank converted at. */
  rate: number;
}

/** Codes a remittance narration is read for (the billing currencies + a few common ones). */
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

/** R-2440: the company's Letter of Undertaking as saved in Settings (tenants.lut_number / lut_valid_upto). */
export interface ExportLut { number: string | null | undefined; validUpto: string | null | undefined }

/** "2026-08-07" → "2026-27" (Indian financial year, 1 Apr – 31 Mar). */
function fyLabel(isoDate: string): { label: string; end: string } {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  const endYear = m >= 4 ? y + 1 : y;
  return { label: `${endYear - 1}-${String(endYear % 100).padStart(2, "0")}`, end: `${endYear}-03-31` };
}

/**
 * R-2440 (tax memo 3 Nov §1; independent review 2 of R-2425): an export sale at 0% GST needs an LUT
 * for the receipt's financial year — the LUT number set and its "Valid up to" inside that FY, on or
 * after the receipt's date. Null = covered. Same rule (and words) as reconcile_bank_credit_new_sale_fx
 * (migration 20261103163318), which refuses the booking too.
 */
export function exportLutProblem(lut: ExportLut | null | undefined, txnDate: string): string | null {
  const fy = fyLabel(txnDate);
  const num = (lut?.number ?? "").trim();
  const upto = (lut?.validUpto ?? "").slice(0, 10);
  if (num && upto && upto >= txnDate && upto <= fy.end) return null;
  return `No LUT for FY ${fy.label} on file. An export sale at 0% GST needs your Letter of Undertaking: add its ARN as "LUT number" with "Valid up to" in Settings → Company, then try again. Without an LUT, reconcile this line by hand with IGST.`;
}
