"use client";
/**
 * R-2519: a part payment request's (proforma's) pay-by date — subscription_billings.due_on (R-2230),
 * else its bill date — and the billing job's mail step (request_reminder_step: a request mailed
 * before R-2519 has no send-log row). Untyped read: these columns are newer than the generated types.
 */
import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

export function usePartDueOn(billingId: string | null | undefined) {
  return useQuery({
    queryKey: ["quote-part-due", billingId],
    enabled: !!billingId,
    queryFn: async (): Promise<{ dueOn: string | null; mailStep: string | null } | null> => {
      const db = createClient() as unknown as SupabaseClient;
      const { data, error } = await db.from("subscription_billings")
        .select("due_on, bill_on, request_reminder_step").eq("id", billingId!).maybeSingle();
      if (error) throw error;
      const row = data as { due_on?: string | null; bill_on?: string | null; request_reminder_step?: string | null } | null;
      return row ? { dueOn: row.due_on ?? row.bill_on ?? null, mailStep: row.request_reminder_step ?? null } : null;
    },
  });
}
