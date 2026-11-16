/**
 * R-2544 — which of a customer's invoices are subscription instalments (R-1564/R-1636: an
 * instalment has no quote of its own; its receipts sit on its subscription's quote). One paged
 * read for the whole customer — never one per invoice. The caller maps subscription → quote from
 * the subscriptions it already has. Key under ["invoices"] so an invoice refresh refreshes it too.
 * R-2853: the same rows carry the part's period + its subscription's cycle / term, for the
 * "Part 2 of 12 · 1–31 Oct 2026" line under the invoice number — no second read.
 */
import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRowsIn } from "@/lib/ops/fetch-all";
import type { InvoicePartRow } from "@/lib/invoices/invoice-period";
import { INVOICE_PART_COLS, toInvoicePartRow } from "./invoice-part-periods";

export interface InstalmentBilling extends InvoicePartRow { invoice_id: string; subscription_id: string }

export function useCustomerInstalmentBillings(subscriptionIds: readonly string[]) {
  const ids = [...new Set(subscriptionIds)].sort();
  return useQuery({
    queryKey: ["invoices", "instalment-billings", ids.join(",")],
    enabled: ids.length > 0,
    queryFn: async (): Promise<InstalmentBilling[]> => {
      const loose = createClient() as unknown as SupabaseClient;
      const rows = await fetchAllRowsIn<Parameters<typeof toInvoicePartRow>[0], string>(ids, (run, from, to) =>
        loose
          .from("subscription_billings")
          .select(INVOICE_PART_COLS)
          .in("subscription_id", run)
          .not("invoice_id", "is", null)
          .order("id", { ascending: true })
          .range(from, to));
      return rows.flatMap((b) => (b.invoice_id ? [{ ...toInvoicePartRow(b), invoice_id: b.invoice_id }] : []));
    },
  });
}
