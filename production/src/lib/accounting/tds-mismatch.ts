/**
 * R-2047 — a TDS receivable entry whose TDS is not rate × gross.
 *
 * Owner's case (24 Oct): gross ₹1,00,000 (pre-GST taxable) @ 10% shows TDS ₹11,800 with no
 * explanation. The customer deducted 10% of the GST-inclusive ₹1,18,000. Under CBDT Circular
 * 23/2017 TDS is on the amount before GST when GST is shown separately, so ₹1,800 was deducted
 * extra. The stored TDS stays as it is — it is the real deduction, the one 26AS will show and
 * the one we claim. This only explains it, and says what to ask the customer next time.
 *
 * Pure: the screen (list, detail) and the R-523 rate-check report read the same answer.
 */
import { rupee } from "@/lib/utils";

/** A difference up to ₹1 is rounding, not a mismatch. */
export const TDS_MISMATCH_TOLERANCE = 1;

/** The next step for an entry deducted on the GST-inclusive amount (copyable on screen). */
export const TDS_GST_NEXT_STEP = "Ask the customer to deduct on the amount before GST next time";

/** R-523 report reason for these entries. */
export const TDS_GST_INCLUSIVE_REASON = "TDS on GST-inclusive amount";

export interface TdsMismatchInput {
  /** tds_receivable.gross_amount — the pre-GST taxable amount the TDS should be on. */
  gross: number | null | undefined;
  /** tds_receivable.tds_amount — what the customer actually deducted. */
  tds: number | null | undefined;
  ratePct: number | string | null | undefined;
  /** GST on this gross (from the linked invoice); null = not known. */
  gst: number | null | undefined;
}

export interface TdsMismatch {
  /** gst_inclusive: TDS ≈ rate × (gross + GST). other: any other difference. */
  kind: "gst_inclusive" | "other";
  /** round(rate × gross) — what it should be. */
  expected: number;
  deducted: number;
  /** deducted − expected (negative when less was deducted). */
  extra: number;
  /** TDS ÷ gross, in % (e.g. 11.8). */
  effectivePct: number;
  /** One line for the amber note. */
  note: string;
  /** Copyable next step (gst_inclusive only). */
  nextStep: string | null;
}

/** "10" for 10 / "10.00", "0.1" for "0.10" — the rate as a person writes it. */
function pct(rate: number): string {
  return String(Number(rate.toFixed(4)));
}

export function tdsMismatch(input: TdsMismatchInput): TdsMismatch | null {
  const gross = Number(input.gross ?? 0);
  const deducted = Number(input.tds ?? 0);
  const rate = Number(input.ratePct ?? 0);
  if (!(gross > 0) || !(rate > 0) || !Number.isFinite(deducted)) return null;
  const expected = Math.round((gross * rate) / 100);
  if (Math.abs(deducted - expected) <= TDS_MISMATCH_TOLERANCE) return null;

  const effectivePct = (deducted / gross) * 100;
  const extra = deducted - expected;
  const gst = input.gst === null || input.gst === undefined ? null : Number(input.gst);
  if (gst !== null && gst > 0) {
    const inclusive = gross + gst;
    if (Math.abs(deducted - Math.round((inclusive * rate) / 100)) <= TDS_MISMATCH_TOLERANCE) {
      return {
        kind: "gst_inclusive",
        expected,
        deducted,
        extra,
        effectivePct,
        note:
          `Deducted ${rupee(deducted)} = ${pct(rate)}% of ${rupee(inclusive)} (incl. GST). ` +
          `On ${rupee(gross)} it should be ${rupee(expected)} — customer deducted ${rupee(extra)} extra on GST.`,
        nextStep: TDS_GST_NEXT_STEP,
      };
    }
  }
  return {
    kind: "other",
    expected,
    deducted,
    extra,
    effectivePct,
    note: `Expected ${rupee(expected)} at ${pct(rate)}% — deducted ${rupee(deducted)}.`,
    nextStep: null,
  };
}

/** TDS ÷ gross in %, only when it differs from the rate by more than rounding; else null. */
export function tdsEffectiveRatePct(
  gross: number | null | undefined,
  tds: number | null | undefined,
  ratePct: number | string | null | undefined,
): number | null {
  const m = tdsMismatch({ gross, tds, ratePct, gst: null });
  return m ? m.effectivePct : null;
}

/** The invoice fields gstOnGross reads. */
export interface InvoiceTaxLike {
  taxable_value: number | string | null;
  tax_amount: number | string | null;
  tax_rate: number | string | null;
}

/**
 * GST on this entry's gross, from its invoice: the invoice's own tax when the entry covers the
 * whole taxable value, else gross × the invoice's tax rate (a part payment). Null = unknown.
 */
export function gstOnGross(gross: number, invoice: InvoiceTaxLike | null | undefined): number | null {
  if (!invoice) return null;
  const taxable = invoice.taxable_value === null ? null : Number(invoice.taxable_value);
  const tax = invoice.tax_amount === null ? null : Number(invoice.tax_amount);
  if (taxable !== null && tax !== null && Math.abs(taxable - gross) <= TDS_MISMATCH_TOLERANCE) return tax;
  const rate = invoice.tax_rate === null ? null : Number(invoice.tax_rate);
  if (rate === null || !Number.isFinite(rate)) return null;
  return Math.round((gross * rate) / 100);
}

/** The tds_receivable fields tdsEntryMismatch reads. */
export interface TdsEntryAmounts {
  gross_amount?: number | null;
  tds_amount: number | null;
  rate_pct: number | string | null;
  invoice_id?: string | null;
}

/** tdsMismatch for one stored entry, the GST taken from its linked invoice (if known). */
export function tdsEntryMismatch(
  entry: TdsEntryAmounts,
  taxByInvoice?: Readonly<Record<string, InvoiceTaxLike>> | null,
): TdsMismatch | null {
  const gross = Number(entry.gross_amount ?? 0);
  const inv = entry.invoice_id ? taxByInvoice?.[entry.invoice_id] : undefined;
  return tdsMismatch({ gross, tds: entry.tds_amount, ratePct: entry.rate_pct, gst: gstOnGross(gross, inv) });
}
