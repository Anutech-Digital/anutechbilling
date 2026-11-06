/**
 * R-2502 (G-FY2526) — a Zoho bill / expense / vendor payment (R-2498 getFyDocDetail, money in PAISE)
 * → the facts the purchase import stores in the scan, in WHOLE RUPEES. The paise → rupees step
 * happens HERE ONCE (R-2498 review): every later step (plan, SQL import) only reads rupees.
 *
 *   GST heads   from Zoho's taxes list (IGST… / CGST… / SGST|UTGST…); with no named head, by source
 *               vs destination of supply (same state → CGST + SGST, else IGST).
 *   Lines       one per Zoho line (an expense with no lines: its own account — fy-fetch does that),
 *               taxable and GST share in rupees; the last line takes the rounding difference, so the
 *               lines always add up to the document. `itcEligible` = Zoho's itc_eligibility is not
 *               an "ineligible_*" value.
 *   RCM         Zoho's is_reverse_charge_applied: the vendor charged no GST; the GST we pay ourselves
 *               is `rcmTax` (heads 0, total = taxable).
 *   TDS         Zoho's tds_amount, with its section read from the TDS name ("194 J" → "194J"); an
 *               amount with no readable section is a problem — never guessed.
 *   Problems    not INR, an adjustment, totals that do not add up, TDS with no section. The plan
 *               leaves such a document out and says why.
 *
 * Pure — no Zoho call, no database.
 */
import type { ZohoFyDocDetail } from "../fy-fetch";
import type { ScanFacts } from "../fy-import/scan";

export interface PurchaseLineFacts {
  accountId: string;
  accountName: string;
  description: string;
  hsn: string;
  qty: number;
  /** Whole rupees, before GST. */
  taxable: number;
  /** Whole rupees: this line's share of the document's GST (or RCM tax). */
  tax: number;
  itcEligible: boolean;
}

export interface PurchaseFacts extends ScanFacts {
  kind: "bills" | "expenses";
  zohoId: string;
  number: string;
  date: string;
  dueDate: string | null;
  /** Lower case: open / paid / partially_paid / overdue / void / draft / … */
  status: string;
  vendorZohoId: string;
  vendorName: string;
  gstin: string;
  gstTreatment: string;
  currency: string;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  /** GST the vendor charged (0 under RCM). */
  tax: number;
  /** What the vendor billed: taxable + tax. */
  total: number;
  rcm: boolean;
  /** GST we pay ourselves under reverse charge. */
  rcmTax: number;
  tdsAmount: number;
  tdsSection: string | null;
  lines: PurchaseLineFacts[];
  /** Expenses: the account it was paid from in Zoho. */
  paidThrough: string;
  problems: string[];
}

export interface VendorPaymentFacts extends ScanFacts {
  kind: "vendorpayments";
  zohoId: string;
  number: string;
  date: string;
  status: string;
  vendorZohoId: string;
  vendorName: string;
  currency: string;
  /** Whole rupees paid. */
  amount: number;
  /** Not applied to any bill (an advance), whole rupees. */
  unapplied: number;
  paidThrough: string;
  mode: string;
  reference: string;
  applied: Array<{ billZohoId: string; billNumber: string; amount: number }>;
  problems: string[];
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());
const toPaise = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
/** Paise → whole rupees (half away from zero, like every amount the app stores). */
const rupees = (paise: number): number => Math.sign(paise) * Math.round(Math.abs(paise) / 100);

/**
 * Zoho's TDS name ("Professional Fees [10%] - 194 J", "Rent - 194-I(b)") → the app's section code
 * (lib/accounting/tds-rates.ts): 194J split by what the text says — technical → 194JA, professional
 * → 194JB, royalty → 194JR, plain → legacy "194J"; rent 194-I(a)/(b) → the app's one "194I" (never
 * "194IA", a different section). null when no section is written.
 */
export function tdsSectionOf(v: unknown): string | null {
  const text = str(v).toUpperCase();
  /* "194-I(b)" → "194-IB"; then the digits and up to two letters right after them. */
  const flat = text.replace(/\(([A-Z])\)/g, "$1");
  const m = /(19[0-9]{1,2})(?:[\s.-]*([A-Z]{1,2})(?![A-Z]))?/.exec(flat);
  if (!m) return null;
  const base = m[1];
  const suffix = m[2] ?? "";
  if (base === "194" && suffix.startsWith("I")) {
    /* Rent: 194-I(a) / 194-I(b) / 194I → the app's "194I". A bare "194IA" (no bracket, no dash) is the property-purchase section. */
    const written = text.replace(/\s/g, "");
    return /194-?I\(?[AB]\)/.test(written) || /194-I[AB]?\b/.test(written) || suffix === "I" ? "194I" : `194${suffix}`;
  }
  if (base === "194" && suffix.startsWith("J")) {
    if (suffix === "JA" || /TECHNICAL/.test(text)) return "194JA";
    if (/ROYALT/.test(text)) return "194JR";
    if (suffix === "JB" || /PROFESSION/.test(text)) return "194JB";
    return "194J";
  }
  return base + suffix;
}

/** The section from Zoho's TDS fields: the readable names first; tds_section only when it is a section, not an id. */
function tdsSectionFrom(raw: Record<string, unknown>): string | null {
  for (const k of ["tds_tax_name", "tds_name", "tds_section_formatted"]) {
    const s = tdsSectionOf(raw[k]);
    if (s) return s;
  }
  const sec = str(raw.tds_section);
  return /^\d{6,}$/.test(sec) || sec.length > 40 ? null : tdsSectionOf(sec);
}

/** Split `total` over `weights` in whole numbers; the last non-zero weight takes the difference. */
function spread(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map((_, i) => (i === weights.length - 1 ? total : 0));
  const out = weights.map((w) => Math.round((total * w) / sum));
  let last = -1;
  weights.forEach((w, i) => { if (w !== 0) last = i; });
  out[last] += total - out.reduce((a, b) => a + b, 0);
  return out;
}

type Head = "igst" | "cgst" | "sgst";
function headOf(name: string): Head | null {
  const n = name.toUpperCase();
  if (n.includes("IGST")) return "igst";
  if (n.includes("CGST")) return "cgst";
  if (n.includes("SGST") || n.includes("UTGST")) return "sgst";
  return null;
}

export function zohoPurchaseFacts(d: ZohoFyDocDetail): PurchaseFacts {
  const raw = d.raw ?? {};
  const problems: string[] = [];
  const kind = d.kind === "expenses" ? "expenses" : "bills";
  const currency = (d.currency || str(raw.currency_code) || "INR").toUpperCase();
  if (currency !== "INR") problems.push(`In ${currency} — only rupee (INR) documents are imported; add it by hand with its exchange rate.`);
  if (toPaise(raw.adjustment) !== 0) problems.push(`Has an adjustment of ₹${str(raw.adjustment)} in Zoho — add it by hand.`);

  /* Lines: taxable in paise first, then whole rupees that add up to the document. */
  const linePaise = d.lines.map((l) => l.amountPaise);
  const subPaise = raw.sub_total !== undefined ? toPaise(raw.sub_total) : linePaise.reduce((a, b) => a + b, 0);
  const taxable = rupees(subPaise);
  const rawLines = Array.isArray(raw.line_items) ? (raw.line_items as Array<Record<string, unknown>>) : [];

  /* GST heads, from the named taxes; else by place of supply. */
  const heads: Record<Head, number> = { igst: 0, cgst: 0, sgst: 0 };
  let named = 0;
  for (const t of d.taxes) {
    const h = headOf(t.name);
    if (h) { heads[h] += t.amountPaise; named += t.amountPaise; }
  }
  const taxPaise = d.taxTotalPaise;
  if (named === 0 && taxPaise > 0) {
    const src = str(raw.source_of_supply).toUpperCase();
    const dst = str(raw.destination_of_supply ?? d.placeOfSupply).toUpperCase();
    if (src && dst && src === dst) { heads.cgst = Math.floor(taxPaise / 2); heads.sgst = taxPaise - heads.cgst; }
    else if (src && dst) heads.igst = taxPaise;
    else problems.push("Its GST has no IGST / CGST / SGST head and no place of supply — add it by hand.");
  } else if (named !== taxPaise && taxPaise > 0) {
    problems.push(`Its GST heads (₹${(named / 100).toFixed(2)}) do not add up to its GST (₹${(taxPaise / 100).toFixed(2)}).`);
  }
  /* Round the GST once (not head by head — CGST 9.50 + SGST 9.50 must stay ₹19), then split it. */
  const taxR = rupees(heads.igst + heads.cgst + heads.sgst);
  const igstR = rupees(heads.igst);
  const cgstR = heads.cgst + heads.sgst > 0 ? Math.min(taxR - igstR, rupees(heads.cgst)) : 0;
  const h = { igst: igstR, cgst: cgstR, sgst: taxR - igstR - cgstR };
  const rcm = d.reverseCharge;
  /* Under reverse charge Zoho keeps the self-assessed GST apart (reverse_charge_tax_total); the
     vendor charged none. Older payloads carry it in tax_total. */
  const rcmTaxR = !rcm ? 0 : toPaise(raw.reverse_charge_tax_total) > 0 ? rupees(toPaise(raw.reverse_charge_tax_total)) : taxR;

  /* Each line's GST share: Zoho's own line taxes when given, else amount × rate; spread so they add up. */
  const lineTaxWeights = d.lines.map((l, i) => {
    const lt = rawLines[i]?.line_item_taxes;
    if (Array.isArray(lt) && lt.length) return (lt as Array<Record<string, unknown>>).reduce((a, t) => a + toPaise(t.tax_amount), 0);
    return Math.round((l.amountPaise * (l.taxPercent ?? 0)) / 100);
  });
  const lineTaxable = d.lines.length ? spread(taxable, linePaise) : [];
  const lineTax = d.lines.length ? spread(rcm ? rcmTaxR : taxR, lineTaxWeights.some((w) => w > 0) ? lineTaxWeights : linePaise) : [];
  const lines: PurchaseLineFacts[] = d.lines.map((l, i) => ({
    accountId: l.accountId,
    accountName: l.accountName,
    description: l.description,
    hsn: l.hsnOrSac,
    qty: l.quantity,
    taxable: lineTaxable[i],
    tax: lineTax[i],
    itcEligible: !/^ineligible/i.test(str(rawLines[i]?.itc_eligibility ?? (kind === "expenses" ? raw.itc_eligibility : ""))),
  }));
  if (!lines.length) problems.push("It has no lines or account in Zoho.");

  const tdsAmount = rupees(d.tdsPaise);
  const tdsSection = tdsAmount > 0
    ? tdsSectionFrom(raw)
    : null;
  if (tdsAmount > 0 && !tdsSection) problems.push(`TDS ₹${tdsAmount} with no TDS section readable in Zoho — add it by hand.`);

  const total = taxable + (rcm ? 0 : taxR);
  const zohoTotal = rupees(d.totalPaise);
  /* Zoho's total may be net of TDS (bills) — taxable + GST − TDS. Anything else that differs by more than ₹1 is a problem. */
  if (lines.length && Math.abs(zohoTotal - total) > 1 && Math.abs(zohoTotal - (total - tdsAmount)) > 1) {
    problems.push(`Taxable ₹${taxable} + GST ₹${rcm ? 0 : taxR} does not match Zoho's total ₹${zohoTotal}.`);
  }

  return {
    kind,
    zohoId: d.id,
    number: d.number.slice(0, 60),
    date: d.date,
    dueDate: str(raw.due_date) || null,
    status: d.status.toLowerCase(),
    vendorZohoId: d.contactId,
    vendorName: d.contactName,
    gstin: d.gstNo.toUpperCase(),
    gstTreatment: d.gstTreatment,
    currency,
    taxable,
    ...(rcm ? { igst: 0, cgst: 0, sgst: 0 } : h),
    tax: rcm ? 0 : taxR,
    total,
    rcm,
    rcmTax: rcmTaxR,
    tdsAmount,
    tdsSection,
    lines,
    paidThrough: str(raw.paid_through_account_name),
    problems,
  };
}

export function zohoVendorPaymentFacts(d: ZohoFyDocDetail): VendorPaymentFacts {
  const raw = d.raw ?? {};
  const problems: string[] = [];
  const currency = (d.currency || str(raw.currency_code) || "INR").toUpperCase();
  if (currency !== "INR") problems.push(`In ${currency} — only rupee (INR) payments are imported.`);
  const bills = Array.isArray(raw.bills) ? (raw.bills as Array<Record<string, unknown>>) : [];
  const applied = bills
    .map((b) => ({ billZohoId: str(b.bill_id), billNumber: str(b.bill_number), amount: rupees(toPaise(b.amount_applied)) }))
    .filter((b) => b.billZohoId && b.amount > 0);
  const amount = rupees(d.totalPaise);
  const unapplied = d.balancePaise !== null ? rupees(d.balancePaise) : Math.max(0, amount - applied.reduce((a, b) => a + b.amount, 0));
  return {
    kind: "vendorpayments",
    zohoId: d.id,
    number: d.number.slice(0, 60),
    date: d.date,
    status: d.status.toLowerCase(),
    vendorZohoId: d.contactId,
    vendorName: d.contactName,
    currency,
    amount,
    unapplied,
    paidThrough: str(raw.paid_through_account_name),
    mode: str(raw.payment_mode),
    reference: str(raw.reference_number),
    applied,
    problems,
  };
}
