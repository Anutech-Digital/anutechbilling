/**
 * R-2717 — GST rate per LINE of an invoice. Pure functions, no React, no Supabase.
 *
 * Until now an invoice had one GST rate (`invoices.tax_rate`) and every report, the PDF and
 * the credit note read that one number. A Zoho invoice with a 0% line and an 18% line could
 * not be held: the GSTR-1 would have filed the 0% line at 18% (R-2702 left 7 such invoices
 * out of the FY import for that reason).
 *
 * STORAGE
 *   · A line in `invoices.line_items` may carry its own `tax_rate` (GST %).
 *   · A line with none takes the invoice's rate — every invoice issued before this card.
 *   · An invoice whose lines carry DIFFERENT rates has `invoices.tax_rate` NULL: there is
 *     no single rate, and a reader that still wants one gets "unknown", never a wrong slab.
 *   · taxable_value / tax_amount / amount stay the invoice's own figures (money rule G17:
 *     an imported Zoho sale is kept as filed, never re-computed).
 *
 * THE ONE RULE (`rateSlices`): the invoice's taxable value is shared over its lines by line
 * value (the same shares the HSN table uses), grouped by rate. GST per rate is taxable ×
 * rate; the rupee or two by which that misses the invoice's own GST goes on the highest
 * rate, so a 0% slice always carries ₹0 and the slices always add up to the invoice.
 */
import { splitTaxHeads } from "./tax-split";

/** A stored invoice line, as far as its GST rate is concerned. */
export interface RateSourceLine {
  qty?: number;
  rate?: number;
  /** The line's own GST %, when the invoice carries rates per line. */
  tax_rate?: number | null;
  /** R-2702: a Zoho `adjustment` line is outside the taxable value — no rate, no share. */
  kind?: string | null;
}

/** One GST rate of a document: its share of the taxable value and of the GST. */
export interface RateSlice { rate: number; taxable: number; gst: number }

/** The line's own GST %, or null when it carries none (then the invoice's rate applies). */
export function lineOwnRate(line: Pick<RateSourceLine, "tax_rate"> | null | undefined): number | null {
  const r = line?.tax_rate;
  return typeof r === "number" && Number.isFinite(r) && r >= 0 ? r : null;
}

/** The line's value as a share weight: qty × rate. An adjustment line has no share. */
export function lineWeight(line: RateSourceLine): number {
  if (line.kind === "adjustment") return 0;
  const w = (line.qty ?? 0) * (line.rate ?? 0);
  return Number.isFinite(w) ? w : 0;
}

/**
 * Slices of a document by GST rate, from line shares that already add up to its taxable
 * value (`docHsnLines` in gstr1.ts makes them). A share with no rate takes `doc.taxRate`.
 *
 * One rate → ONE slice carrying the document's own taxable and GST, untouched: every
 * single-rate invoice reports exactly as it did before this card.
 * Signed input (a credit note comes in negative) gives signed slices.
 */
export function rateSlices(
  doc: { taxableValue: number; gst: number; taxRate: number },
  shares: readonly { taxable: number; rate?: number | null }[] | null | undefined,
): RateSlice[] {
  const byRate = new Map<number, number>();
  for (const s of shares ?? []) {
    const rate = typeof s.rate === "number" && Number.isFinite(s.rate) && s.rate >= 0 ? s.rate : doc.taxRate;
    byRate.set(rate, (byRate.get(rate) ?? 0) + s.taxable);
  }
  if (byRate.size <= 1) {
    const only = byRate.size === 1 ? [...byRate.keys()][0] : doc.taxRate;
    return [{ rate: only, taxable: doc.taxableValue, gst: doc.gst }];
  }
  const slices = [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, taxable]) => ({ rate, taxable, gst: Math.round((taxable * rate) / 100) || 0 }));   // `|| 0`: never −0
  /* The document's own GST is the truth (as filed). What rate × taxable misses goes on the
     highest rate — never on a 0% slice. */
  const gap = doc.gst - slices.reduce((s, x) => s + x.gst, 0);
  slices[slices.length - 1].gst += gap;
  return slices;
}

/** The document's taxable value shared over its lines by value, each with its own rate.
 *  No usable line → one share with no rate (the document's). The last line takes the
 *  remainder, so the shares add up to the taxable value to the rupee. */
export function lineRateShares(
  taxableValue: number,
  lines: readonly RateSourceLine[] | null | undefined,
): { taxable: number; rate: number | null }[] {
  const usable = (lines ?? []).filter((l) => lineWeight(l) > 0);
  const total = usable.reduce((s, l) => s + lineWeight(l), 0);
  if (!usable.length || total <= 0) return [{ taxable: taxableValue, rate: null }];
  let assigned = 0;
  return usable.map((l, i) => {
    const share = i === usable.length - 1 ? taxableValue - assigned : Math.round((taxableValue * lineWeight(l)) / total);
    assigned += share;
    return { taxable: share, rate: lineOwnRate(l) };
  });
}

/** `rateSlices` straight from stored lines (PDF, GST mismatch check, credit-note preview). */
export function linesRateSlices(
  doc: { taxableValue: number; gst: number; taxRate: number },
  lines: readonly RateSourceLine[] | null | undefined,
): RateSlice[] {
  return rateSlices(doc, lineRateShares(doc.taxableValue, lines));
}

/**
 * What a report row shows as "the rate" of a document: its own rate, or — when its lines carry
 * different rates — the highest one plus the full list (`rates`, lowest first) for the label.
 */
export function docRates(
  doc: { taxableValue: number; gst: number; taxRate: number },
  shares: readonly { taxable: number; rate?: number | null }[] | null | undefined,
): { taxRate: number; rates?: number[] } {
  const slices = rateSlices(doc, shares);
  if (!isMixedRate(slices)) return { taxRate: doc.taxRate };
  return { taxRate: slices[slices.length - 1].rate, rates: slices.map((s) => s.rate) };
}

/**
 * The "Tax" cell of the GST output table. One rate → the words it always showed. Several
 * rates → every rate named ("IGST 0% + 18%", "CGST + SGST 0% + 18%"), never just one of them.
 */
export function outputRateLabel(r: { isExport: boolean; gst: number; interState: boolean; taxRate: number; rates?: readonly number[] }): string {
  const many = r.rates && r.rates.length > 1 ? r.rates.map((x) => `${x}%`).join(" + ") : null;
  if (r.isExport) return r.gst ? `Export · IGST ${many ?? `${r.taxRate}%`}` : "Export · LUT (0%)";
  if (r.interState) return `IGST ${many ?? `${r.taxRate}%`}`;
  return many ? `CGST + SGST ${many}` : `CGST ${r.taxRate / 2}% + SGST ${r.taxRate / 2}%`;
}

/** True when the document carries more than one GST rate. */
export function isMixedRate(slices: readonly RateSlice[] | null | undefined): boolean {
  return (slices?.length ?? 0) > 1;
}

/** "0% + 18%" — the rates of a document, lowest first. */
export function rateLabel(slices: readonly Pick<RateSlice, "rate">[]): string {
  return slices.map((s) => `${s.rate}%`).join(" + ");
}

/**
 * A credit / debit note of `gross` against a mixed-rate invoice: split in the invoice's own
 * taxable : GST proportion (a note has no lines — it follows the invoice it amends). The
 * same arithmetic as SQL `issue_credit_note` / `issue_debit_note` (R-2717 migration).
 * Null when the invoice's figures cannot give a proportion.
 */
export function mixedRateNoteSplit(
  gross: number,
  invoice: { taxableValue: number | null | undefined; taxAmount: number | null | undefined },
): { taxable: number; tax: number } | null {
  const t = invoice.taxableValue, g = invoice.taxAmount;
  if (t == null || g == null || t + g <= 0) return null;
  const taxable = Math.round((gross * t) / (t + g));
  return { taxable, tax: gross - taxable };
}

export interface PdfTaxRow { label: string; amount: number }

/**
 * The tax rows of a mixed-rate invoice PDF: one per rate and head, each naming the taxable
 * value it is charged on. Null for a single-rate invoice — the PDF keeps its one row.
 * CGST / SGST halves per rate by the shared rule in lib/gst/tax-split.ts.
 */
export function pdfTaxRows(
  slices: readonly RateSlice[],
  interState: boolean,
  money: (inr: number) => string,
): PdfTaxRow[] | null {
  if (!isMixedRate(slices)) return null;
  const rows: PdfTaxRow[] = [];
  for (const s of slices) {
    const on = `on ${money(s.taxable)}`;
    if (interState) {
      rows.push({ label: `IGST @ ${s.rate}% ${on}`, amount: s.gst });
    } else {
      const h = splitTaxHeads(s.gst, false);
      rows.push({ label: `CGST @ ${s.rate / 2}% ${on}`, amount: h.cgst });
      rows.push({ label: `SGST @ ${s.rate / 2}% ${on}`, amount: h.sgst });
    }
  }
  return rows;
}
