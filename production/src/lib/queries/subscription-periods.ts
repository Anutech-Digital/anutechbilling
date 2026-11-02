/**
 * R-2382 — the split-billing period that contains today, for every subscription billed in
 * parts (subscription_billings). One paged read for the whole list (row security keeps it
 * to the caller's company) — never a query per row. The Payment column reads "Paid till
 * <period end>" from it.
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { todayIST } from "@/lib/subscriptions/payment-due";
import type { CurrentBillingPeriod } from "@/lib/subscriptions/payment-status";

export function useCurrentBillingPeriods() {
  return useQuery({
    queryKey: ["subscription-billings", "current-period"],
    queryFn: async (): Promise<Map<string, CurrentBillingPeriod>> => {
      const supabase = createClient();
      const today = todayIST();
      const rows = await fetchAllRows<CurrentBillingPeriod>((from, to) =>
        supabase
          .from("subscription_billings")
          .select("subscription_id, period_start, period_end, bill_on, invoice_id")
          .lte("period_start", today)
          .gte("period_end", today)
          .order("subscription_id", { ascending: true })
          .order("period_start", { ascending: true })
          .range(from, to) as never,
      );
      /* One per subscription; if two overlap (a re-billed term) the later start wins. */
      const m = new Map<string, CurrentBillingPeriod>();
      for (const r of rows) m.set(r.subscription_id, r);
      return m;
    },
  });
}
