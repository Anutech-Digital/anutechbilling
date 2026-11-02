"use client";

/**
 * R-2225: "Won't renew" and its Undo — set_subscription_non_renewing() (migration 20261101135056).
 * Owner / manager / accountant, like Cancel; the server checks the role and the company.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { invalidateReceivables } from "@/lib/queries/receivables-refresh";
import { toastError } from "@/lib/errors/toast-error";
import { formatDate } from "@/lib/utils";

export interface NonRenewingArgs {
  id: string;
  on: boolean;
  reason?: string;
  /** YYYY-MM-DD, the day the customer said it. */
  saidOn?: string;
}

interface NonRenewingResult {
  non_renewing: boolean;
  ends_on?: string | null;
  renewal_quote_id?: string | null;
  already?: boolean;
}

export function useSetNonRenewing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: NonRenewingArgs): Promise<NonRenewingResult> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("set_subscription_non_renewing", {
        p_subscription_id: a.id,
        p_on:              a.on,
        ...(a.on ? { p_reason: a.reason ?? "", p_said_on: a.saidOn } : {}),
      });
      if (error) throw new Error(error.message);
      return data as unknown as NonRenewingResult;
    },
    onSuccess: (r) => {
      invalidateReceivables(qc);   // ["subscriptions"] is among them — list, drawer and /renewals refresh
      if (r.non_renewing) {
        toast.success("Marked Won't renew", {
          description: `It runs till ${formatDate(r.ends_on ?? null)}, then ends. No renewal quote or reminder goes out.`
            + (r.renewal_quote_id ? ` Renewal quote ${r.renewal_quote_id} is still open — reject it if they will not pay it.` : ""),
        });
      } else if (!r.already) {
        toast.success("Will renew again", { description: "Back in Renewals; the renewal quote and reminders go out as usual." });
      }
    },
    onError: (err) => toastError(err, { fallback: "Could not change Won't renew." }),
  });
}
