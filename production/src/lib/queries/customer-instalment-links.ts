/**
 * R-2544 — which of a customer's invoices are subscription instalments (R-1564/R-1636: an
 * instalment has no quote of its own; its receipts sit on its subscription's quote). One paged
 * read for the whole customer — never one per invoice. The caller maps subscription → quote from
 * the subscriptions it already has. Key under ["invoices"] so an invoice refresh refreshes it too.
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRowsIn } from "@/lib/ops/fetch-all";

export interface InstalmentBilling { invoice_id: string; subscription_id: string }

export function useCustomerInstalmentBillings(subscriptionIds: readonly string[]) {
  const ids = [...new Set(subscriptionIds)].sort();
  return useQuery({
    queryKey: ["invoices", "instalment-billings", ids.join(",")],
    enabled: ids.length > 0,
    queryFn: async (): Promise<InstalmentBilling[]> => {
      const supabase = createClient();
      const rows = await fetchAllRowsIn<{ invoice_id: string | null; subscription_id: string }, string>(ids, (run, from, to) =>
        supabase
          .from("subscription_billings")
          .select("invoice_id, subscription_id")
          .in("subscription_id", run)
          .not("invoice_id", "is", null)
          .order("id", { ascending: true })
          .range(from, to));
      return rows.flatMap((b) => (b.invoice_id ? [{ invoice_id: b.invoice_id, subscription_id: b.subscription_id }] : []));
    },
  });
}
