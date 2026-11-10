/**
 * R-2542 — the receipts of an invoice that takes them with NO quote (a Zoho opening invoice or an
 * FY sale imported from Zoho — lib/payments/quoteless-receipt.ts). Such a receipt carries the
 * invoice itself (payments.invoice_id, quote_id NULL), so usePaymentsByQuote never finds it and the
 * invoice page said "No payment receipts recorded" after the bank line paid it.
 * Key under ["payments"] — invalidateReceivables() refreshes it with every other payment read.
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { PAYMENT_COLUMNS } from "@/lib/queries/columns";
import type { Payment } from "@/lib/supabase/database.types";

export function useQuotelessReceipts(invoiceId: string | null | undefined) {
  return useQuery({
    queryKey: ["payments", "by-quoteless-invoice", invoiceId],
    enabled: !!invoiceId,
    queryFn: async (): Promise<Payment[]> => {
      const { data, error } = await createClient()
        .from("payments")
        .select(PAYMENT_COLUMNS)
        .eq("invoice_id", invoiceId!)
        .is("quote_id", null)
        .order("received_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Payment[];
    },
  });
}
