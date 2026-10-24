/**
 * R-238: the one word an invoice's status badge shows, on the list AND on /invoices/<id>.
 *
 * The page used to print `invoice.status` raw, so an invoice 40 days past due read "pending"
 * there while the list beside it said "Overdue 40d" (nothing writes status = 'overdue';
 * lib/invoices/overdue.ts derives it). Both screens now ask this function.
 *
 * "Partial" is display-only too: money is already in (advance receipts adjusted, or
 * paid_amount from milestone receipts) but the invoice is not settled.
 *
 * R-1709: the money part comes from lib/invoices/payment-state.ts — the same state the
 * /invoices chips and "Paid this month" read. A paid invoice that a credit note closed reads
 * "Credited", not "Paid" (pass its note totals; without them it stays "Paid").
 */
import { invoiceBucket, invoiceOverdueDays, type OverdueInvoice } from "@/lib/invoices/overdue";
import { invoicePaymentState } from "@/lib/invoices/payment-state";
import type { NoteTotals } from "@/lib/invoices/note-totals";
import { istToday } from "@/lib/dates/ist";

export type InvoiceBadgeKind = "success" | "warning" | "danger" | "muted" | "info";

export interface InvoiceStatusRow extends OverdueInvoice {
  adjusted_advances?: unknown;
}

export function invoiceStatusBadge(
  inv: InvoiceStatusRow,
  today: string = istToday(),
  /** This invoice's credit / debit note totals. Undefined = not read (never "Credited"). */
  notes?: NoteTotals | null,
): { label: string; kind: InvoiceBadgeKind } | null {
  const state = invoicePaymentState({
    ...inv,
    credit_noted: notes === undefined ? undefined : notes?.credit ?? 0,
    debit_noted: notes?.debit ?? 0,
  });
  const partial = state === "partial";
  const bucket = invoiceBucket(inv, today);
  if (bucket === "paid") return state === "credited" ? { label: "Credited", kind: "info" } : { label: "Paid", kind: "success" };
  /* R-1635: written off on /payments — still issued, no longer collected or chased. */
  if (inv.written_off_at && bucket !== "void") return { label: "Written off", kind: "muted" };
  if (bucket === "pending") return { label: partial ? "Partial" : "Pending", kind: "warning" };
  if (bucket === "overdue") {
    const lateBy = invoiceOverdueDays(inv, today);
    return { label: partial ? `Overdue · Partial · ${lateBy}d` : `Overdue ${lateBy}d`, kind: "danger" };
  }
  if (bucket === "draft") return { label: "Draft", kind: "muted" };
  if (bucket === "void") return { label: "Void", kind: "muted" };
  return null;
}
