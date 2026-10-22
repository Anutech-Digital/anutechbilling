/**
 * R-1745 — whose payment is it? One answer for every place that names a payment's customer.
 *
 * Most payments are keyed by their quote. A payment on an invoice imported from Zoho Books
 * (R-1739) has no quote — payments.quote_id NULL, payments.invoice_id set — and the /payments
 * list, its phone cards, search, sort, Export CSV and the receipt voucher (and its PDF) read the
 * name from the quote only, so such a payment showed "—".
 *
 * Order: the payment's quote → its invoice → its own customer_id. The customer record's current
 * name wins over the name copied onto the quote / invoice (a renamed customer reads the same
 * everywhere). Nothing known → null; the screen shows its own dash, never a guessed name.
 */
import type { PaymentSource } from "./payment-source";

export interface PaymentCustomerSource extends PaymentSource {
  customer_id?: string | null;
}

export interface PaymentCustomer {
  customerId: string | null;
  customerName: string | null;
}

interface DocCustomer {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
}

export function paymentCustomerLookup(lists: {
  quotes: ReadonlyArray<DocCustomer>;
  invoices: ReadonlyArray<DocCustomer>;
  customers: ReadonlyArray<{ id: string; name: string | null }>;
}): (p: PaymentCustomerSource) => PaymentCustomer {
  const quotes = new Map(lists.quotes.map((q) => [q.id, q]));
  const invoices = new Map(lists.invoices.map((i) => [i.id, i]));
  const customers = new Map(lists.customers.map((c) => [c.id, c.name]));

  const fromDoc = (doc: DocCustomer | undefined): PaymentCustomer | null => {
    if (!doc) return null;
    const name = (doc.customer_id ? customers.get(doc.customer_id) : null) ?? doc.customer_name;
    if (!doc.customer_id && !name) return null;
    return { customerId: doc.customer_id, customerName: name || null };
  };

  return (p) =>
    fromDoc(p.quote_id ? quotes.get(p.quote_id) : undefined)
    ?? fromDoc(p.invoice_id ? invoices.get(p.invoice_id) : undefined)
    ?? (p.customer_id
      ? { customerId: p.customer_id, customerName: customers.get(p.customer_id) ?? null }
      : { customerId: null, customerName: null });
}

/** Invoice ids the lookup needs: payments recorded on an invoice, not a quote. */
export function quotelessInvoiceIds(payments: ReadonlyArray<PaymentSource>): string[] {
  return [...new Set(payments.filter((p) => !p.quote_id && p.invoice_id).map((p) => p.invoice_id as string))];
}
