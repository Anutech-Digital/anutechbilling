/**
 * R-2499 (G-FY2526) — one Zoho Books invoice (R-2498 getFyDocDetail, money in PAISE) → the facts
 * an FY 2025-26 sale is booked from, money in WHOLE RUPEES (CLAUDE.md §13: the DB keeps rupees).
 *
 * Paise → rupees happens HERE and only here, once per figure (Math.round(paise / 100)) — the R-2498
 * review's finding 8: one missed /100 makes every FY 2025-26 document 100×.
 *
 *   taxable  = Zoho total − Zoho tax − Zoho adjustment (round-off) — so shipping and a discount
 *              before tax are already inside it, as on the GSTR-1 Zoho filed
 *   tax      = Zoho tax_total
 *   amount   = Zoho total (what the customer owes — AR ties to Zoho)
 *   head     = from the tax Zoho charged (IGST vs CGST + SGST — what was filed); with no tax, from
 *              the place of supply against the seller's state
 *
 * `problems` are reasons the invoice must NOT become a sale, independent of the app's data (void,
 * draft, mixed GST rates, …). Matching to the app's customers / catalogue is plan.ts.
 * Pure: no I/O.
 */
import type { ZohoFyDocDetail } from "../fy-fetch";
import { parsePlaceOfSupply } from "@/lib/import/zoho-opening-invoices";
import { mapGstTreatment } from "../import-plan";

/** Whole rupees from whole paise, rounded once (half up). */
export function paiseToRupees(paise: number): number {
  if (!Number.isFinite(paise)) return 0;
  return Math.round(paise / 100) || 0;
}

export type TaxHead = "igst" | "cgst_sgst" | "none";

export interface SaleLine {
  zohoItemId: string;
  name: string;
  description: string;
  hsn: string;
  qty: number;
  /** Rate per unit in rupees (2 decimals — a display figure; the taxable is the money). */
  rate: number;
  /** This line's pre-tax amount, whole rupees (INR). */
  taxable: number;
  taxPercent: number | null;
}

export interface ZohoSaleFacts {
  zohoId: string;
  number: string;
  date: string;
  dueDate: string | null;
  /** Zoho's own status, lower case (paid, overdue, sent, partially_paid, void, draft, …). */
  status: string;
  zohoCustomerId: string;
  customerName: string;
  gstin: string;
  /** Zoho's gst_treatment code (business_gst, consumer, overseas, …). */
  gstTreatment: string;
  /** The same in the app's words (invoices.gst_treatment), null when Zoho sent none we know. */
  appGstTreatment: string | null;
  /** Two-digit GST state code of the place of supply, null when Zoho sent none we can read. */
  posStateCode: string | null;
  currency: string;
  /** INR per unit when foreign, else null. */
  fxRate: number | null;
  taxable: number;
  tax: number;
  amount: number;
  /** The one GST rate of the invoice; null when its lines carry different rates. */
  taxRate: number | null;
  head: TaxHead;
  lines: SaleLine[];
  /** Reasons this invoice is not booked as a sale (empty = fine so far). */
  problems: string[];
  /** Things worth showing that do not stop it (round-off folded in, …). */
  notes: string[];
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const paiseOf = (v: unknown): number => { const n = num(v); return n === null ? 0 : Math.round(n * 100); };
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Zoho statuses that are not a sale at all. */
export const NOT_A_SALE: Record<string, string> = {
  void: "Void in Zoho — not a sale, not in revenue or GST.",
  draft: "Draft in Zoho — never issued, not in revenue or GST.",
};

/**
 * @param sellerStateCode the company's own GST state code (for a no-tax invoice's head)
 */
export function zohoSaleFacts(d: ZohoFyDocDetail, sellerStateCode: string | null): ZohoSaleFacts {
  const raw = d.raw ?? {};
  const problems: string[] = [];
  const notes: string[] = [];
  const status = d.status.toLowerCase();
  if (NOT_A_SALE[status]) problems.push(NOT_A_SALE[status]);
  if (!ISO.test(d.date)) problems.push("The invoice date could not be read.");

  const currency = (d.currency || "INR").toUpperCase();
  let fx: number | null = null;
  if (currency !== "INR") {
    fx = num(raw.exchange_rate);
    if (!fx || fx <= 0) { problems.push(`In ${currency} with no exchange rate in Zoho.`); fx = null; }
  }
  /** Document currency paise → INR paise (unrounded until paiseToRupees). */
  const inr = (p: number) => (fx ? p * fx : p);

  const adjustmentPaise = paiseOf(raw.adjustment) + paiseOf(raw.roundoff_value);
  const totalPaise = d.totalPaise;
  const taxPaise = d.taxTotalPaise;
  const taxablePaise = totalPaise - taxPaise - adjustmentPaise;

  const amount = paiseToRupees(inr(totalPaise));
  const tax = paiseToRupees(inr(taxPaise));
  const taxable = paiseToRupees(inr(taxablePaise));
  if (Math.abs(adjustmentPaise) > 100) {
    problems.push(`Zoho has an adjustment of ₹${(adjustmentPaise / 100).toFixed(2)} on it — book it by hand or ask the CA.`);
  } else if (amount !== taxable + tax) {
    notes.push(`Round-off: total ₹${amount} = taxable ₹${taxable} + GST ₹${tax} ${amount > taxable + tax ? "+" : "−"} ₹${Math.abs(amount - taxable - tax)}.`);
  }
  if (totalPaise <= 0) problems.push("Total is ₹0.");
  if (taxablePaise < 0 || taxPaise < 0) problems.push("Taxable value or GST is below zero.");
  if (d.tdsPaise > 0) problems.push("Zoho has TDS on the invoice itself — book it by hand or ask the CA.");
  const discount = paiseOf(raw.discount ?? raw.discount_amount);
  if (discount > 0 && raw.is_discount_before_tax === false) problems.push("Discount after tax — the taxable value cannot be read from Zoho.");

  /* GST head as Zoho charged it (that is what GSTR-1 carried). */
  const names = d.taxes.filter((t) => t.amountPaise !== 0).map((t) => t.name.toUpperCase());
  const lineNames = d.lines.map((l) => l.taxName.toUpperCase());
  const all = [...names, ...lineNames];
  const hasIgst = all.some((n) => n.includes("IGST"));
  const hasCs = all.some((n) => /CGST|SGST|UTGST/.test(n));
  const pos = parsePlaceOfSupply(d.placeOfSupply);
  let head: TaxHead;
  if (taxPaise === 0) head = "none";
  else if (hasIgst && hasCs) { head = "none"; problems.push("Zoho charged IGST and CGST/SGST on the same invoice."); }
  else if (hasIgst) head = "igst";
  else if (hasCs) head = "cgst_sgst";
  else if (pos && sellerStateCode) head = pos === sellerStateCode ? "cgst_sgst" : "igst";
  else { head = "none"; problems.push("The GST head (IGST or CGST/SGST) cannot be read from Zoho."); }
  if (head === "cgst_sgst" && pos && sellerStateCode && pos !== sellerStateCode) {
    problems.push(`Zoho charged CGST/SGST but the place of supply (${pos}) is another state.`);
  }
  if (head === "igst" && pos && sellerStateCode && pos === sellerStateCode && d.gstTreatment !== "business_sez" && !/sez/i.test(d.gstTreatment)) {
    problems.push(`Zoho charged IGST but the place of supply (${pos}) is your own state.`);
  }

  /* Lines: the rate per line. One rate per invoice (our invoices carry one tax_rate). */
  const rawLines = Array.isArray(raw.line_items) ? (raw.line_items as Array<Record<string, unknown>>) : [];
  const lines: SaleLine[] = d.lines.map((l, i) => {
    const r = rawLines[i] ?? {};
    return {
      zohoItemId: str(r.item_id),
      name: str(r.name) || l.description || l.accountName || "Item",
      description: l.description,
      hsn: l.hsnOrSac,
      qty: l.quantity,
      rate: Math.round(inr(paiseOf(r.rate))) / 100,
      taxable: paiseToRupees(inr(l.amountPaise)),
      taxPercent: l.taxPercent,
    };
  });
  const rates = [...new Set(lines.filter((l) => l.taxable !== 0).map((l) => l.taxPercent ?? 0))];
  let taxRate: number | null;
  if (taxPaise === 0) taxRate = 0;
  else if (rates.length === 1) taxRate = rates[0];
  else if (rates.length === 0) {
    /* No lines to read: the rate is the tax over the taxable, when it is a GST slab. */
    const pct = taxablePaise > 0 ? Math.round((taxPaise / taxablePaise) * 1000) / 10 : 0;
    taxRate = [5, 12, 18, 28].includes(pct) ? pct : null;
    if (taxRate === null) problems.push("The GST rate cannot be read from Zoho.");
  } else {
    taxRate = null;
    problems.push(`Lines carry different GST rates (${rates.sort((a, b) => a - b).join("%, ")}%) — one invoice here has one rate.`);
  }
  if (taxRate !== null && taxPaise > 0 && taxRate === 0) problems.push("GST charged at a 0% rate.");

  const due = str(raw.due_date);
  return {
    zohoId: d.id,
    number: d.number,
    date: d.date,
    dueDate: ISO.test(due) ? due : null,
    status,
    zohoCustomerId: d.contactId,
    customerName: d.contactName,
    gstin: d.gstNo.toUpperCase(),
    gstTreatment: d.gstTreatment,
    appGstTreatment: mapGstTreatment(d.gstTreatment),
    posStateCode: pos,
    currency,
    fxRate: fx,
    taxable,
    tax,
    amount,
    taxRate,
    head,
    lines,
    problems,
    notes,
  };
}
