/**
 * R-1532 — quotes of a business that issues a Bill of Supply.
 *
 * R-1529 made the DATABASE refuse GST on a Bill of Supply: a business that is not
 * GST-registered, or is under the composition scheme, cannot charge CGST/SGST/IGST, and an
 * invoice from a quote that carries GST is stopped at issue. The quote side still started
 * every quote at 18%, so such a business had to change every quote to 0% by hand.
 *
 * One rule, used by the builder, the server quote paths (renewal, extension, auto quotes),
 * the quote PDF, the accept page and the quote email:
 *   - the business issues a Bill of Supply  → new quotes start at 0% GST, the rate is locked;
 *   - the documents show one "No GST — Bill of Supply" line, never CGST/SGST/IGST rows.
 * Registered businesses (and a business that never chose — R-1529 treats it as registered)
 * are unchanged. Existing quotes are not rewritten: a document only shows the Bill of Supply
 * line when the quote itself carries 0% GST.
 *
 * Pure: no React, no client.
 */
import { issuesBillOfSupply, toGstRegistration } from "@/lib/compliance/gst-registration";

export type BillOfSupplyStatus = "unregistered" | "composition";

/** The tenant's saved GST registration, narrowed to "issues a Bill of Supply" — else null. */
export function billOfSupplyStatus(saved: unknown): BillOfSupplyStatus | null {
  const s = toGstRegistration(saved);
  return issuesBillOfSupply(s) ? (s as BillOfSupplyStatus) : null;
}

/** The GST rate a NEW quote starts at: 0 for a Bill of Supply business, else `usual` (18). */
export function quoteStartTaxRate(saved: unknown, usual = 18): number {
  return billOfSupplyStatus(saved) ? 0 : usual;
}

/**
 * The GST rate a quote is saved with. A Bill of Supply business can never raise it above 0
 * (the database refuses the invoice otherwise); an export is zero-rated; else the chosen rate.
 */
export function quoteEffectiveTaxRate(args: { saved: unknown; isExport: boolean; taxRate: number }): number {
  if (args.isExport || billOfSupplyStatus(args.saved)) return 0;
  return args.taxRate;
}

/** Staff wording (quote builder): the one line under the totals. */
export function billOfSupplyBuilderLine(status: BillOfSupplyStatus): string {
  return status === "composition"
    ? "No GST — Bill of Supply (your business is under the GST composition scheme)"
    : "No GST — Bill of Supply (your business is not GST-registered)";
}

/** Customer wording (quote PDF, accept page, email): said about the supplier, not "your business". */
export function billOfSupplyCustomerLine(status: BillOfSupplyStatus): string {
  return status === "composition"
    ? "No GST — Bill of Supply (composition taxable person, not eligible to collect tax on supplies)"
    : "No GST — Bill of Supply (supplier is not registered under GST)";
}

/**
 * Should THIS quote's document print the Bill of Supply line instead of GST rows?
 * Only when the business issues a Bill of Supply AND the quote carries no GST — an older
 * quote saved at 18% keeps showing exactly what it says (it is not rewritten).
 */
export function quoteDocBillOfSupply(saved: unknown, taxRate: number | null | undefined): BillOfSupplyStatus | null {
  const status = billOfSupplyStatus(saved);
  return status && Number(taxRate ?? 0) === 0 ? status : null;
}

/**
 * The place of supply on a Bill of Supply quote: the buyer's state only — there is no tax to
 * split, so "· IGST" / "· CGST + SGST" is dropped. A label that is only a head ("Intra-state
 * (CGST + SGST)") becomes "—".
 */
export function billOfSupplyPlaceLabel(label: string | null | undefined): string {
  const l = (label ?? "")
    .replace(/\s*·\s*(IGST|CGST \+ SGST|GST head pending \(company state not set\))\s*$/, "")
    .trim();
  if (!l || /^(Inter|Intra)-state\b/.test(l) || /^GST head pending/.test(l)) return "—";
  return l;
}

/** R-1523's Proforma line, for a business that will issue a Bill of Supply instead of a tax invoice. */
export const PROFORMA_NOTICE_BILL_OF_SUPPLY = "This is not a tax invoice. A Bill of Supply will be issued on payment.";
