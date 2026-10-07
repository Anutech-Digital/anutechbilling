/**
 * R-334 — export under a Letter of Undertaking (LUT), the paperwork half.
 *
 * The app already zero-rates an export (recipient outside India → tax_rate 0, no IGST).
 * What it did not do is SAY so the way CGST Rule 46 asks: an export invoice issued
 * without payment of integrated tax must carry the endorsement below, and the LUT it
 * relies on is identified by its ARN (stored in Settings → Company → LUT number).
 *
 * This module decides WORDS only. It never changes a tax amount — the 0% decision stays
 * where it was (quote builder / place-of-supply).
 */

/** The Rule 46 endorsement for an export without payment of IGST, verbatim. */
export const EXPORT_LUT_ENDORSEMENT =
  "SUPPLY MEANT FOR EXPORT UNDER LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX";

/** A zero-rated export: recipient outside India and no tax charged on the document. */
export function isZeroRatedExport(args: { isExport: boolean; tax: number }): boolean {
  return args.isExport && args.tax === 0;
}

function clean(lut: string | null | undefined): string | null {
  const v = (lut ?? "").trim();
  return v ? v : null;
}

/**
 * What the invoice prints under the totals. `null` = nothing (not a zero-rated export).
 * The ARN line is present only when the seller actually has one on file — the PDF must
 * not invent an LUT that does not exist.
 */
export function exportEndorsement(args: {
  isExport: boolean;
  tax: number;
  lutNumber?: string | null;
}): { text: string; lutArn: string | null } | null {
  if (!isZeroRatedExport(args)) return null;
  return { text: EXPORT_LUT_ENDORSEMENT, lutArn: clean(args.lutNumber) };
}

/**
 * The warning shown when a zero-rated export invoice is issued and the seller has no LUT
 * number saved. A warning, never a block: the invoice is already issued and the owner may
 * hold an LUT they have simply not typed in yet.
 *
 * `taxRate === 0` is how an export is recorded on a quote/invoice in this app (the
 * invoices page and credit-note dialog read it the same way).
 */
export function lutMissingWarning(args: {
  taxRate: number | null | undefined;
  lutNumber: string | null | undefined;
}): string | null {
  if (args.taxRate !== 0) return null;
  if (clean(args.lutNumber)) return null;
  return "Export invoice issued at 0% GST, but no LUT number is saved. "
    + "Without a valid LUT, IGST is payable on this export. "
    + "Add your LUT ARN in Settings → Company (file Form GST RFD-11 on gst.gov.in if you have none).";
}
