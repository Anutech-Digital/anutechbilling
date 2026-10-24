/**
 * R-086: where one invoice lives. Every in-folder link to an invoice goes through here, so
 * the address has one spelling.
 *
 * The id is encoded because invoice numbers come from a tenant-configurable document
 * series (CLAUDE.md §17a), and a prefix with a "/" (e.g. "ANU/26-27/001") would otherwise
 * split into two path segments and 404.
 */
export function invoiceHref(invoiceId: string): `/invoices/${string}` {
  return `/invoices/${encodeURIComponent(invoiceId)}`;
}

/**
 * R-1640: where "New invoice" goes — the direct-invoice builder (the quote builder in invoice
 * mode), the same place Ctrl+K "Create invoice" opens. Never the quotes list.
 */
export const NEW_INVOICE_HREF = "/quotes/new?invoice=1" as const;

/**
 * R-1640: the invoice generate_invoice just raised. Its number came back, so "Open invoice"
 * opens that invoice; only a missing number falls back to the list.
 */
export function raisedInvoiceHref(invoiceId: string | null | undefined): `/invoices/${string}` | "/invoices" {
  const id = invoiceId?.trim();
  return id ? invoiceHref(id) : "/invoices";
}

/**
 * The old deep link was `/invoices?open=<id>`; links of that shape are already in
 * WhatsApp messages, emails, the command palette, quotes and payments. The list page sends
 * them here. Returns null when there is nothing to redirect (no or blank `open`).
 */
export function legacyOpenRedirect(open: string | null): `/invoices/${string}` | null {
  const id = open?.trim();
  return id ? invoiceHref(id) : null;
}

/**
 * The `[id]` segment as the invoice id. Next.js hands the segment over already decoded in
 * most cases; decoding again is harmless for plain ids and recovers a still-encoded one.
 * A malformed escape is kept as written rather than thrown, so the page can say "not found".
 */
export function invoiceIdFromParam(param: string | string[] | undefined): string {
  const raw = Array.isArray(param) ? param.join("/") : (param ?? "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
