/**
 * R-1747 — the description line of a receipt voucher (screen and PDF read it from here).
 *
 * A payment against an invoice imported from Zoho Books is money against an old invoice whose
 * GST was charged and filed there — not an advance. Its receipt says so and carries no GST split
 * (advance: false). Every other receipt is the GST advance receipt voucher, as before.
 */
export interface ReceiptLine {
  description: string;
  /** true = GST advance receipt (taxable + CGST/SGST or IGST shown); false = plain payment receipt. */
  advance: boolean;
}

export function receiptLine(input: { quoteId?: string | null; openingInvoiceNumber?: string | null }): ReceiptLine {
  if (input.openingInvoiceNumber) {
    return { description: `Received against invoice ${input.openingInvoiceNumber} (opening balance)`, advance: false };
  }
  return { description: `Advance received against ${input.quoteId ? `quote ${input.quoteId}` : "service"}`, advance: true };
}
