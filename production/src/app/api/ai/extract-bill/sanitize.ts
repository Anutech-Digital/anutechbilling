/**
 * Pure, dependency-free helpers for the bill extractor — kept out of route.ts
 * so they can be unit-tested without pulling in server-only Supabase/Gemini
 * imports. The route sanitises Gemini's raw JSON through these before handing
 * the fields to the Add Vendor Bill form (amounts stay in the bill's own
 * currency; the form converts to ₹ for the books).
 */

// A single line on the bill (product/service the supplier charged for).
export interface ExtractedLine {
  description?: string | null;
  qty?:         number | null;
  unit_price?:  number | null;   // per-unit, in the bill's own currency
  amount?:      number | null;   // line total, in the bill's own currency
}

// The shape we ask Gemini to return (all optional — a bill may hide some fields).
export interface ExtractedBill {
  vendor_name?:  string | null;
  vendor_gstin?: string | null;
  bill_no?:      string | null;
  bill_date?:    string | null;   // YYYY-MM-DD
  currency?:     string | null;   // ISO code seen on the bill: "INR" | "USD" | ...
  subtotal?:     number | null;   // taxable value BEFORE tax, in the bill's currency
  cgst?:         number | null;
  sgst?:         number | null;
  igst?:         number | null;
  total?:        number | null;   // incl tax, in the bill's currency
  line_items?:   ExtractedLine[] | null;
  category_guess?: string | null;
}

// Keep decimals — foreign bills (USD) need cents; INR gets rounded in the form.
// Header amounts (subtotal/tax/total) can't be negative, so floor at 0.
const toNum = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100) / 100) : null;
};
// Line-item amounts KEEP their sign — a credit / unused-time / discount row is a
// negative amount (e.g. -61.41 on a proration invoice) and must not clamp to 0.
const toSignedNum = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

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
export function sanitizeExtractedBill(ai: ExtractedBill) {
  const lines = Array.isArray(ai.line_items) ? ai.line_items : [];
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
    line_items:   lines
      .map((l) => ({
        description: (l?.description ?? "").toString().trim(),
        qty:         toNum(l?.qty),
        unit_price:  toSignedNum(l?.unit_price),
        amount:      toSignedNum(l?.amount) ?? 0,
      }))
      .filter((l) => l.description || l.amount !== 0),
    category_guess: (ai.category_guess ?? "").toString().trim() || null,
  };
}
