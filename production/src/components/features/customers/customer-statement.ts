/**
 * The customer Statement tab (Zoho "Statement") — a running balance of what the customer owes.
 *
 * R-1682 (staging T-19, 19 Oct 2026): INV ₹7,646 billed, ₹7,646 paid, cancelled, credit note
 * ₹6,372. The Statement showed only +7,646 and −7,646 (closing ₹0) while the overview said
 * "₹6,372 credit": credit notes and debit notes were not on it at all, and a refunded payment
 * showed only the refund (its receipt vanished), so a refund made the customer look as if they
 * owed it again.
 *
 * Now, the same entries the books' customer ledger uses (src/lib/accounting/reports-reference.ts,
 * referenceCustomerLedgerEntries):
 *   invoice        debit (owed)
 *   debit note     debit
 *   payment        credit — every payment, refunded or not (the money did come in)
 *   credit note    credit
 *   refund         debit  — on the refund date (money went back)
 *   project receipt credit
 * closing = invoices + debit notes − payments − credit notes + refunds. Positive = the customer
 * owes; negative = the company owes the customer (open credit to use or refund).
 *
 * R-1632 (weekly audit 19 Oct 2026) — the same closing as /collections (invoiceAmountDue per
 * invoice) minus the customer's open credit:
 *   - a VOID or DRAFT invoice is not owed: no line (and no line for a note against it);
 *   - a WRITTEN-OFF invoice (R-1635) stays on as issued, and a "Written off" credit line on
 *     the write-off date clears what was still due on it (invoiceAmountDue before the
 *     write-off) — /collections asks for nothing on it;
 *   - a payment counts the CASH that came in (cashReceived: amount − credit_applied, R-1565);
 *     the credit it spent was already counted on the payment that created it. A refund gives
 *     back that same cash;
 *   - payments belong to the customer by the /payments rule (paymentBelongsTo: own
 *     customer_id, else the customer on its quote) — statementPayments().
 *
 * R-2884: the arithmetic (buildCustomerStatement and what it needs) moved to
 * src/lib/customers/statement-core.ts — pure and server-safe, so Help AI reads the same number. This
 * file keeps the React hook and re-exports everything, so no caller changed.
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { paymentBelongsTo, type ScopablePayment } from "@/app/(app)/payments/customer-scope";

export {
  groupProjectReceipts, statementBalanceText, buildCustomerStatement, statementUninvoicedDues, uninvoicedSubscriptionDue, outstandingFromClosing,
} from "@/lib/customers/statement-core";
export type {
  StatementLink, StatementRow, StatementProjectPayment, StatementInput, StatementUninvoicedDue, StatementSubscription,
} from "@/lib/customers/statement-core";

/**
 * R-1632: this customer's payments by the /payments rule (paymentBelongsTo) — its own
 * customer_id, or, when that is empty (taken before the lead was converted), the customer
 * on its quote. `quoteIds` = this customer's quotes.
 */
export function statementPayments<P extends ScopablePayment>(
  payments: readonly P[],
  customerId: string,
  quoteIds: Iterable<string>,
): P[] {
  const mine = new Set(quoteIds);
  return payments.filter((p) => paymentBelongsTo(p, customerId, (id) => (mine.has(id) ? customerId : null)));
}

export interface CustomerNotes {
  creditNotes: { id: string; invoice_id: string | null; credit_date: string; amount: number; reason: string | null }[];
  debitNotes: { id: string; invoice_id: string | null; debit_date: string; amount: number; reason: string | null }[];
}

/** Credit + debit notes of one customer (RLS keeps it to the signed-in company). */
export function useCustomerNotes(customerId: string | null | undefined) {
  return useQuery({
    queryKey: ["credit-notes", "by-customer", customerId],
    enabled: !!customerId,
    queryFn: async (): Promise<CustomerNotes> => {
      const supabase = createClient();
      const [cn, dn] = await Promise.all([
        supabase.from("credit_notes").select("id, invoice_id, credit_date, amount, reason").eq("customer_id", customerId!),
        supabase.from("debit_notes").select("id, invoice_id, debit_date, amount, reason").eq("customer_id", customerId!),
      ]);
      if (cn.error) throw cn.error;
      if (dn.error) throw dn.error;
      return {
        creditNotes: (cn.data ?? []) as CustomerNotes["creditNotes"],
        debitNotes: (dn.data ?? []) as CustomerNotes["debitNotes"],
      };
    },
  });
}
