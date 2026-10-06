/**
 * Subscriptions — TanStack Query hooks.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { guardErrorToast } from "@/lib/ui/guard-toast";
import { createClient } from "@/lib/supabase/client";
import type { Subscription } from "@/lib/supabase/database.types";
import { fetchAllRows } from "@/lib/ops/fetch-all";

export function useSubscriptions() {
  return useQuery({
    queryKey: ["subscriptions"],
    queryFn: async (): Promise<Subscription[]> => {
      const supabase = createClient();
      /* R-046: PostgREST answers at most 1000 rows (supabase/config.toml max_rows) and says
         NOTHING when it cut the answer short. At 1001 subscriptions this list silently lost the
         rest — no error, no warning, just a page that looks complete and is not. That is
         the worst shape a data bug takes (AGENTS.md §2).

         fetchAllRows pages until a short page comes back. The order ENDS ON id because an
         offset page over an order with ties can repeat or skip a row across a page
         boundary — see the helper header; renewal_date alone is not a total order. */
      return await fetchAllRows<Subscription>((from, to) =>
        supabase
          .from("subscriptions")
          .select("*")
          .order("renewal_date", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to));
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
    onError: (e) => toastError(e, { fallback: "Domain not saved." }),
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
        /** Postpaid credit clock (migration 20260910060000). Null clears it, which means
         *  "no agreed date" and shows no countdown — see the edit dialog. */
        payment_due_date?: string | null;
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
    onError: (err) => toastError(err),
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

/**
 * Rebuild the subscriptions a paid quote lost.
 *
 * ─── NOT OPTIMISTIC, AND NOT SILENT ─────────────────────────────────────────
 * This creates future revenue and a renewal obligation. The screen waits for the server,
 * and the toast NAMES what was created rather than saying "done" — an operator repairing
 * money needs to see the seats and the renewal date, because a wrong renewal date is the
 * difference between chasing in April and chasing in August.
 */
export function useRecreateSubscription() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (quoteId: string) => {
      const res = await fetch(`/api/quotes/${quoteId}/recreate-subscription`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not rebuild the subscription");
      return json as { ok: true; created: { id: string; plan: string; seats: number; mrr: number; renewal_date: string }[] };
    },
    onSuccess: ({ created }) => {
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      const first = created[0];
      toast.success(
        created.length === 1
          ? `Rebuilt: ${first.plan} · ${first.seats} seats · renews ${first.renewal_date}`
          : `Rebuilt ${created.length} subscriptions from this quote`,
        {
          description: created.length > 1
            ? created.map((c) => `${c.plan} — ${c.seats} seats, renews ${c.renewal_date}`).join(" · ")
            : "Check the renewal date is the one you expect — it is backdated to the quote's start, not today.",
        },
      );
    },
    onError: (e: Error) => guardErrorToast(e),
  });
}
