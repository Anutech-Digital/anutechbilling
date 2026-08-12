/**
 * Subscriptions — TanStack Query hooks.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { guardErrorToast } from "@/lib/ui/guard-toast";
import { createClient } from "@/lib/supabase/client";
import type { Subscription } from "@/lib/supabase/database.types";

export function useSubscriptions() {
  return useQuery({
    queryKey: ["subscriptions"],
    queryFn: async (): Promise<Subscription[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("subscriptions")
        .select("*")
        .order("renewal_date", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Inline-edit hook for setting the domain on an existing subscription.
 * Used by Subscriptions page when an older row was created before the
 * structured `domain` flow existed and lacks the value.
 *
 * Also bubbles the domain up to the customer record (when one is linked)
 * so future leads/quotes auto-populate it.
 */
export function useSetSubscriptionDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, domain }: { id: string; domain: string }) => {
      const clean = domain
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "")
        .trim();
      if (!clean) throw new Error("Domain required");

      const supabase = createClient();

      // Update subscription
      const { data: subRow, error: subErr } = await supabase
        .from("subscriptions")
        .update({ domain: clean })
        .eq("id", id)
        .select("id, customer_id, domain")
        .single();
      if (subErr) throw subErr;

      // Best-effort: keep customer.domain in sync (don't overwrite if customer
      // already has one — operator may have entered a different identity domain).
      if (subRow?.customer_id) {
        const { data: cust } = await supabase
          .from("customers")
          .select("domain")
          .eq("id", subRow.customer_id)
          .maybeSingle();
        if (cust && !cust.domain) {
          await supabase
            .from("customers")
            .update({ domain: clean })
            .eq("id", subRow.customer_id);
        }
      }
      return subRow;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success("Domain saved");
    },
    onError: (e) => toast.error((e as Error).message || "Domain save nahi hua"),
  });
}

/**
 * Correct a subscription's details (data-entry fix). Touches only the
 * subscription record's own fields — it does NOT re-bill or alter the linked
 * payment/quote/invoice (those are separate money artifacts). Use it to fix a
 * mis-typed plan / seats / price / dates / status on a manual or imported sub.
 */
export function useUpdateSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      patch: {
        plan?: string;
        vendor?: Subscription["vendor"];
        seats?: number;
        mrr?: number;
        start_date?: string | null;
        renewal_date?: string | null;
        status?: Subscription["status"];
      };
    }) => {
      const supabase = createClient();
      const { error } = await supabase.from("subscriptions").update(input.patch).eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success("Subscription corrected");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

/**
 * Delete a manual / imported subscription (correct a mistake). Guarded RPC:
 * blocks if it came from a paid quote (delete that payment instead) or a linked
 * PO has progressed past draft. Drops draft POs, then the subscription.
 */
export function useDeleteSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_subscription", { p_subscription_id: id });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["outstanding-receivables"] });
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success("Subscription deleted");
    },
    // Blocked (came from a paid quote)? Point to where the fix happens.
    onError: (err) => guardErrorToast(err, { label: "Open Payments", href: "/payments" }),
  });
}

/** Filter subscriptions for a specific customer */
export function useCustomerSubscriptions(customerId: string | undefined) {
  return useQuery({
    queryKey: ["subscriptions", "customer", customerId],
    enabled: !!customerId,
    queryFn: async (): Promise<Subscription[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("customer_id", customerId!)
        .order("start_date", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}
