/**
 * R-2499 (G-FY2526) — one Zoho Books invoice (R-2498 getFyDocDetail, money in PAISE) → the facts
 * an FY 2025-26 sale is booked from, money in WHOLE RUPEES (CLAUDE.md §13: the DB keeps rupees).
 *
 * Paise → rupees happens HERE and only here, once per figure (Math.round(paise / 100)) — the R-2498
 * review's finding 8: one missed /100 makes every FY 2025-26 document 100×.
 *
 *   taxable  = Zoho total − Zoho tax − Zoho adjustment (round-off) — so shipping and a discount
 *              before tax are already inside it, as on the GSTR-1 Zoho filed
 *              (R-2702: + the TDS when Zoho's total is net of the TDS on the invoice)
 *   tax      = Zoho tax_total
 *   amount   = Zoho total (what the customer owes — AR ties to Zoho); R-2702: + the TDS Zoho took
 *              off its total — the sale is the full value, the TDS is the customer's deduction
 *              (facts.tds / tdsSection, booked by the receipts import on the payment that closes it)
 *   R-2702: an adjustment above one unit of the currency = its own line {kind "adjustment"}, no GST;
 *           lines at different GST rates = one invoice, each line its own rate, the invoice the highest.
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
import { tdsSectionOf } from "../purchase-import/normalise";

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
  /** R-2702: "adjustment" = Zoho's invoice adjustment shown as its own line — NOT taxable, no GST,
   *  outside `taxable`; missing = a sold line. */
  kind?: "adjustment";
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
  /** R-2536: the invoice's OWN billing address as Zoho printed it (address, street 2, city,
   *  "state pin", and the country when outside India — the customer snapshot's shape), null when
   *  Zoho has none. The import stores it on the invoice (billing_address), so a branch invoice never
   *  carries another branch's address. */
  billingAddress?: string | null;
  /** R-2536: that address's country as Zoho wrote it, null when none. (Both optional: a scan saved
   *  before R-2536 has neither — the SQL import then writes none.) */
  billingCountry?: string | null;
  currency: string;
  /** INR per unit when foreign, else null. */
  fxRate: number | null;
  taxable: number;
  tax: number;
  amount: number;
  /** R-2650: amount − taxable − tax in whole rupees (Zoho's round-off / adjustment in ₹, plus the
   *  rounding of each figure). Optional: a scan saved before R-2650 has none. */
  roundOff?: number;
  /** R-2702: Zoho's invoice adjustment above one unit of its currency, whole ₹ (signed), shown as an
   *  "adjustment" line with no GST; 0 = none (a smaller one stays inside roundOff, R-2650). Part of
   *  roundOff: amount = taxable + tax + roundOff, |roundOff − adjustment| ≤ roundOffLimit. Optional: a
   *  scan saved before R-2702 has none. */
  adjustment?: number;
  /** R-2702: TDS the customer deducted, shown on the invoice in Zoho, whole ₹ (0 = none). NOT a sale
   *  reduction — `amount` is the full sale; the receipts import books it as the customer's TDS when
   *  Zoho's payment closes the invoice. Optional: a scan saved before R-2702 has none. */
  tds?: number;
  /** R-2702: that TDS's section as Zoho names it ("194J", "194C", …), null when none is readable. */
  tdsSection?: string | null;
  /** The invoice's GST rate: the one rate of its lines; R-2702: with lines at different rates (each
   *  line keeps its own taxPercent), the highest of them. null when it cannot be read. */
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
const INDIA = new Set(["in", "ind", "india", "bharat"]);

/** R-2536: Zoho's billing_address object → one printed line (same shape as invoice_party_snapshot). */
export function zohoBillingAddress(v: unknown): { address: string | null; country: string | null } {
  const a = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const country = str(a.country) || null;
  const abroad = !!country && !INDIA.has(country.toLowerCase());
  const stateZip = [str(a.state), str(a.zip)].filter(Boolean).join(" ");
  /* Zoho keeps multi-line street text — one printed line, like the customer snapshot. */
  const line = (x: unknown) => str(x).replace(/\s*[\r\n]+\s*/g, ", ");
  const parts = [line(a.address), line(a.street2), str(a.city), stateZip, abroad && country ? country : ""].filter(Boolean);
  return { address: parts.length ? parts.join(", ").slice(0, 500) : null, country: country ? country.slice(0, 60) : null };
}

/**
 * R-2650: the most a Zoho invoice's total may differ from taxable + GST, in whole rupees — one unit
 * of the invoice's currency (Zoho allows a round-off/adjustment up to that) in ₹, rounded up, plus ₹1
 * for rounding each figure to the rupee once. ₹ invoice: 2; USD at 85.12: 87. The SQL import
 * (import_zoho_fy_sales) uses the same rule on the scan's currency and fxRate.
 */
export function roundOffLimit(currency: string, fxRate: number | null): number {
  const unit = (currency || "INR").toUpperCase() === "INR" || !fxRate || fxRate <= 0 ? 1 : Math.ceil(fxRate);
  return unit + 1;
}

/** The rates an invoice here can carry (invoices.tax_rate is a whole number; 40% from 22 Sep 2025). */
export const GST_RATES: readonly number[] = [0, 3, 5, 12, 18, 28, 40];

/** Zoho statuses that are not a sale at all. */
export const NOT_A_SALE: Record<string, string> = {
  void: "Void in Zoho — not a sale, not in revenue or GST.",
  draft: "Draft in Zoho — never issued, not in revenue or GST.",
};

/** R-2702: the TDS section from Zoho's TDS fields — the readable names first; `tds_section` only when
 *  it is a section, not one of Zoho's ids. null = none readable (the receipt's own default applies). */
function tdsSectionFrom(raw: Record<string, unknown>): string | null {
  for (const k of ["tds_tax_name", "tds_name", "tds_section_formatted"]) {
    const s = tdsSectionOf(raw[k]);
    if (s) return s;
  }
  const sec = str(raw.tds_section);
  return /^\d{6,}$/.test(sec) || sec.length > 40 ? null : tdsSectionOf(sec);
}

/**
 * R-2702: is Zoho's total of an invoice with TDS NET of it ("net": taxable + GST − TDS — Zoho's way when
 * TDS is applied on the invoice) or the full value ("full")? Told by its lines (Σ line amounts = the
 * taxable, ₹1 per line), else by its one GST rate (GST = rate × taxable), else by the GST being a slab
 * of the taxable. null = neither reading fits — never guessed. Document-currency paise.
 */
export function tdsReading(d: ZohoFyDocDetail, adjustmentPaise: number, tdsPaise: number): "net" | "full" | null {
  const full = d.totalPaise - d.taxTotalPaise - adjustmentPaise;
  const net = full + tdsPaise;
  const tol = 100 * Math.max(1, d.lines.length) + 100;
  const pick = (okNet: boolean, okFull: boolean): "net" | "full" | null => (okNet === okFull ? null : okNet ? "net" : "full");
  if (d.lines.length) {
    const linesPaise = d.lines.reduce((a, l) => a + l.amountPaise, 0);
    const byLines = pick(Math.abs(linesPaise - net) <= tol, Math.abs(linesPaise - full) <= tol);
    if (byLines) return byLines;
  }
  const rates = [...new Set(d.lines.filter((l) => l.amountPaise !== 0).map((l) => l.taxPercent ?? 0))];
  if (rates.length === 1 && rates[0] > 0) {
    const r = rates[0] / 100;
    return pick(Math.abs(d.taxTotalPaise - net * r) <= tol, Math.abs(d.taxTotalPaise - full * r) <= tol);
  }
  if (!d.lines.length && d.taxTotalPaise > 0) {
    const slab = (taxable: number) => taxable > 0 && GST_RATES.some((g) => g > 0 && Math.abs(d.taxTotalPaise - (taxable * g) / 100) <= tol);
    return pick(slab(net), slab(full));
  }
  return null;
}

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

  /* Document-currency figures (the adjustment rule below is per unit of the invoice's currency). */
  const adjustmentPaise = paiseOf(raw.adjustment) + paiseOf(raw.roundoff_value);
  const totalPaise = d.totalPaise;
  const taxPaise = d.taxTotalPaise;
  /* R-2702: TDS shown on the invoice. Zoho's total is then usually NET of it (taxable + GST − TDS);
     the sale is the full value either way — the TDS is the customer's deduction, booked on the receipt. */
  const tdsPaise = d.tdsPaise > 0 ? d.tdsPaise : 0;
  const tdsInTotal = tdsPaise > 0 ? tdsReading(d, adjustmentPaise, tdsPaise) : "full";
  if (tdsPaise > 0 && currency !== "INR") {
    problems.push(`Zoho has TDS on a ${currency} invoice — a buyer outside India deducts no Indian TDS. Book it by hand or ask the CA.`);
  } else if (tdsInTotal === null) {
    problems.push(`Zoho has TDS ₹${(tdsPaise / 100).toFixed(2)} on the invoice, but its total ₹${(totalPaise / 100).toFixed(2)} is neither taxable + GST nor taxable + GST − TDS by its lines or its GST rate. Book it by hand or ask the CA.`);
  }
  const tdsAddPaise = tdsInTotal === "net" ? tdsPaise : 0;
  const taxablePaise = totalPaise + tdsAddPaise - taxPaise - adjustmentPaise;

  /* R-2650: ₹ figures. A foreign-currency invoice uses Zoho's OWN base-currency (bcy_*) figures
     when Zoho sends them — that is what Zoho filed in ₹ — else the rate × the document figures.
     Each figure is rounded to the rupee once; the round-off stays a round-off (never folded into
     the taxable or the GST). */
  const bcy = (k: string): number | null => (fx ? num(raw[`bcy_${k}`]) : null);
  const bcyTotal = bcy("total");
  const bcyTax = bcy("tax_total");
  const useBcy = bcyTotal !== null && bcyTax !== null;
  const totalInr = useBcy ? Math.round(bcyTotal * 100) : inr(totalPaise);
  const taxInr = useBcy ? Math.round(bcyTax * 100) : inr(taxPaise);
  const bcyAdj = bcy("adjustment");
  const bcyRound = bcy("roundoff_value");
  /* Each part on its own: Zoho's ₹ figure when it sent one, else the rate × the document figure
     (Zoho often sends bcy_adjustment but no bcy_roundoff_value — the round-off must not vanish). */
  const adjustmentInr =
    (useBcy && bcyAdj !== null ? Math.round(bcyAdj * 100) : inr(paiseOf(raw.adjustment)))
    + (useBcy && bcyRound !== null ? Math.round(bcyRound * 100) : inr(paiseOf(raw.roundoff_value)));

  /* R-2702: the full sale = Zoho's total + the TDS it took off (a ₹ invoice only — foreign TDS is refused). */
  const tdsAddInr = inr(tdsAddPaise);
  const amount = paiseToRupees(totalInr + tdsAddInr);
  const tax = paiseToRupees(taxInr);
  const taxable = paiseToRupees(totalInr + tdsAddInr - taxInr - adjustmentInr);
  const tds = tdsPaise > 0 ? paiseToRupees(inr(tdsPaise)) : 0;
  const tdsSection = tds > 0 ? tdsSectionFrom(raw) : null;
  if (tds > 0 && tdsInTotal !== null) {
    notes.push(`TDS ₹${tds}${tdsSection ? ` (${tdsSection})` : ""} on the invoice in Zoho — the customer's deduction: the sale is ₹${amount}; the TDS is booked with the receipt that closes it.`);
  }
  /* R-2702: an adjustment above one unit of the invoice's currency is Zoho's own line on the invoice
     (a discount, a settlement) — kept as a visible "adjustment" line with no GST; a smaller one is a
     round-off (R-2650). Taxable and GST stay Zoho's; the total equals Zoho's. */
  const adjustment = Math.abs(adjustmentPaise) > 100 ? paiseToRupees(adjustmentInr) : 0;
  /* R-2650: what is left between the total and taxable + GST (Zoho's round-off/adjustment in ₹,
     plus at most ₹1 from rounding each figure once). The SQL import checks it with roundOffLimit. */
  const roundOff = amount - taxable - tax;
  /* R-2702: with an adjustment, the taxable read from the total must be its lines' (₹1 per line) — an
     adjustment that is really a hidden discount on the lines is never booked as a no-GST line. */
  const linesInr = paiseToRupees(inr(d.lines.reduce((a, l) => a + l.amountPaise, 0)));
  if (adjustment !== 0 && d.lines.length && Math.abs(linesInr - taxable) > d.lines.length + 1) {
    problems.push(`Zoho's adjustment ₹${adjustment}: the taxable ₹${taxable} its total leaves is not its lines' ₹${linesInr}. Book it by hand or ask the CA.`);
  } else if (Math.abs(roundOff - adjustment) > roundOffLimit(currency, fx)) {
    problems.push(`Zoho's ₹ figures leave ₹${Math.abs(roundOff - adjustment)} between the total ₹${amount} and taxable ₹${taxable} + GST ₹${tax}${adjustment ? ` + adjustment ₹${adjustment}` : ""} — more than its round-off allows (₹${roundOffLimit(currency, fx)}). Book it by hand or ask the CA.`);
  } else if (adjustment !== 0) {
    notes.push(`Adjustment in Zoho: ${adjustment > 0 ? "+" : "−"}₹${Math.abs(adjustment)} — its own line on the invoice, no GST (total ₹${amount}).`);
  } else if (roundOff !== 0) {
    notes.push(`Round-off: total ₹${amount} = taxable ₹${taxable} + GST ₹${tax} ${roundOff > 0 ? "+" : "−"} ₹${Math.abs(roundOff)}.`);
  }
  /* R-2650: genuinely broken data stays refused — Zoho's own GST heads must make its GST total. */
  /* Not on a reverse-charge sale: its tax rows are the buyer's, not in Zoho's tax_total. */
  if (d.taxes.length && !d.reverseCharge) {
    const named = d.taxes.reduce((a, t) => a + t.amountPaise, 0);
    if (Math.abs(named - taxPaise) > 100) {
      problems.push(`Its GST heads (${(named / 100).toFixed(2)}) do not add up to its GST (${(taxPaise / 100).toFixed(2)}) in Zoho.`);
    }
  }
  /* TCS is collected on top of the sale: it would sit inside the taxable value. */
  if (paiseOf(raw.tcs_amount) > 0) problems.push("Zoho collected TCS on the invoice — book it by hand or ask the CA.");
  if (totalPaise <= 0) problems.push("Total is ₹0.");
  if (taxablePaise < 0 || taxPaise < 0) problems.push("Taxable value or GST is below zero.");
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
  /* No tax (nil / exempt / zero-rated): the head still says inter- or intra-state (GSTR-1 / 3B
     split nil and exempt that way) — from the place of supply against the seller's state. */
  if (taxPaise === 0) head = pos && sellerStateCode && pos !== sellerStateCode ? "igst" : "none";
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
  const rates = [...new Set(lines.filter((l) => l.taxable !== 0).map((l) => l.taxPercent ?? 0))].sort((a, b) => a - b);
  let taxRate: number | null;
  if (taxPaise === 0) taxRate = 0;
  else if (rates.length === 1) taxRate = rates[0];
  else if (rates.length === 0) {
    /* No lines to read: the rate is the tax over the taxable, when it is a GST slab. */
    const pct = taxablePaise > 0 ? Math.round((taxPaise / taxablePaise) * 1000) / 10 : 0;
    taxRate = GST_RATES.includes(pct) && pct > 0 ? pct : null;
    if (taxRate === null) problems.push("The GST rate cannot be read from Zoho.");
  } else {
    /* R-2702: lines at different rates (0% + 18% — an exempt / zero-rated line beside a taxed one).
       One invoice, each line keeping its own rate, when Zoho's GST is those rates on those lines
       (₹1 of rounding per line, + 1). The invoice carries the highest rate. */
    const byLines = lines.reduce((a, l) => a + (l.taxable * (l.taxPercent ?? 0)) / 100, 0);
    const odd = rates.filter((r) => !GST_RATES.includes(r));
    if (odd.length) {
      taxRate = null;
      problems.push(`GST rate ${odd.join("%, ")}% on a line is not one this app stores — book it by hand.`);
    } else if (Math.abs(byLines - tax) > lines.length + 1) {
      taxRate = null;
      problems.push(`Lines carry different GST rates (${rates.join("%, ")}%) but Zoho's GST ₹${tax} is not those rates on those lines (₹${Math.round(byLines)}) — book it by hand.`);
    } else {
      taxRate = rates[rates.length - 1];
      notes.push(`Lines at ${rates.join("%, ")}% GST — each line keeps its own rate; the invoice shows ${taxRate}%.`);
    }
  }
  /* R-2702: Zoho's adjustment as its own line — after the rates, so it never counts as a rate. */
  if (adjustment !== 0) {
    lines.push({
      zohoItemId: "", name: (str(raw.adjustment_description) || "Adjustment").slice(0, 300),
      description: "Adjustment in Zoho — no GST", hsn: "", qty: 1, rate: adjustment, taxable: adjustment, taxPercent: null,
      kind: "adjustment",
    });
  }
  if (taxRate !== null && taxPaise > 0 && taxRate === 0) problems.push("GST charged at a 0% rate.");
  else if (taxRate !== null && !GST_RATES.includes(taxRate)) problems.push(`GST rate ${taxRate}% is not one this app stores on an invoice — book it by hand.`);

  const due = str(raw.due_date);
  const bill = zohoBillingAddress(raw.billing_address);
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
    billingAddress: bill.address,
    billingCountry: bill.country,
    currency,
    fxRate: fx,
    taxable,
    tax,
    amount,
    roundOff,
    adjustment,
    tds,
    tdsSection,
    taxRate,
    head,
    lines,
    problems,
    notes,
  };
}
