/**
 * R-445 — what the invoice page's Line items panel shows.
 *
 * The page reads the parent quote's items first and the invoice's own items second. While
 * the quote was still loading, an invoice with no items of its own showed the "no items"
 * fallback ("Standard Subscription License Supply") for a second or two, and then the real
 * "Google Workspace Business Starter × 5" — the placeholder looked like real data. Now the
 * panel shows a skeleton until the quote has answered.
 */
export type InvoiceLineItemsView<T> =
  | { state: "loading" }
  | { state: "items"; items: T[] }
  | { state: "empty" };

export function invoiceLineItemsView<T>(
  quoteLoading: boolean,
  quoteItems: T[] | null | undefined,
  invoiceItems: T[] | null | undefined,
): InvoiceLineItemsView<T> {
  const items = quoteItems ?? invoiceItems ?? [];
  if (quoteLoading && (quoteItems == null || quoteItems.length === 0) && (invoiceItems == null || invoiceItems.length === 0)) {
    return { state: "loading" };
  }
  return items.length > 0 ? { state: "items", items } : { state: "empty" };
}
