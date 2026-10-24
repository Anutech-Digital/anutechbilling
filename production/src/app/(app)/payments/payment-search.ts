/**
 * R-1639: what the /payments search box matches. An accountant searches by the number on the
 * paper in front of them — the receipt voucher (RV-…) or the GST invoice the money paid —
 * as well as the quote, the bank reference, the method, the customer and the amount.
 *
 * The page already holds every payment (usePayments pages past the 1000-row cap), so this
 * runs in the browser over the whole list.
 */
import { paymentMethodLabel } from "./method-label";

export interface SearchablePayment {
  quote_id: string | null;
  invoice_id: string | null;
  reference: string | null;
  method: string | null;
  receipt_voucher_no: string | null;
  amount: number | null;
}

export interface PaymentSearchContext {
  /** Whose payment it is (payment-customer.ts paymentCustomerLookup). */
  customerName: string | null;
  /** The invoice it is on — the quote's GST invoice, or an imported invoice's own number. */
  invoiceNumber: string | null;
}

export function paymentMatchesSearch(p: SearchablePayment, query: string, ctx: PaymentSearchContext): boolean {
  const s = query.trim().toLowerCase();
  if (!s) return true;
  const fields = [
    p.quote_id, p.invoice_id, ctx.invoiceNumber, p.receipt_voucher_no, p.reference,
    p.method, p.method ? paymentMethodLabel(p.method) : null, ctx.customerName,
  ];
  if (fields.some((f) => !!f && f.toLowerCase().includes(s))) return true;
  const digits = s.replace(/[,\s₹]/g, "");
  return /^\d+(\.\d{1,2})?$/.test(digits) && p.amount != null && Number(digits) === Number(p.amount);
}
