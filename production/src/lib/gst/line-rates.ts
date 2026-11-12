/**
 * R-2717 — GST rate per LINE of an invoice. Pure functions, no React, no Supabase.
 *
 * Until now an invoice had one GST rate (`invoices.tax_rate`) and every report, the PDF and
 * the credit note read that one number. A Zoho invoice with a 0% line and an 18% line could
 * not be held: the GSTR-1 would have filed the 0% line at 18% (R-2702 left 7 such invoices
 * out of the FY import for that reason).
 *
 * STORAGE — an invoice "carries line rates" when EVERY line with value has its own rate:
 *   · `invoices.line_items[].tax_rate` = the line's GST %, and on such a line
 *     `amount` = the line's taxable value in ₹ (after any line discount), as filed.
 *   · All or nothing: if any line with value has no `tax_rate`, the invoice is an ordinary
 *     one-rate invoice and the line rates are ignored — there is no "this line takes the
 *     invoice's rate" guess. Every invoice issued before this card is such an invoice.
 *   · Lines at DIFFERENT rates → `invoices.tax_rate` is NULL (there is no single rate).
 *     Lines all at ONE rate → that rate is the invoice's rate (the lines are the more
 *     specific fact; `tax_rate` may be NULL or the same number).
 *   · taxable_value / tax_amount / amount stay the invoice's own figures (money rule G17:
 *     an imported Zoho sale is kept as filed, never re-computed).
 *
 * THE ONE RULE (`rateSlices`): the invoice's taxable value is shared over its lines by line
 * value (the same shares the HSN table uses — `shareByWeight`), grouped by rate. GST per rate
 * is taxable × rate; the rupee or two by which that misses the invoice's own GST goes on the
 * highest rate, so a 0% slice always carries ₹0 and the slices always add up to the invoice.
 * The GST mismatch check (lib/gst/mismatch.ts) flags an invoice whose GST is NOT its lines'
 * rates applied to their values, so a large gap is seen, not hidden.
 *
 * SQL twin: `public.invoice_note_gst_split` (migration *_r2717_note_follows_line_rates.sql)
 * reads "carries line rates" and "different rates" by the same definition.
 */
import { splitTaxHeads } from "./tax-split";

/** A stored invoice line, as far as its GST rate is concerned. */
export interface RateSourceLine {
  qty?: number;
  rate?: number;
  /** The line's taxable value in ₹ — read only on a line that carries its own `tax_rate`. */
  amount?: number;
  /** The line's own GST %, when the invoice carries rates per line. */
  tax_rate?: number | null;
  /** R-2702: a Zoho `adjustment` line is outside the taxable value — no rate, no share. */
  kind?: string | null;
}

/** One GST rate of a document: its share of the taxable value and of the GST. */
export interface RateSlice { rate: number; taxable: number; gst: number }
export interface TaxHeads { igst: number; cgst: number; sgst: number }

/** The line's own GST %, or null when it carries none. */
export function lineOwnRate(line: Pick<RateSourceLine, "tax_rate"> | null | undefined): number | null {
  const r = line?.tax_rate;
  return typeof r === "number" && Number.isFinite(r) && r >= 0 ? r : null;
}

/**
 * The line's value as a share weight. A line that carries its own rate and a taxable `amount`
 * is weighed by that amount (Zoho's line value after a line discount, as filed); every other
 * line by qty × rate, as the HSN table always did. An adjustment line has no share.
 */
export function lineWeight(line: RateSourceLine): number {
  if (line.kind === "adjustment") return 0;
  if (lineOwnRate(line) != null && typeof line.amount === "number" && Number.isFinite(line.amount)) return line.amount;
  const w = (line.qty ?? 0) * (line.rate ?? 0);
  return Number.isFinite(w) ? w : 0;
}

/**
 * `total` shared over `weights` (all > 0): round(total × w ÷ Σw), the LAST one takes the
 * remainder so the shares add up to the rupee. The one copy of this arithmetic — the HSN
 * table (gstr1.ts hsnLines) and the rate slices both use it.
 */
export function shareByWeight(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  let assigned = 0;
  return weights.map((w, i) => {
    const share = i === weights.length - 1 ? total - assigned : Math.round((total * w) / sum);
    assigned += share;
    return share;
  });
}

/**
 * The distinct GST rates of an invoice that carries line rates, lowest first — or null when
 * it does not (no line with value, or any line with value lacks a rate). TS twin of the test
 * inside SQL `invoice_note_gst_split`.
 */
export function lineRateSet(lines: readonly RateSourceLine[] | null | undefined): number[] | null {
  const rates = new Set<number>();
  let valued = 0;
  for (const l of lines ?? []) {
    if (!l || typeof l !== "object" || lineWeight(l) <= 0) continue;
    valued += 1;
    const r = lineOwnRate(l);
    if (r == null) return null;
    rates.add(r);
  }
  return valued > 0 ? [...rates].sort((a, b) => a - b) : null;
}

/**
 * Slices of a document by GST rate, from line shares that already add up to its taxable
 * value (`docHsnLines` in gstr1.ts makes them).
 *
 * Shares that do not ALL carry a rate → one slice at `doc.taxRate` with the document's own
 * figures (every invoice before this card: nothing moves). All at one rate → one slice at
 * that rate, again with the document's own figures. Several rates → a slice per rate.
 * Signed input (a credit note comes in negative) gives signed slices.
 */
export function rateSlices(
  doc: { taxableValue: number; gst: number; taxRate: number },
  shares: readonly { taxable: number; rate?: number | null }[] | null | undefined,
): RateSlice[] {
  const byRate = new Map<number, number>();
  let allRated = (shares?.length ?? 0) > 0;
  for (const s of shares ?? []) {
    if (typeof s.rate !== "number" || !Number.isFinite(s.rate) || s.rate < 0) { allRated = false; break; }
    byRate.set(s.rate, (byRate.get(s.rate) ?? 0) + s.taxable);
  }
  if (!allRated) return [{ rate: doc.taxRate, taxable: doc.taxableValue, gst: doc.gst }];
  if (byRate.size === 1) return [{ rate: [...byRate.keys()][0], taxable: doc.taxableValue, gst: doc.gst }];
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
 *  No line with value → one share with no rate (the document's). */
export function lineRateShares(
  taxableValue: number,
  lines: readonly RateSourceLine[] | null | undefined,
): { taxable: number; rate: number | null }[] {
  const usable = (lines ?? []).filter((l) => l && typeof l === "object" && lineWeight(l) > 0);
  if (!usable.length) return [{ taxable: taxableValue, rate: null }];
  const shares = shareByWeight(taxableValue, usable.map(lineWeight));
  return usable.map((l, i) => ({ taxable: shares[i], rate: lineOwnRate(l) }));
}

/** `rateSlices` straight from stored lines (PDF, GST mismatch check). */
export function linesRateSlices(
  doc: { taxableValue: number; gst: number; taxRate: number },
  lines: readonly RateSourceLine[] | null | undefined,
): RateSlice[] {
  return rateSlices(doc, lineRateShares(doc.taxableValue, lines));
}

/** True when the document carries more than one GST rate. */
export function isMixedRate(slices: readonly RateSlice[] | null | undefined): boolean {
  return (slices?.length ?? 0) > 1;
}

/**
 * IGST / CGST / SGST of each slice. The document's GST is split into heads ONCE (the shared
 * rule in tax-split.ts — what the invoice and GSTR-1 always used); each slice is split the
 * same way and the highest rate takes what is left, so the per-rate heads add up to the
 * document's heads to the rupee. The PDF and GSTR-1 both read this — never two splits.
 */
export function sliceHeads(slices: readonly RateSlice[], igstOnly: boolean): TaxHeads[] {
  const doc = splitTaxHeads(slices.reduce((s, x) => s + x.gst, 0), igstOnly);
  const heads = slices.map((s) => splitTaxHeads(s.gst, igstOnly));
  const rest = heads.slice(0, -1).reduce((a, h) => ({ igst: a.igst + h.igst, cgst: a.cgst + h.cgst, sgst: a.sgst + h.sgst }), { igst: 0, cgst: 0, sgst: 0 });
  if (heads.length) heads[heads.length - 1] = { igst: doc.igst - rest.igst, cgst: doc.cgst - rest.cgst, sgst: doc.sgst - rest.sgst };
  return heads;
}

/**
 * What a report row shows as "the rate" of a document: the rate of its one slice, or — when
 * its lines carry different rates — the highest one plus the full list (`rates`, lowest first).
 */
export function docRates(
  doc: { taxableValue: number; gst: number; taxRate: number },
  shares: readonly { taxable: number; rate?: number | null }[] | null | undefined,
): { taxRate: number; rates?: number[] } {
  const slices = rateSlices(doc, shares);
  if (!isMixedRate(slices)) return { taxRate: slices[0].rate };
  return { taxRate: slices[slices.length - 1].rate, rates: slices.map((s) => s.rate) };
}

/** "0% + 18%" — rates, as given (lowest first from every helper here). */
export function rateLabel(rates: readonly number[]): string {
  return rates.map((r) => `${r}%`).join(" + ");
}

/** The rate text beside an invoice's tax total on screen: every line rate ("0% + 18%") when
 *  the invoice carries line rates, else the one rate the screen already had. */
export function invoiceRateText(inv: { line_items?: unknown }, fallbackRate: number): string {
  const rates = lineRateSet(Array.isArray(inv.line_items) ? (inv.line_items as RateSourceLine[]) : null);
  return rates ? rateLabel(rates) : `${fallbackRate}%`;
}

/**
 * The "Tax" cell of the GST output table. One rate → the words it always showed. Several
 * rates → every rate named ("IGST 0% + 18%", "CGST + SGST 0% + 18%"), never just one of them.
 */
export function outputRateLabel(r: { isExport: boolean; gst: number; interState: boolean; taxRate: number; rates?: readonly number[] }): string {
  const many = r.rates && r.rates.length > 1 ? rateLabel(r.rates) : null;
  if (r.isExport) return r.gst ? `Export · IGST ${many ?? `${r.taxRate}%`}` : "Export · LUT (0%)";
  if (r.interState) return `IGST ${many ?? `${r.taxRate}%`}`;
  return many ? `CGST + SGST ${many}` : `CGST ${r.taxRate / 2}% + SGST ${r.taxRate / 2}%`;
}

// ─── Credit / debit note on an invoice that carries line rates ───────────────

/** The invoice columns the note split reads. */
export interface NoteInvoiceRow { taxable_value: number | null; tax_amount: number | null; tax_rate: number | null; line_items?: unknown }

/**
 * How a credit / debit note on this invoice is split — the TS twin of SQL
 * `invoice_note_gst_split`, for the dialog's preview:
 *   · "rate"    one rate: taxable = round(gross × 100 ÷ (100 + rate)). The rate is the one
 *               rate all its lines carry, else invoices.tax_rate, else 18 (as before).
 *   · "mixed"   lines at different rates: the note follows the invoice — taxable =
 *               round(gross × invoice taxable ÷ (invoice taxable + invoice GST)).
 *   · "refused" different rates but no taxable / GST on the invoice: the note cannot be split.
 */
export type NoteSplitRule =
  | { kind: "rate"; rate: number }
  | { kind: "mixed"; rates: number[]; taxableValue: number; taxAmount: number }
  | { kind: "refused"; rates: number[] };

export function noteSplitRule(inv: NoteInvoiceRow): NoteSplitRule {
  const rates = lineRateSet(Array.isArray(inv.line_items) ? (inv.line_items as RateSourceLine[]) : null);
  if (rates && rates.length > 1) {
    const t = inv.taxable_value, g = inv.tax_amount;
    if (t == null || g == null || t < 0 || g < 0 || t + g <= 0) return { kind: "refused", rates };
    return { kind: "mixed", rates, taxableValue: t, taxAmount: g };
  }
  return { kind: "rate", rate: rates?.length === 1 ? rates[0] : inv.tax_rate ?? 18 };
}

/** Taxable + GST of a note of `gross` under that rule (null when refused). */
export function noteSplit(gross: number, rule: NoteSplitRule): { taxable: number; tax: number } | null {
  if (rule.kind === "refused") return null;
  const taxable = rule.kind === "mixed"
    ? Math.round((gross * rule.taxableValue) / (rule.taxableValue + rule.taxAmount))
    : rule.rate === 0 ? gross : Math.round((gross * 100) / (100 + rule.rate));
  return { taxable, tax: gross - taxable };
}

/** The dialog's line under the amount for a note on a mixed-rate invoice. */
export function noteMixedSplitText(a: { rates: readonly number[]; interState: boolean; taxable: string; tax: string }): string {
  return `This invoice has lines at different GST rates (${rateLabel(a.rates)}). `
    + `The note is split like the invoice: taxable ${a.taxable} + ${a.interState ? "IGST" : "CGST + SGST"} ${a.tax}.`;
}

/** …and when it cannot be split (the RPC refuses with the same reason). */
export function noteRefusedText(rates: readonly number[]): string {
  return `This invoice has lines at different GST rates (${rateLabel(rates)}) but no taxable value and GST on record, `
    + `so a note cannot be split. Correct the invoice first.`;
}

// ─── Invoice PDF ─────────────────────────────────────────────────────────────

export interface PdfTaxRow { label: string; amount: number }

/**
 * The tax rows of a mixed-rate invoice PDF: one per rate and head, each naming the taxable
 * value it is charged on. Null for a single-rate invoice — the PDF keeps its one row.
 * Heads per rate from `sliceHeads` — the same figures GSTR-1 files.
 */
export function pdfTaxRows(
  slices: readonly RateSlice[],
  igstOnly: boolean,
  money: (inr: number) => string,
): PdfTaxRow[] | null {
  if (!isMixedRate(slices)) return null;
  const heads = sliceHeads(slices, igstOnly);
  const rows: PdfTaxRow[] = [];
  slices.forEach((s, i) => {
    const on = `on ${money(s.taxable)}`;
    if (igstOnly) rows.push({ label: `IGST @ ${s.rate}% ${on}`, amount: heads[i].igst });
    else {
      rows.push({ label: `CGST @ ${s.rate / 2}% ${on}`, amount: heads[i].cgst });
      rows.push({ label: `SGST @ ${s.rate / 2}% ${on}`, amount: heads[i].sgst });
    }
  });
  return rows;
}
