"use client";
/**
 * R-2519: a part payment request's (proforma's) pay-by date — subscription_billings.due_on (R-2230),
 * else its bill date. The quote page shows it and judges "Expired" from it. Untyped read: due_on is
 * newer than the generated types.
 */
import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

export function usePartDueOn(billingId: string | null | undefined) {
  return useQuery({
    queryKey: ["quote-part-due", billingId],
    enabled: !!billingId,
    queryFn: async (): Promise<string | null> => {
      const db = createClient() as unknown as SupabaseClient;
      const { data, error } = await db.from("subscription_billings").select("due_on, bill_on").eq("id", billingId!).maybeSingle();
      if (error) throw error;
      const row = data as { due_on?: string | null; bill_on?: string | null } | null;
      return row ? (row.due_on ?? row.bill_on ?? null) : null;
    },
  });
}
