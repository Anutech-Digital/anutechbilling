/**
 * R-238: the one word an invoice's status badge shows, on the list AND on /invoices/<id>.
 *
 * The page used to print `invoice.status` raw, so an invoice 40 days past due read "pending"
 * there while the list beside it said "Overdue 40d" (nothing writes status = 'overdue';
 * lib/invoices/overdue.ts derives it). Both screens now ask this function.
 *
 * "Partial" is display-only too: money is already in (advance receipts adjusted, or
 * paid_amount from milestone receipts) but the invoice is not settled.
 */
import { invoiceBucket, invoiceOverdueDays, type OverdueInvoice } from "@/lib/invoices/overdue";
import { istToday } from "@/lib/dates/ist";

export type InvoiceBadgeKind = "success" | "warning" | "danger" | "muted";

export interface InvoiceStatusRow extends OverdueInvoice {
  adjusted_advances?: unknown;
}

export function invoiceStatusBadge(
  inv: InvoiceStatusRow,
  today: string = istToday(),
): { label: string; kind: InvoiceBadgeKind } | null {
  const hasAdvances = Array.isArray(inv.adjusted_advances) && inv.adjusted_advances.length > 0;
  const partial = (hasAdvances || (inv.paid_amount ?? 0) > 0) && inv.status !== "paid";
  const bucket = invoiceBucket(inv, today);
  if (bucket === "paid") return { label: "Paid", kind: "success" };
  if (bucket === "pending") return { label: partial ? "Partial" : "Pending", kind: "warning" };
  if (bucket === "overdue") {
    const lateBy = invoiceOverdueDays(inv, today);
    return { label: partial ? `Overdue · Partial · ${lateBy}d` : `Overdue ${lateBy}d`, kind: "danger" };
  }
  if (bucket === "draft") return { label: "Draft", kind: "muted" };
  if (bucket === "void") return { label: "Void", kind: "muted" };
  return null;
}
