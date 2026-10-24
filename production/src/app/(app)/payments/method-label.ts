/* R-1715: the one payment-method map lives in lib/payments/method-label.ts (shared by quotes,
   invoices, PDFs and accounting). Kept here so existing imports keep working. */
export { paymentMethodLabel } from "@/lib/payments/method-label";
