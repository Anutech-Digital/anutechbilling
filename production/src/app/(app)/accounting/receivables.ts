/**
 * R-371 — rows for the Accounting "Owed to you" folder.
 *
 * The balance is `invoiceAmountDue` (lib/payments/amount-due): net_payable — the amount
 * after credit notes and advances adjusted at issue — minus receipts since. The page used
 * `amount − paid_amount`, which overstated every invoice that had a credit note or an
 * advance (INV-9B8C-2026-27-0003: ₹11,800 shown, ₹10,620 owed).
 *
 * Same statuses the dunning cron chases (pending / overdue), so the folder and the
 * reminder engine agree on who owes money AND how much.
 */
import { invoiceAmountDue, type InvoiceBalanceFields } from "@/lib/payments/amount-due";

export interface ReceivableInvoice extends InvoiceBalanceFields {
  status: string;
  due_date: string | null;
}

export interface ReceivableRow { amountDue: number; daysOverdue: number }

/** `today` is a YYYY-MM-DD IST date. Rows with nothing owed are dropped. */
export function receivableRows(invoices: readonly ReceivableInvoice[], today: string): ReceivableRow[] {
  const todayMs = Date.parse(`${today}T00:00:00+05:30`);
  return invoices
    .filter((i) => i.status === "pending" || i.status === "overdue")
    .map((i) => ({
      amountDue: invoiceAmountDue(i),
      daysOverdue: i.due_date
        ? Math.round((todayMs - Date.parse(`${i.due_date.slice(0, 10)}T00:00:00+05:30`)) / 86_400_000)
        : 0,
    }))
    .filter((r) => r.amountDue > 0);
}
