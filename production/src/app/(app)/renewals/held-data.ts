"use client";
/**
 * R-2761 — the listed renewals' OPEN 'held' undo moves (subscription_renewal_moves, R-2749), one batched,
 * chunked + paged read. RLS keeps it to this company (select policy of R-2749). A failed read (e.g. a database
 * without the R-2761 columns yet) gives no flags — the row never breaks over it. Keyed under ["payments"] so
 * recording / undoing a payment refreshes it with the other money reads.
 */
import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRowsIn } from "@/lib/ops/fetch-all";
import type { RenewalHeld } from "@/lib/renewals/stage";
import { openHoldsBySubscription, type HeldMoveRow } from "./held";

export function useRenewalHolds(subscriptionIds: readonly string[]) {
  const ids = [...new Set(subscriptionIds.filter(Boolean))].sort();
  return useQuery({
    queryKey: ["payments", "renewal-holds", ids],
    enabled: ids.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, RenewalHeld>> => {
      /* subscription_renewal_moves (R-2749) is not in the generated types yet — untyped read as last-docs-data.ts. */
      const loose = createClient() as unknown as SupabaseClient;
      try {
        const rows = await fetchAllRowsIn<HeldMoveRow, string>(ids, (run, from, to) => loose
          .from("subscription_renewal_moves")
          .select("id, subscription_id, from_date, to_date, hold_kind")
          .eq("direction", "held")
          .is("resolved_at", null)
          .in("subscription_id", run)
          .order("id", { ascending: true })
          .range(from, to));
        return openHoldsBySubscription(rows);
      } catch {
        return new Map();
      }
    },
  });
}
