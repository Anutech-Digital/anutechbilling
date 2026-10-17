/**
 * R-1517 — read one customer's follow-up history, and log a new follow-up.
 *
 * Writes go through POST /api/collections/followups (not a browser insert): that route is where
 * "only owner / manager / accountant may give a follow-up to someone else" is enforced, because
 * the DB (R-1515) does not stop it. Rules: lib/collections/followup-rules.ts.
 *
 * On success the /collections list (["collections"], incl. the customer page's own row) and this
 * customer's history refresh at once (§10).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import type { FollowupHistoryRow, FollowupRequest } from "@/lib/collections/followup-rules";

const HISTORY_COLS =
  "id, kind, note, promised_amount, promised_on, next_follow_up_on, assigned_to, created_by, created_at, invoice_id, quote_id, subscription_id";

export const followupsKey = (customerId: string | null | undefined) => ["payment-followups", customerId] as const;

/** Every follow-up of one customer, newest first (paged past 1000). RLS scopes it. */
export function useCustomerFollowups(customerId: string | null | undefined) {
  return useQuery({
    queryKey: followupsKey(customerId),
    enabled: !!customerId,
    queryFn: async (): Promise<FollowupHistoryRow[]> => {
      const supabase = createClient();
      return fetchAllRows<FollowupHistoryRow>((from, to) => supabase
        .from("payment_followups")
        .select(HISTORY_COLS)
        .eq("customer_id", customerId!)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to));
    },
    staleTime: 30_000,
  });
}

/** The customer's owner (customers.account_manager_id) — the default person for a follow-up. */
export function useCustomerOwner(customerId: string | null | undefined) {
  return useQuery({
    queryKey: ["payment-followups", customerId, "owner"],
    enabled: !!customerId,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await createClient()
        .from("customers")
        .select("account_manager_id")
        .eq("id", customerId!)
        .maybeSingle();
      if (error) throw error;
      return data?.account_manager_id ?? null;
    },
    staleTime: 5 * 60_000,
  });
}

export class FollowupSaveError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "FollowupSaveError";
  }
}

export async function postFollowup(body: FollowupRequest): Promise<{ id: string; assignedTo: string | null }> {
  let res: Response;
  try {
    res = await fetch("/api/collections/followups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new FollowupSaveError("Could not reach the server — check your internet and press Save again.", 0);
  }
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; id?: string; assignedTo?: string | null };
  if (!res.ok || !json.ok) {
    throw new FollowupSaveError(json.error || "The follow-up was not saved — press Save again.", res.status);
  }
  return { id: json.id!, assignedTo: json.assignedTo ?? null };
}

export function useAddFollowup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postFollowup,
    onSuccess: (_out, body) => {
      void qc.invalidateQueries({ queryKey: ["collections"] });
      void qc.invalidateQueries({ queryKey: followupsKey(body.customerId) });
      toast.success("Follow-up saved", { description: `Next follow-up on ${body.nextFollowUpOn.split("-").reverse().join("/")}.` });
    },
  });
}
