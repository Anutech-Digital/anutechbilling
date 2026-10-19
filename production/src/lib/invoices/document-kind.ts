/**
 * R-1529 — Tax Invoice or Bill of Supply?
 *
 * A business that is not GST-registered, or is a composition taxable person (CGST Section
 * 10), cannot issue a Tax Invoice. It issues a BILL OF SUPPLY (Section 31(3)(c), Rule 49):
 * no CGST/SGST/IGST, its own number series (BOS-…), and — for composition — the words
 * "composition taxable person, not eligible to collect tax on supplies".
 *
 * The decision is made ONCE, in the database, when the document is issued
 * (migration 20261018022629_r1529_bill_of_supply: trg_invoice_document_kind writes
 * `invoices.document_kind` and `invoices.supplier_gst_status` and freezes them). Everything
 * here only READS that frozen fact off the invoice row — never today's Settings, which may
 * have changed since (owner decision q4: earlier Bills of Supply stay as they are).
 *
 * Rows issued before R-1529 have no `document_kind` in older reads and were all Tax
 * Invoices, so absent means tax invoice.
 */

export type DocumentKind = "tax_invoice" | "bill_of_supply";
export type SupplierGstStatus = "registered" | "unregistered" | "composition";

/** The fields this module reads. `Invoice` satisfies it structurally. */
export interface DocumentKindFields {
  document_kind?: string | null;
  supplier_gst_status?: string | null;
}

export function documentKindOf(inv: DocumentKindFields | null | undefined): DocumentKind {
  return inv?.document_kind === "bill_of_supply" ? "bill_of_supply" : "tax_invoice";
}

export function isBillOfSupply(inv: DocumentKindFields | null | undefined): boolean {
  return documentKindOf(inv) === "bill_of_supply";
}

/** The supplier's GST status frozen on the document; null for pre-R-1529 rows. */
export function supplierGstStatusOf(inv: DocumentKindFields | null | undefined): SupplierGstStatus | null {
  const s = inv?.supplier_gst_status;
  return s === "registered" || s === "unregistered" || s === "composition" ? s : null;
}

/** The document's title — what the customer reads at the top of the page. */
export function documentTitle(inv: DocumentKindFields | null | undefined): "Tax Invoice" | "Bill of Supply" {
  return isBillOfSupply(inv) ? "Bill of Supply" : "Tax Invoice";
}

/** Section 10 / Rule 5(1)(g) wording — printed at the TOP of every composition Bill of Supply (q5). */
export const COMPOSITION_DECLARATION =
  "Composition taxable person, not eligible to collect tax on supplies";

/** Printed on an unregistered supplier's Bill of Supply. */
export const UNREGISTERED_DECLARATION =
  "Supplier is not registered under GST — no GST is charged on this bill";

/**
 * The declaration lines a Bill of Supply carries under its title (empty for a Tax
 * Invoice). Composition gets the statutory sentence; unregistered says why there is no GST.
 */
export function billOfSupplyDeclarations(inv: DocumentKindFields | null | undefined): string[] {
  if (!isBillOfSupply(inv)) return [];
  const status = supplierGstStatusOf(inv);
  const lines = [status === "composition" ? COMPOSITION_DECLARATION : UNREGISTERED_DECLARATION];
  lines.push("Bill of Supply under Section 31(3)(c) of the CGST Act read with Rule 49.");
  return lines;
}

/**
 * The recipient's state on a Bill of Supply — "Karnataka (29)", no GST head (there is no
 * tax to split). From the place of supply frozen on the invoice, else the customer's state,
 * else "—".
 */
export function billOfSupplyPlace(
  posCode: string | null | undefined,
  stateByCode: Record<string, string>,
  fallbackState?: string | null,
): string {
  const code = (posCode ?? "").trim();
  const name = code ? stateByCode[code] : undefined;
  if (name) return `${name} (${code})`;
  return fallbackState?.trim() || "—";
}

/**
 * GSTR-1 / GST payable take Tax Invoices only (q5: a Bill of Supply is in the P&L, never in
 * a GST return). One predicate, so every report filters the same way.
 */
export function isTaxInvoiceRow(row: DocumentKindFields): boolean {
  return documentKindOf(row) === "tax_invoice";
}
