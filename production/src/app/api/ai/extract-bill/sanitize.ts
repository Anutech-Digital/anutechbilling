/**
 * Pure, dependency-free helpers for the bill extractor — kept out of route.ts
 * so they can be unit-tested without pulling in server-only Supabase/Gemini
 * imports. The route sanitises Gemini's raw JSON through these before handing
 * the fields to the Add Vendor Bill form (amounts stay in the bill's own
 * currency; the form converts to ₹ for the books).
 */

// A single line on the bill (product/service the supplier charged for).
import { EXPENSE_CATEGORIES } from "@/lib/accounting/expense-categories";

export interface ExtractedLine {
  description?: string | null;
  /* R-1510: a model sometimes names the row text after the table's header instead
     of "description" — read these too, or the product name silently becomes "". */
  name?:        string | null;
  item?:        string | null;
  product?:     string | null;
  particulars?: string | null;
  service?:     string | null;
  qty?:         number | string | null;
  unit_price?:  number | string | null;   // per-unit, in the bill's own currency
  amount?:      number | string | null;   // line total, in the bill's own currency
}

// The shape we ask Gemini to return (all optional — a bill may hide some fields).
export interface ExtractedBill {
  vendor_name?:  string | null;
  vendor_gstin?: string | null;
  bill_no?:      string | null;
  bill_date?:    string | null;   // YYYY-MM-DD
  currency?:     string | null;   // ISO code seen on the bill: "INR" | "USD" | ...
  subtotal?:     number | string | null;   // taxable value BEFORE tax, in the bill's currency
  cgst?:         number | string | null;
  sgst?:         number | string | null;
  igst?:         number | string | null;
  total?:        number | string | null;   // incl tax, in the bill's currency
  line_items?:   ExtractedLine[] | null;
  category_guess?: string | null;
  /** Overhead kharche ki category — sirf EXPENSE_CATEGORIES me se ek, warna null. */
  expense_category?: string | null;
  /** R-1510: "tax_invoice" | "proforma" | "other" as printed on the document. */
  document_type?: string | null;
}

/**
 * R-1510 — one amount as the model returned it → a number, or null.
 *
 * The prompt asks for JSON numbers, but a model reading "562,110.28 INR" off a
 * Proforma can hand back the STRING. `Number("562,110.28 INR")` is NaN, so the old
 * sanitiser turned such a line into 0 and the header totals into null. This strips
 * a currency word/symbol and grouping commas (western 562,110.28 AND Indian
 * 5,62,110.28 — on these bills a comma is only ever grouping; the decimal mark is
 * the dot) and reads accounting brackets "(61.41)" as a credit. Anything that is
 * not exactly one amount ("1 - 30", "N/A", "12.34.56") is null — never a guess.
 */
const CUR_PREFIX = /^(?:INR|USD|EUR|GBP|AUD|SGD|AED|Rs\.?|₹|\$|€|£)\s*/i;
const CUR_SUFFIX = /\s*(?:INR|USD|EUR|GBP|AUD|SGD|AED|Rs\.?|₹|\$|€|£|\/-)$/i;
const PLAIN_AMOUNT = /^(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?$/;
export function parseBillAmount(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let t = v.trim();
  let neg = false;
  const br = /^\((.*)\)$/.exec(t);
  if (br) { neg = true; t = br[1].trim(); }
  if (t.startsWith("-")) { neg = !neg; t = t.slice(1).trim(); }
  t = t.replace(CUR_PREFIX, "").replace(CUR_SUFFIX, "").trim();
  if (t.startsWith("-")) { neg = !neg; t = t.slice(1).trim(); }
  if (!PLAIN_AMOUNT.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

// Keep decimals — foreign bills (USD) need cents; INR gets rounded in the form.
// Header amounts (subtotal/tax/total) can't be negative, so floor at 0.
const toNum = (v: unknown): number | null => {
  const n = parseBillAmount(v);
  return n != null ? Math.max(0, Math.round(n * 100) / 100) : null;
};
// Line-item amounts KEEP their sign — a credit / unused-time / discount row is a
// negative amount (e.g. -61.41 on a proration invoice) and must not clamp to 0.
const toSignedNum = (v: unknown): number | null => {
  const n = parseBillAmount(v);
  return n != null ? Math.round(n * 100) / 100 : null;
};

/**
 * R-1510 (Pardeep): a bill line with no quantity is ONE of it — show Qty 1 and
 * Unit price = Amount instead of an empty Qty and a 0 rate. Works on the form's
 * string fields (AI-filled lines and lines a user typed only an amount for).
 * The AMOUNT is never changed; a line with its own qty, or a rate that differs
 * from the amount, is left exactly as it is. A 0 qty / 0 rate counts as missing.
 */
export function fillLineQty<L extends { qty: string; unit_price: string; amount: string }>(l: L): L {
  const amt = l.amount.trim();
  const a = Number(amt);
  if (!amt || !Number.isFinite(a) || a === 0) return l;
  const q = l.qty.trim();
  const u = l.unit_price.trim();
  const qtyMissing  = q === "" || Number(q) === 0;
  const rateMissing = u === "" || Number(u) === 0 || Number(u) === a;
  if (!qtyMissing || !rateMissing) return l;
  return { ...l, qty: "1", unit_price: amt };
}

/** R-1510: the row's text, whichever key the model put it under. */
function lineText(l: ExtractedLine | null | undefined): string {
  if (!l) return "";
  for (const k of ["description", "name", "item", "product", "particulars", "service"] as const) {
    const t = (l[k] ?? "").toString().trim();
    if (t) return t;
  }
  return "";
}

/**
 * R-1510: when the model gives no valid cost category, read it off the lines.
 * Matches anywhere in the row, so "Google Workspace ( 1 September - 30 September ,
 * 2026 )" from a RESELLER (vendor name says nothing about Google) still lands on
 * COGS-Workspace. Only the products the form has a COGS bucket for; else null.
 */
const COGS_GUESSES: readonly string[] = ["COGS-Workspace", "COGS-M365", "COGS-Zoho", "COGS-Other"];
function guessCogsFromLines(texts: string[]): string | null {
  const all = texts.join(" \n ").toLowerCase();
  if (/google\s*workspace|g\s*suite/.test(all)) return "COGS-Workspace";
  if (/microsoft\s*365|\bm365\b|office\s*365|\bo365\b/.test(all)) return "COGS-M365";
  if (/\bzoho\b/.test(all)) return "COGS-Zoho";
  return null;
}

/** R-1510: what kind of document this is — a Proforma gives NO GST input credit. */
export function normaliseDocumentType(v: unknown): "tax_invoice" | "proforma" | "other" | null {
  const t = (typeof v === "string" ? v : "").trim().toLowerCase();
  if (!t) return null;
  if (/pro\s*-?\s*forma/.test(t)) return "proforma";
  if (/tax[\s_]*invoice/.test(t)) return "tax_invoice";
  return "other";
}

/** Normalise a bill's currency code to an uppercase ISO-ish token (default INR). */
export function normaliseCurrency(v: unknown): string {
  const s = (v ?? "").toString().trim().toUpperCase();
  if (!s) return "INR";
  if (/RS|RUPEE|INR|₹/.test(s)) return "INR";
  if (/USD|\$|DOLLAR/.test(s))  return "USD";
  return /^[A-Z]{3}$/.test(s) ? s : "INR";
}

/**
 * Pure sanitiser for the Gemini payload → the fields the form consumes.
 * Amounts stay in the bill's own currency; the form converts to ₹ for the books.
 */
/**
 * AI ne jo category kahi, use app ki apni list se milao.
 *
 * Bade-chhote akshar aur aage-peeche ke space maaf hain (model "office supplies" bhi likh
 * sakta hai aur "Office Supplies" bhi). Uske alawa kuch nahi — jo list me nahi, wo `null`.
 * Aur "Salaries" kabhi nahi, chahe model kitna hi pakka ho: tankhwah Payroll se aati hai,
 * aur use ek aam kharcha bana dena payroll ke saare pehre (TDS, PF, payslip) chhod dena hai.
 */
export function matchExpenseCategory(v: unknown): string | null {
  const t = (typeof v === "string" ? v : "").trim().toLowerCase();
  if (!t || t === "salaries") return null;
  return EXPENSE_CATEGORIES.find((c) => c.toLowerCase() === t) ?? null;
}

export function sanitizeExtractedBill(ai: ExtractedBill) {
  const lines = Array.isArray(ai.line_items) ? ai.line_items : [];
  const line_items = lines
    .map((l) => ({
      description: lineText(l),
      qty:         toNum(l?.qty),
      unit_price:  toSignedNum(l?.unit_price),
      amount:      toSignedNum(l?.amount) ?? 0,
    }))
    .filter((l) => l.description || l.amount !== 0);
  const aiCategory = (ai.category_guess ?? "").toString().trim();
  return {
    vendor_name:  (ai.vendor_name ?? "").toString().trim() || null,
    vendor_gstin: (ai.vendor_gstin ?? "").toString().trim().toUpperCase() || null,
    bill_no:      (ai.bill_no ?? "").toString().trim() || null,
    bill_date:    /^\d{4}-\d{2}-\d{2}$/.test((ai.bill_date ?? "").toString()) ? (ai.bill_date as string) : null,
    currency:     normaliseCurrency(ai.currency),
    subtotal:     toNum(ai.subtotal),
    cgst:         toNum(ai.cgst) ?? 0,
    sgst:         toNum(ai.sgst) ?? 0,
    igst:         toNum(ai.igst) ?? 0,
    total:        toNum(ai.total),
    line_items,
    category_guess: COGS_GUESSES.includes(aiCategory)
      ? aiCategory
      : guessCogsFromLines(line_items.map((l) => l.description)) ?? (aiCategory || null),
    /* AI ka jawab list se MILAYA jata hai, seedha liya nahi. Ye field aage P&L me jaati
       hai; ek anjaan string wahan pahunch kar ek naya khaata bana degi jise kisi ne
       manzoor nahi kiya. "Salaries" yahan se kabhi nahi — wo Payroll ka kaam hai. */
    expense_category: matchExpenseCategory(ai.expense_category),
    document_type: normaliseDocumentType(ai.document_type),
  };
}
